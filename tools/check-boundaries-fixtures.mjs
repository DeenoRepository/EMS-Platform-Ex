import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const fixturesRoot = path.join(root, 'tools', 'fixtures', 'boundaries');
const fixtures = fs.readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let failed = false;
for (const fixture of fixtures) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools', 'check-boundaries.mjs'),
    '--fixture',
    path.join('tools', 'fixtures', 'boundaries', fixture),
  ], { cwd: root, encoding: 'utf8' });

  if (result.status === 0) {
    console.error(`Boundary fixture unexpectedly passed: ${fixture}`);
    failed = true;
    continue;
  }
  if (result.status === null) {
    console.error(`Boundary fixture did not exit normally: ${fixture}`);
    failed = true;
    continue;
  }
  console.log(`Boundary fixture rejected as expected: ${fixture}`);
}

if (fixtures.length === 0) {
  console.error('No boundary fixtures found');
  process.exitCode = 1;
} else if (failed) {
  process.exitCode = 1;
}
