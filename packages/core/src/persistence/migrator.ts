import type { DatabasePool } from './db.js';
import crypto from 'node:crypto';

export interface Migration {
  readonly id: string;
  readonly upSql: string;
  readonly downSql: string;
}

export class SchemaMigrator {
  constructor(private readonly pool: DatabasePool) {}

  async ensureMigrationTable(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS ems_core;
      CREATE TABLE IF NOT EXISTS ems_core.schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        checksum VARCHAR(128),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async applyMigration(migration: Migration): Promise<void> {
    await this.ensureMigrationTable();

    await this.pool.withTransaction(async (client) => {
      const check = await client.query(
       'SELECT version, checksum FROM ems_core.schema_migrations WHERE version = $1',
        [migration.id],
      );
       if (check.rows.length > 0) {
         const checksum = this.checksum(migration.upSql);
         if (check.rows[0]?.checksum !== null && check.rows[0]?.checksum !== checksum) {
           throw new Error(`Checksum migration mismatch for '${migration.id}'`);
         }
         return;
      }

      await client.query(migration.upSql);
      await client.query(
         'INSERT INTO ems_core.schema_migrations (version, checksum) VALUES ($1, $2)',
         [migration.id, this.checksum(migration.upSql)],
      );
    });
  }

  async rollbackMigration(migration: Migration): Promise<void> {
    await this.ensureMigrationTable();

    await this.pool.withTransaction(async (client) => {
      const check = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM ems_core.schema_migrations WHERE version = $1',
        [migration.id],
      );
      if (check.rows.length === 0) {
        throw new Error(`Migration '${migration.id}' is not applied`);
      }
      await client.query(migration.downSql);
      if (!migration.downSql.includes('DROP SCHEMA IF EXISTS ems_core')) {
        await client.query('DELETE FROM ems_core.schema_migrations WHERE version = $1', [migration.id]);
      }
    });
  }

  private checksum(sql: string): string {
    return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
  }
}
