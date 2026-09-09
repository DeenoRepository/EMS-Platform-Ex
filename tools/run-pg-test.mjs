import { spawnSync } from 'node:child_process';
import process from 'node:process';

const test = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  'dist/persistence/pg-integration.test.js',
  'dist/facades/facades-pg-integration.test.js',
], {
  stdio: 'inherit',
  timeout: 120000,
  env: {
    ...process.env,
    EMS_TEST_PG_REQUIRED: 'true',
    PGOPTIONS: `${process.env.PGOPTIONS ?? ''} -c statement_timeout=15000 -c lock_timeout=5000`.trim(),
  },
});

if (test.error) {
  console.error(`PostgreSQL acceptance runner failed: ${test.error.message}`);
}
process.exit(test.status ?? 1);
