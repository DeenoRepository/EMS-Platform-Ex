import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabasePool, type Queryable } from '../persistence/db.js';
import { SchemaMigrator, type Migration } from '../persistence/migrator.js';

const MIGRATION_FILES = [
  { id: '001_core_schema', file: '001_core_schema.sql', downFile: '001_core_schema.down.sql' },
  {
    id: '002_core_security_remediation',
    file: '002_core_security_remediation.sql',
    downFile: '002_core_security_remediation.down.sql',
  },
] as const;

export const MIGRATION_URL_ENV = 'EMS_MIGRATION_URL';

export async function loadMigrations(
  migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations'),
): Promise<Migration[]> {
  return Promise.all(
    MIGRATION_FILES.map(async ({ id, file, downFile }) => ({
      id,
      upSql: await fs.readFile(path.join(migrationsDir, file), 'utf8'),
      downSql: await fs.readFile(path.join(migrationsDir, downFile), 'utf8'),
    })),
  );
}

export async function runMigrationCommand(
  command: string,
  migrator: SchemaMigrator,
  migrations: readonly Migration[],
  output: (message: string) => void = console.log,
  statusPool?: Queryable,
): Promise<void> {
  switch (command) {
    case 'provision-clean':
      await migrator.provisionClean(migrations);
      return;
    case 'upgrade':
      for (const migration of migrations) await migrator.applyMigration(migration);
      return;
    case 'status': {
      if (!statusPool) throw new Error('Status command requires a queryable migration pool');
      const migrationsResult = await statusPool.query(
        'SELECT version, checksum, applied_at FROM ems_core.schema_migrations ORDER BY version ASC',
      );
      const bootstrapResult = await statusPool.query(
        'SELECT status FROM ems_core.bootstrap_state WHERE id = 1',
      );
      output(JSON.stringify({ migrations: migrationsResult.rows, bootstrap: bootstrapResult.rows[0] ?? null }));
      return;
    }
    default:
      throw new Error(`Unknown migration command '${command}'. Use provision-clean, upgrade, or status`);
  }
}

export async function main(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = args[0];
  if (!command || args.length !== 1) {
    throw new Error('Usage: ems-migrate <provision-clean|upgrade|status>');
  }

  const connectionString = env[MIGRATION_URL_ENV];
  if (!connectionString) {
    throw new Error(`Required environment variable ${MIGRATION_URL_ENV} is not set`);
  }

  const pool = new DatabasePool({ connectionString });
  try {
    const migrator = new SchemaMigrator(pool);
    await runMigrationCommand(command, migrator, await loadMigrations(), console.log, pool);
  } finally {
    await pool.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Migration command failed');
    process.exitCode = 1;
  });
}
