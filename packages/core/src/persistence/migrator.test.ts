import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaMigrator, type Migration } from './migrator.js';

class MockMigratorPool {
  public migrationsTable: { version: string; checksum: string | null; applied_at: Date }[] = [];
  public executedSqls: string[] = [];
  public bootstrapState: { id: number; status: string } | null = null;
  public failNextSql = false;

  get rawPool(): any {
    return this;
  }

  async query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const cleanSql = text.trim().replace(/\s+/g, ' ');
    this.executedSqls.push(cleanSql);

    if (this.failNextSql) {
      this.failNextSql = false;
      throw new Error('Simulated SQL failure');
    }

    if (cleanSql.includes('SELECT pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 };
    }
    if (cleanSql.includes('CREATE TABLE IF NOT EXISTS ems_core.schema_migrations') || cleanSql.includes('CREATE SCHEMA IF NOT EXISTS') || cleanSql.includes('ALTER TABLE ems_core.schema_migrations')) {
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('SELECT version, checksum FROM ems_core.schema_migrations WHERE version = $1')) {
      const row = this.migrationsTable.find((m) => m.version === params[0]);
      return { rows: row ? [{ version: row.version, checksum: row.checksum }] : [], rowCount: row ? 1 : 0 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.schema_migrations')) {
      this.migrationsTable.push({ version: params[0], checksum: params[1], applied_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (cleanSql.includes('UPDATE ems_core.schema_migrations SET checksum = $1 WHERE version = $2')) {
      const row = this.migrationsTable.find((m) => m.version === params[1]);
      if (row) row.checksum = params[0];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (cleanSql.includes('SELECT version FROM ems_core.schema_migrations ORDER BY applied_at DESC')) {
      const last = this.migrationsTable[this.migrationsTable.length - 1];
      return { rows: last ? [{ version: last.version }] : [], rowCount: last ? 1 : 0 };
    }
    if (cleanSql.includes('DELETE FROM ems_core.schema_migrations WHERE version = $1')) {
      const idx = this.migrationsTable.findIndex((m) => m.version === params[0]);
      if (idx >= 0) {
        this.migrationsTable.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (cleanSql.includes('INSERT INTO ems_core.bootstrap_state')) {
      this.bootstrapState = { id: 1, status: 'ready' };
      return { rows: [], rowCount: 1 };
    }

    // Default DDL execution
    return { rows: [], rowCount: 0 };
  }

  async withTransaction<T>(operation: (client: any) => Promise<T>): Promise<T> {
    const snapshotMigrations = this.migrationsTable.map((m) => ({ ...m }));
    try {
      return await operation(this);
    } catch (err) {
      // Rollback restores state
      this.migrationsTable = snapshotMigrations;
      throw err;
    }
  }
}

describe('SchemaMigrator unit tests', () => {
  const sample001: Migration = {
    id: '001_core_schema',
    upSql: '-- Sample 001\nCREATE TABLE test1 (id INT);',
    downSql: 'DROP TABLE test1;',
  };

  const sample002: Migration = {
    id: '002_core_security_remediation',
    upSql: '-- Sample 002\nCREATE TABLE test2 (id INT);',
    downSql: 'DROP TABLE test2;',
  };

  test('чистая установка применяет миграции и сохраняет checksum', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    await migrator.applyMigration(sample001);
    assert.equal(mock.migrationsTable.length, 1);
    assert.equal(mock.migrationsTable[0]?.version, '001_core_schema');
    assert.equal(mock.migrationsTable[0]?.checksum, migrator.checksum(sample001.upSql));
  });

  test('повторное применение той же миграции с тем же checksum успешно пропускается', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    await migrator.applyMigration(sample001);
    await migrator.applyMigration(sample001);
    assert.equal(mock.migrationsTable.length, 1);
  });

  test('отказ при несовпадении checksum с уже примененной миграцией', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    await migrator.applyMigration(sample001);

    const modified001: Migration = {
      ...sample001,
      upSql: '-- Modified 001 SQL',
    };

    await assert.rejects(
      async () => {
        await migrator.applyMigration(modified001);
      },
      /Checksum migration mismatch/,
    );
  });

  test('backfill исторического nullable checksum разрешен только для подтвержденного артефакта', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    // Имитируем старую запись миграции без checksum (null)
    mock.migrationsTable.push({
      version: '001_core_schema',
      checksum: null,
      applied_at: new Date(),
    });

    // Неизвестный артефакт для 001 отклоняется
    const unknown001: Migration = {
      id: '001_core_schema',
      upSql: '-- Unknown unpinned 001 SQL',
      downSql: 'DROP TABLE test1;',
    };

    await assert.rejects(
      async () => {
        await migrator.applyMigration(unknown001);
      },
      /Unknown or unverified historical migration artifact/,
    );
  });

  test('rollback запрещен, если после миграции уже применены более поздние версии', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    await migrator.applyMigration(sample001);
    await migrator.applyMigration(sample002);

    // Пытаемся откатить 001, когда 002 еще применена
    await assert.rejects(
      async () => {
        await migrator.rollbackMigration(sample001);
      },
      /Cannot rollback migration '001_core_schema' because later migration '002_core_security_remediation' is still applied/,
    );
  });

  test('при сбое выполнения downSql транзакция восстанавливает запись метаданных миграции', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    await migrator.applyMigration(sample001);
    assert.equal(mock.migrationsTable.length, 1);

    // Имитируем сбой выполнения SQL отката
    mock.failNextSql = true;

    await assert.rejects(
      async () => {
        await migrator.rollbackMigration(sample001);
      },
      /Simulated SQL failure/,
    );

    // Метаданные не удалены благодаря откату транзакции
    assert.equal(mock.migrationsTable.length, 1);
    assert.equal(mock.migrationsTable[0]?.version, '001_core_schema');
  });

  test('provisionClean переводит bootstrap_state в состояние ready', async () => {
    const mock = new MockMigratorPool() as any;
    const migrator = new SchemaMigrator(mock);

    await migrator.provisionClean([sample001, sample002]);
    assert.equal(mock.migrationsTable.length, 2);
    assert.deepEqual(mock.bootstrapState, { id: 1, status: 'ready' });
  });
});
