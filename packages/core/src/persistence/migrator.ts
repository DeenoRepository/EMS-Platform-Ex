import type { DatabasePool, Queryable } from './db.js';
import crypto from 'node:crypto';

export interface Migration {
  readonly id: string;
  readonly upSql: string;
  readonly downSql: string;
}

export const PINNED_HISTORICAL_CHECKSUMS: Readonly<Record<string, string>> = Object.freeze({
  '001_core_schema': '6a676e1ea2f19d50ffcdbaf9202521941a071586dfdeafa7f8ef3e29345d7269',
});

export class SchemaMigrator {
  constructor(private readonly pool: DatabasePool) {}

  async ensureMigrationTable(q?: Queryable): Promise<void> {
    const runner = q ?? this.pool;
    await runner.query(`
      CREATE SCHEMA IF NOT EXISTS ems_core;
      CREATE TABLE IF NOT EXISTS ems_core.schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        checksum VARCHAR(128),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE ems_core.schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(128);
    `);
  }

  async applyMigration(
    migration: Migration,
    options?: { cleanProvision?: boolean },
  ): Promise<void> {
    await this.pool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ems_core.migration_lock'))");
      await this.ensureMigrationTable(client);

      await this.applyMigrationInternal(client, migration);

      if (options?.cleanProvision) {
        await client.query(`
          INSERT INTO ems_core.bootstrap_state (id, status)
          VALUES (1, 'ready')
          ON CONFLICT (id) DO UPDATE SET status = 'ready', updated_at = NOW()
        `);
      }
    });
  }

  async provisionClean(migrations: readonly Migration[]): Promise<void> {
    await this.pool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ems_core.migration_lock'))");
      await this.ensureMigrationTable(client);

      for (const migration of migrations) {
        await this.applyMigrationInternal(client, migration);
      }

      await client.query(`
        INSERT INTO ems_core.bootstrap_state (id, status)
        VALUES (1, 'ready')
        ON CONFLICT (id) DO UPDATE SET status = 'ready', updated_at = NOW()
      `);
    });
  }

  async rollbackMigration(migration: Migration): Promise<void> {
    await this.pool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ems_core.migration_lock'))");
      await this.ensureMigrationTable(client);

      const check = await client.query<{ version: string; checksum: string | null }>(
        'SELECT version, checksum FROM ems_core.schema_migrations WHERE version = $1',
        [migration.id],
      );
      if (check.rows.length === 0) {
        throw new Error(`Migration '${migration.id}' is not applied`);
      }

      const latestRes = await client.query<{ version: string }>(
        'SELECT version FROM ems_core.schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1',
      );
      if (latestRes.rows[0]?.version !== migration.id) {
        throw new Error(
          `Cannot rollback migration '${migration.id}' because later migration '${latestRes.rows[0]?.version}' is still applied`,
        );
      }

      const currentChecksum = this.checksum(migration.upSql);
      const appliedChecksum = check.rows[0]?.checksum;
      if (appliedChecksum !== null && appliedChecksum !== currentChecksum) {
        throw new Error(
          `Checksum mismatch before rollback for '${migration.id}'. Applied: ${appliedChecksum}, current: ${currentChecksum}`,
        );
      }

      // Удаляем запись метаданных до выполнения downSql; транзакция восстановит её при сбое
      await client.query('DELETE FROM ems_core.schema_migrations WHERE version = $1', [migration.id]);

      await client.query(migration.downSql);
    });
  }

  async teardownEphemeralSchema(): Promise<void> {
    await this.pool.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ems_core.migration_lock'))");
      await client.query('DROP SCHEMA IF EXISTS ems_core CASCADE;');
    });
  }

  private async applyMigrationInternal(client: Queryable, migration: Migration): Promise<void> {
    const currentChecksum = this.checksum(migration.upSql);

    const check = await client.query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM ems_core.schema_migrations WHERE version = $1',
      [migration.id],
    );

    if (check.rows.length > 0) {
      const applied = check.rows[0]!;
      if (applied.checksum === null) {
        // Разрешаем backfill только из проверенных закрепленных артефактов
        const pinned = PINNED_HISTORICAL_CHECKSUMS[migration.id];
        if (pinned && pinned === currentChecksum) {
          await client.query(
            'UPDATE ems_core.schema_migrations SET checksum = $1 WHERE version = $2',
            [currentChecksum, migration.id],
          );
        } else {
          throw new Error(
            `Unknown or unverified historical migration artifact for '${migration.id}'; operator intervention required`,
          );
        }
      } else if (applied.checksum !== currentChecksum) {
        throw new Error(
          `Checksum migration mismatch for '${migration.id}'. Applied: ${applied.checksum}, incoming: ${currentChecksum}`,
        );
      }
      return;
    }

    await client.query(migration.upSql);
    await client.query(
      'INSERT INTO ems_core.schema_migrations (version, checksum) VALUES ($1, $2)',
      [migration.id, currentChecksum],
    );
  }

  checksum(sql: string): string {
    return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  }
}
