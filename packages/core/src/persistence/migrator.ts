import type { DatabasePool } from './db.js';

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
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async applyMigration(migration: Migration): Promise<void> {
    await this.ensureMigrationTable();

    await this.pool.withTransaction(async (client) => {
      const check = await client.query(
        'SELECT version FROM ems_core.schema_migrations WHERE version = $1',
        [migration.id],
      );
      if (check.rows.length > 0) {
        return; // Уже применена
      }

      await client.query(migration.upSql);
      await client.query(
        'INSERT INTO ems_core.schema_migrations (version) VALUES ($1)',
        [migration.id],
      );
    });
  }

  async rollbackMigration(migration: Migration): Promise<void> {
    await this.ensureMigrationTable();

    await this.pool.withTransaction(async (client) => {
      await client.query(migration.downSql);
      await client.query(
        'DELETE FROM ems_core.schema_migrations WHERE version = $1',
        [migration.id],
      );
    });
  }
}
