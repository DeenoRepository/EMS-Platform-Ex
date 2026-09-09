import { spawnSync } from 'node:child_process';
import process from 'node:process';

const test = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  'dist/persistence/pg-integration.test.js',
  'dist/facades/facades-pg-integration.test.js',
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EMS_TEST_PG_REQUIRED: 'true',
  },
});

process.exit(test.status ?? 1);
