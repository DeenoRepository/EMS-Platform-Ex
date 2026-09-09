import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaMigrator } from './migrator.js';
import { DatabasePool } from './db.js';
import { AuditRepository } from './audit.repository.js';
import { waitUntilBlocked } from './pg-test-barrier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isOptIn = process.env.EMS_TEST_PG_INTEGRATION === 'true';
const migrationUrl = process.env.EMS_TEST_PG_MIGRATION_URL;
const runtimeUrl = process.env.EMS_TEST_PG_RUNTIME_URL;
const isAcceptanceRun = process.env.EMS_TEST_PG_REQUIRED === 'true';

describe('PostgreSQL Real Integration Acceptance Tests', () => {
  if (!isOptIn || !migrationUrl || !runtimeUrl) {
    if (isAcceptanceRun) {
      throw new Error('PostgreSQL acceptance requires EMS_TEST_PG_INTEGRATION=true, EMS_TEST_PG_MIGRATION_URL and EMS_TEST_PG_RUNTIME_URL');
    }
    test('PostgreSQL стенд не настроен (явный opt-in EMS_TEST_PG_INTEGRATION=true)', { skip: 'Изолированный PostgreSQL стенд не настроен' }, () => {
      // Согласно плану (п. 26, 86): без разрешенного изолированного стенда не подключаться к произвольной БД.
      // Не заменять отсутствие стенда mock-проверкой и не выдавать silent skip за приемку.
      console.warn(
        '[EMS Acceptance Gate] PostgreSQL integration stand is not active. ' +
        'To run real PostgreSQL integration tests against an isolated ephemeral stand, ' +
        'set EMS_TEST_PG_INTEGRATION=true and provide EMS_TEST_PG_MIGRATION_URL / EMS_TEST_PG_RUNTIME_URL.',
      );
    });
    return;
  }

  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const up001 = fs.readFileSync(path.join(migrationsDir, '001_core_schema.sql'), 'utf8');
  const down001 = fs.readFileSync(path.join(migrationsDir, '001_core_schema.down.sql'), 'utf8');
  const up002 = fs.readFileSync(path.join(migrationsDir, '002_core_security_remediation.sql'), 'utf8');
  const down002 = fs.readFileSync(path.join(migrationsDir, '002_core_security_remediation.down.sql'), 'utf8');

  const loadMigrations = () => [
    { id: '001_core_schema', upSql: up001, downSql: down001 },
    { id: '002_core_security_remediation', upSql: up002, downSql: down002 },
  ] as const;

  async function cleanDatabase(): Promise<{ migrationPool: DatabasePool; runtimePool: DatabasePool; migrator: SchemaMigrator }> {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    const migrator = new SchemaMigrator(migrationPool);
    await migrator.teardownEphemeralSchema();
    await migrator.provisionClean(loadMigrations());
    return { migrationPool, runtimePool, migrator };
  }

  test('Реальный цикл миграций на изолированной PostgreSQL (clean install -> rollback -> re-apply)', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const migrator = new SchemaMigrator(migrationPool);

    try {
      // 1. Полная очистка одноразовой тестовой схемы
      await migrator.teardownEphemeralSchema();

      // 2. Применение 001 и 002
      await migrator.applyMigration({ id: '001_core_schema', upSql: up001, downSql: down001 });
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });

      // 3. Проверка метаданных в реальной БД
      const res = await migrationPool.query('SELECT version, checksum FROM ems_core.schema_migrations ORDER BY version ASC');
      assert.equal(res.rows.length, 2);
      assert.equal(res.rows[0]?.version, '001_core_schema');
      assert.equal(res.rows[1]?.version, '002_core_security_remediation');

      // 4. Откат 002
      await migrator.rollbackMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const resAfterRollback = await migrationPool.query('SELECT version FROM ems_core.schema_migrations');
      assert.equal(resAfterRollback.rows.length, 1);
      assert.equal(resAfterRollback.rows[0]?.version, '001_core_schema');

      // 5. Повторное применение 002
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const resReapply = await migrationPool.query('SELECT version FROM ems_core.schema_migrations');
      assert.equal(resReapply.rows.length, 2);
    } finally {
      await migrator.teardownEphemeralSchema();
      await migrationPool.close();
    }
  });

  test('upgrade сохраняет completed и не возвращает bootstrap_state в ready', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    const migrator = new SchemaMigrator(migrationPool);
    try {
      await migrator.teardownEphemeralSchema();
      await migrator.applyMigration({ id: '001_core_schema', upSql: up001, downSql: down001 });
      await runtimePool.query(`
        INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-upgrade', 'Upgrade', 'UPGRADE');
        INSERT INTO ems_core.roles (id, name, is_system) VALUES ('role.platform.admin', 'Admin', true);
        INSERT INTO ems_core.role_permissions (role_id, permission_id) VALUES ('role.platform.admin', 'platform.admin');
        INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status, department_id)
        VALUES ('emp-upgrade', 'corp.local', 'guid-upgrade', 'upgrade@corp.local', 'Upgrade', 'ACTIVE', 'dept-upgrade');
        INSERT INTO ems_core.employee_roles (employee_id, role_id) VALUES ('emp-upgrade', 'role.platform.admin');
      `);
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const state = await runtimePool.query<{ status: string }>('SELECT status FROM ems_core.bootstrap_state WHERE id = 1');
      assert.equal(state.rows[0]?.status, 'completed');
    } finally {
      await new SchemaMigrator(migrationPool).teardownEphemeralSchema().catch(() => undefined);
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('upgrade 001 -> 002 сохраняет legacy data и отзывает старые сессии', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    const migrator = new SchemaMigrator(migrationPool);
    try {
      await migrator.teardownEphemeralSchema();
      await migrator.applyMigration({ id: '001_core_schema', upSql: up001, downSql: down001 });
      await runtimePool.query(`
        INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-legacy', 'Legacy', 'LEGACY');
        INSERT INTO ems_core.roles (id, name, is_system) VALUES ('role.platform.admin', 'Admin', true);
        INSERT INTO ems_core.role_permissions (role_id, permission_id) VALUES ('role.platform.admin', 'platform.admin');
        INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status, department_id)
        VALUES ('emp-legacy', 'corp.local', 'guid-legacy', 'legacy@corp.local', 'Legacy', 'ACTIVE', 'dept-legacy');
        INSERT INTO ems_core.employee_roles (employee_id, role_id) VALUES ('emp-legacy', 'role.platform.admin');
        INSERT INTO ems_core.sessions (id, employee_id, expires_at, idle_expires_at)
        VALUES ('legacy-session', 'emp-legacy', NOW() + INTERVAL '1 hour', NOW() + INTERVAL '30 minutes');
      `);
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const state = await runtimePool.query<{ status: string }>('SELECT status FROM ems_core.bootstrap_state WHERE id = 1');
      assert.equal(state.rows[0]?.status, 'completed');
      const session = await runtimePool.query<{ revoked_at: string | null; revocation_reason: string | null }>(
        'SELECT revoked_at::text, revocation_reason FROM ems_core.sessions WHERE id = $1', ['legacy-session'],
      );
      assert.equal(session.rows[0]?.revocation_reason, 'UPGRADE_SECURITY_REVOCATION');
      const format = await runtimePool.query<{ format_version: number }>('SELECT format_version FROM ems_core.sessions WHERE id = $1', ['legacy-session']);
      assert.equal(format.rows[0]?.format_version, 1);
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const repeat = await runtimePool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM ems_core.schema_migrations WHERE version = '002_core_security_remediation'");
      assert.equal(repeat.rows[0]?.count, '1');
    } finally {
      await new SchemaMigrator(migrationPool).teardownEphemeralSchema();
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('upgrade без администратора устанавливает locked-legacy навсегда', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    const migrator = new SchemaMigrator(migrationPool);
    try {
      await migrator.teardownEphemeralSchema();
      await migrator.applyMigration({ id: '001_core_schema', upSql: up001, downSql: down001 });
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const before = await runtimePool.query<{ status: string }>('SELECT status FROM ems_core.bootstrap_state WHERE id = 1');
      assert.equal(before.rows[0]?.status, 'locked-legacy');
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const after = await runtimePool.query<{ status: string }>('SELECT status FROM ems_core.bootstrap_state WHERE id = 1');
      assert.equal(after.rows[0]?.status, 'locked-legacy');
    } finally {
      await migrator.teardownEphemeralSchema();
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('provisionClean отклоняет пустую существующую схему', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const migrator = new SchemaMigrator(migrationPool);
    try {
      await migrator.teardownEphemeralSchema();
      await migrationPool.query('CREATE SCHEMA ems_core');
      await assert.rejects(() => migrator.provisionClean(loadMigrations()), /absent ems_core schema/);
      const tables = await migrationPool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ems_core'",
      );
      assert.equal(tables.rows[0]?.count, '0');
    } finally {
      await migrator.teardownEphemeralSchema();
      await migrationPool.close();
    }
  });

  test('ошибка второй миграции откатывает clean provisioning атомарно', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const migrator = new SchemaMigrator(migrationPool);
    try {
      await migrator.teardownEphemeralSchema();
      await assert.rejects(() => migrator.provisionClean([
        { id: '001_core_schema', upSql: up001, downSql: down001 },
        { id: 'synthetic-invalid', upSql: 'CREATE TABLE ems_core.invalid (', downSql: 'DROP TABLE ems_core.invalid' },
      ]), /syntax error|параметр|end of input/i);
      const schema = await migrationPool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ems_core') AS exists",
      );
      assert.equal(schema.rows[0]?.exists, false);
      await migrator.provisionClean(loadMigrations());
    } finally {
      await migrator.teardownEphemeralSchema();
      await migrationPool.close();
    }
  });

  test('два конкурентных provisionClean: один успех, второй видит созданную схему', async () => {
    const pool1 = new DatabasePool({ connectionString: migrationUrl });
    const pool2 = new DatabasePool({ connectionString: migrationUrl });
    try {
      await new SchemaMigrator(pool1).teardownEphemeralSchema();
      const results = await Promise.allSettled([
        new SchemaMigrator(pool1).provisionClean(loadMigrations()),
        new SchemaMigrator(pool2).provisionClean(loadMigrations()),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.match(String(rejected?.reason?.message), /absent ems_core schema/);
    } finally {
      await new SchemaMigrator(pool1).teardownEphemeralSchema();
      await pool1.close();
      await pool2.close();
    }
  });

  test('AuditRepository применяет фильтры и cursor-пагинацию с детерминированным id tie-breaker', async () => {
    const { migrationPool, runtimePool } = await cleanDatabase();
    const audit = new AuditRepository();
    try {
      const base = '2026-01-01T00:00:00.000Z';
      const records = [
        ['audit-1', 'ACTION_A', 'subject-a', 0],
        ['audit-2', 'ACTION_B', 'subject-a', 0],
        ['audit-3', 'ACTION_A', 'subject-b', 1],
        ['audit-4', 'ACTION_C', 'subject-b', 2],
        ['audit-5', 'ACTION_A', 'subject-a', 3],
      ] as const;
      for (const [id, action, subject, offset] of records) {
        await audit.insert(runtimePool, {
          id,
          timestamp: new Date(Date.parse(base) + offset),
          subjectId: subject,
          action,
          objectType: 'test',
          objectId: id,
          result: 'SUCCESS',
        });
      }
      const byAction = await audit.query(runtimePool, { action: 'ACTION_A', limit: 20 });
      assert.deepEqual(byAction.items.map((item) => item.id), ['audit-5', 'audit-3', 'audit-1']);
      const bySubject = await audit.query(runtimePool, { subjectId: 'subject-b', limit: 20 });
      assert.deepEqual(bySubject.items.map((item) => item.id), ['audit-4', 'audit-3']);
      const period = await audit.query(runtimePool, {
        periodStart: '2026-01-01T00:00:00.001Z',
        periodEnd: '2026-01-01T00:00:00.002Z',
        limit: 20,
      });
      assert.deepEqual(period.items.map((item) => item.id), ['audit-4', 'audit-3']);
      const pages: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await audit.query(runtimePool, { limit: 2, cursor });
        pages.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(pages, ['audit-5', 'audit-4', 'audit-3', 'audit-2', 'audit-1']);
      assert.equal(new Set(pages).size, 5);
    } finally {
      await new SchemaMigrator(migrationPool).teardownEphemeralSchema();
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('AuditRepository не пропускает записи с микросекундами внутри одной миллисекунды', async () => {
    const { migrationPool, runtimePool } = await cleanDatabase();
    try {
      await runtimePool.query(`
        INSERT INTO ems_core.audit_log (id, timestamp, subject_id, action, object_type, object_id, result)
        VALUES
          ('micro-a', '2026-01-01 00:00:00.001001+00', 'micro', 'MICRO', 'test', 'a', 'SUCCESS'),
          ('micro-b', '2026-01-01 00:00:00.001002+00', 'micro', 'MICRO', 'test', 'b', 'SUCCESS'),
          ('micro-c', '2026-01-01 00:00:00.001003+00', 'micro', 'MICRO', 'test', 'c', 'SUCCESS'),
          ('micro-d', '2026-01-01 00:00:00.001004+00', 'micro', 'MICRO', 'test', 'd', 'SUCCESS');
      `);
      const audit = new AuditRepository();
      const pages: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await audit.query(runtimePool, { action: 'MICRO', limit: 2, cursor });
        pages.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(pages, ['micro-d', 'micro-c', 'micro-b', 'micro-a']);
      assert.equal(new Set(pages).size, 4);
    } finally {
      await new SchemaMigrator(migrationPool).teardownEphemeralSchema().catch(() => undefined);
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('waitUntilBlocked завершается контролируемой ошибкой по timeout', async () => {
    const runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    try {
      const startedAt = Date.now();
      await assert.rejects(
        () => waitUntilBlocked(runtimePool, 'SELECT 0::text AS count', 150),
        /Ожидание блокировки PostgreSQL истекло/,
      );
      assert.ok(Date.now() - startedAt >= 150);
      assert.ok(Date.now() - startedAt < 2000);
    } finally {
      await new SchemaMigrator(migrationPool).teardownEphemeralSchema().catch(() => undefined);
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('PostgreSQL lock_timeout и statement_timeout возвращают SQLSTATE и освобождают ресурсы', async () => {
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const runtimePool = new DatabasePool({ connectionString: runtimeUrl });
    const migrator = new SchemaMigrator(migrationPool);
    const blocker = await runtimePool.rawPool.connect();
    const waiter = await runtimePool.rawPool.connect();
    try {
      await migrator.teardownEphemeralSchema();
      await migrator.provisionClean(loadMigrations());
      await runtimePool.query(
        `INSERT INTO ems_core.employees
         (id, directory_id, object_guid, upn, display_name, status)
         VALUES ('timeout-employee', 'corp.local', 'timeout-guid', 'timeout@corp.local', 'Timeout', 'PENDING')`,
      );
      await blocker.query('BEGIN');
      await blocker.query("SELECT id FROM ems_core.employees WHERE id = 'timeout-employee' FOR UPDATE");

      await waiter.query('SET lock_timeout = 100');
      let lockError: { code?: string } | undefined;
      await waiter.query("UPDATE ems_core.employees SET display_name = 'Blocked' WHERE id = 'timeout-employee'").catch((error: { code?: string }) => {
        lockError = error;
      });
      assert.equal(lockError?.code, '55P03');
      await blocker.query('COMMIT');

      const released = await waiter.query<{ display_name: string }>(
        "UPDATE ems_core.employees SET display_name = 'Released' WHERE id = 'timeout-employee' RETURNING display_name",
      );
      assert.equal(released.rows[0]?.display_name, 'Released');

      await waiter.query('SET statement_timeout = 100');
      let statementError: { code?: string } | undefined;
      await waiter.query('SELECT pg_sleep(1)').catch((error: { code?: string }) => {
        statementError = error;
      });
      assert.equal(statementError?.code, '57014');
      const reusable = await waiter.query<{ value: number }>('SELECT 1 AS value');
      assert.equal(reusable.rows[0]?.value, 1);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      waiter.release();
      await migrator.teardownEphemeralSchema().catch(() => undefined);
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('Реальная конкурентность двух соединений PostgreSQL (two logins on same identity)', async () => {
    const pool1 = new DatabasePool({ connectionString: runtimeUrl });
    const pool2 = new DatabasePool({ connectionString: runtimeUrl });
    const migrationPool = new DatabasePool({ connectionString: migrationUrl });
    const migrator = new SchemaMigrator(migrationPool);

    try {
      await migrator.teardownEphemeralSchema();
      await migrator.provisionClean(loadMigrations());
      const client1 = await pool1.rawPool.connect();
      const client2 = await pool2.rawPool.connect();

      try {
        const directoryId = 'corp.local';
        const objectGuid = 'guid-concurrency-real-1';
        const upn = 'real-concurrent@corp.local';

        // Одновременный INSERT ... ON CONFLICT (directory_id, object_guid) DO NOTHING из двух клиентов
        const p1 = client1.query(
          `INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (directory_id, object_guid) DO NOTHING`,
          ['emp-real-1', directoryId, objectGuid, upn, 'Real User', 'PENDING'],
        );
        const p2 = client2.query(
          `INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (directory_id, object_guid) DO NOTHING`,
          ['emp-real-2', directoryId, objectGuid, upn, 'Real User', 'PENDING'],
        );

        await Promise.all([p1, p2]);

        // Проверяем, что в БД ровно одна запись
        const check = await client1.query(
          'SELECT id FROM ems_core.employees WHERE directory_id = $1 AND object_guid = $2',
          [directoryId, objectGuid],
        );
        assert.equal(check.rows.length, 1);
      } finally {
        client1.release();
        client2.release();
      }
    } finally {
      await migrator.teardownEphemeralSchema().catch(() => undefined);
      await pool1.close();
      await pool2.close();
      await migrationPool.close();
    }
  });
});
