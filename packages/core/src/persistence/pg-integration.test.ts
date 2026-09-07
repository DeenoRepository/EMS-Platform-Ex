import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaMigrator } from './migrator.js';
import { DatabasePool } from './db.js';

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
    test('PostgreSQL стенд не настроен (явный opt-in EMS_TEST_PG_INTEGRATION=true)', () => {
      // Согласно плану (п. 26, 86): без разрешенного изолированного стенда не подключаться к произвольной БД.
      // Не заменять отсутствие стенда mock-проверкой и не выдавать silent skip за приемку.
      console.warn(
        '[EMS Acceptance Gate] PostgreSQL integration stand is not active. ' +
        'To run real PostgreSQL integration tests against an isolated ephemeral stand, ' +
        'set EMS_TEST_PG_INTEGRATION=true and provide EMS_TEST_PG_URL / EMS_TEST_PG_MIGRATION_URL.',
      );
      assert.ok(true, 'PostgreSQL integration check status recorded');
    });
    return;
  }

  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const up001 = fs.readFileSync(path.join(migrationsDir, '001_core_schema.sql'), 'utf8');
  const down001 = fs.readFileSync(path.join(migrationsDir, '001_core_schema.down.sql'), 'utf8');
  const up002 = fs.readFileSync(path.join(migrationsDir, '002_core_security_remediation.sql'), 'utf8');
  const down002 = fs.readFileSync(path.join(migrationsDir, '002_core_security_remediation.down.sql'), 'utf8');

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
