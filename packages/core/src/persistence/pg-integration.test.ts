import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaMigrator } from './migrator.js';
import { DatabasePool } from './db.js';
import { AuditRepository } from './audit.repository.js';

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
      await migrationPool.close();
    }
  });

  test('upgrade сохраняет completed и не возвращает bootstrap_state в ready', async () => {
    const { migrationPool, runtimePool, migrator } = await cleanDatabase();
    try {
      await runtimePool.query(`
        INSERT INTO ems_core.departments (id, name, code) VALUES ('dept-upgrade', 'Upgrade', 'UPGRADE');
        INSERT INTO ems_core.roles (id, name, is_system) VALUES ('role.platform.admin', 'Admin', true);
        INSERT INTO ems_core.role_permissions (role_id, permission_id) VALUES ('role.platform.admin', 'platform.admin');
        INSERT INTO ems_core.employees (id, directory_id, object_guid, upn, display_name, status, department_id)
        VALUES ('emp-upgrade', 'corp.local', 'guid-upgrade', 'upgrade@corp.local', 'Upgrade', 'ACTIVE', 'dept-upgrade');
        INSERT INTO ems_core.employee_roles (employee_id, role_id) VALUES ('emp-upgrade', 'role.platform.admin');
        UPDATE ems_core.bootstrap_state SET status = 'completed' WHERE id = 1;
      `);
      await migrator.applyMigration({ id: '001_core_schema', upSql: up001, downSql: down001 });
      await migrator.applyMigration({ id: '002_core_security_remediation', upSql: up002, downSql: down002 });
      const state = await runtimePool.query<{ status: string }>('SELECT status FROM ems_core.bootstrap_state WHERE id = 1');
      assert.equal(state.rows[0]?.status, 'completed');
    } finally {
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
      await runtimePool.close();
      await migrationPool.close();
    }
  });

  test('Реальная конкурентность двух соединений PostgreSQL (two logins on same identity)', async () => {
    const pool1 = new DatabasePool({ connectionString: runtimeUrl });
    const pool2 = new DatabasePool({ connectionString: runtimeUrl });

    try {
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
      await pool1.close();
      await pool2.close();
    }
  });
});
