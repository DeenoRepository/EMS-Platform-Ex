import process from 'node:process';

const required = ['EMS_TEST_PG_MIGRATION_URL', 'EMS_TEST_PG_RUNTIME_URL'];
const missing = required.filter((name) => !process.env[name] || process.env[name].trim() === '');
if (process.env.EMS_TEST_PG_INTEGRATION !== 'true' || missing.length > 0) {
  console.error(
    `PostgreSQL acceptance requires EMS_TEST_PG_INTEGRATION=true and explicit ${required.join(' and ')}.`,
  );
  process.exit(1);
}
