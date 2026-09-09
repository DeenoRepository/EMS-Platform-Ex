import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { main, runMigrationCommand } from './migrate.js';
import { SchemaMigrator, type Migration } from '../persistence/migrator.js';

class FakePool {
  public schemaExists = false;
  public bootstrapStatus: string | null = null;
  public migrationVersions: string[] = [];
  public queries: string[] = [];

  async query(text: string): Promise<{ rows: any[] }> {
    this.queries.push(text);
    if (text.includes('SELECT EXISTS')) return { rows: [{ exists: this.schemaExists }] };
    if (text.includes('SELECT version, checksum')) {
      return { rows: this.migrationVersions.map((version) => ({ version, checksum: 'checksum' })) };
    }
    if (text.includes('SELECT status FROM ems_core.bootstrap_state')) {
      return { rows: this.bootstrapStatus ? [{ status: this.bootstrapStatus }] : [] };
    }
    if (text.includes('INSERT INTO ems_core.schema_migrations')) {
      return { rows: [] };
    }
    if (text.includes('INSERT INTO ems_core.bootstrap_state')) {
      this.bootstrapStatus = 'ready';
      return { rows: [] };
    }
    return { rows: [] };
  }

  async withTransaction<T>(operation: (client: this) => Promise<T>): Promise<T> {
    return operation(this);
  }
}

const migrations: Migration[] = [
  { id: '001_core_schema', upSql: 'CREATE TABLE first;', downSql: 'DROP TABLE first;' },
  { id: '002_core_security_remediation', upSql: 'CREATE TABLE second;', downSql: 'DROP TABLE second;' },
];

describe('Migration CLI', () => {
  test('provision-clean отклоняется при существующей схеме', async () => {
    const pool = new FakePool();
    pool.schemaExists = true;
    await assert.rejects(
      () => runMigrationCommand('provision-clean', new SchemaMigrator(pool as any), migrations),
      /absent ems_core schema/,
    );
  });

  test('upgrade применяет миграции и не изменяет bootstrap_state', async () => {
    const pool = new FakePool();
    pool.bootstrapStatus = 'locked-legacy';
    await runMigrationCommand('upgrade', new SchemaMigrator(pool as any), migrations);
    assert.equal(pool.bootstrapStatus, 'locked-legacy');
    assert.equal(pool.queries.filter((query) => query.includes('INSERT INTO ems_core.bootstrap_state')).length, 0);
  });

  test('main отклоняется без явной строки подключения', async () => {
    await assert.rejects(
      () => main(['status'], { EMS_MIGRATION_URL: '' }),
      /EMS_MIGRATION_URL is not set/,
    );
  });
});
