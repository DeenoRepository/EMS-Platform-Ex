import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const fixtureIndex = process.argv.indexOf('--fixture');
const configuredRoot = fixtureIndex === -1 ? undefined : process.argv[fixtureIndex + 1];
if (fixtureIndex !== -1 && (!configuredRoot || configuredRoot.startsWith('--'))) {
  console.error('Usage: node tools/check-boundaries.mjs [--fixture <directory>]');
  process.exit(2);
}

const root = configuredRoot ? path.resolve(process.cwd(), configuredRoot) : process.cwd();
const errors = [];
const workspaceConfigPath = path.join(root, 'pnpm-workspace.yaml');
const workspaceConfig = fs.existsSync(workspaceConfigPath) ? fs.readFileSync(workspaceConfigPath, 'utf8') : '';
const workspaceGlobs = [...workspaceConfig.matchAll(/^\s*-\s*['"]([^'"]+)['"]\s*$/gm)].map((match) => match[1]);
if (workspaceGlobs.length === 0) workspaceGlobs.push('packages/*', 'apps/*');
const workspaceDirectories = workspaceGlobs.flatMap((glob) => {
  const prefix = glob.endsWith('/*') ? glob.slice(0, -2) : glob;
  const directory = path.resolve(root, prefix);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
});
const packageRoots = new Map();
for (const packageRoot of workspaceDirectories) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) continue;
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (typeof packageJson.name !== 'string') {
    errors.push(`${packageJsonPath}: workspace package must declare a name`);
    continue;
  }
  packageRoots.set(packageJson.name, path.relative(root, packageRoot));
}
const discoveredRoots = ['packages', 'apps'].flatMap((directory) => {
  const absolute = path.resolve(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(absolute, entry.name));
});
for (const packageRoot of discoveredRoots) {
  if (!workspaceDirectories.includes(packageRoot)) {
    errors.push(`${packageRoot}: workspace package is not covered by pnpm-workspace.yaml`);
  }
}
const packageNames = new Map([...packageRoots].map(([name, relative]) => [path.resolve(root, relative), name]));
const graph = new Map();

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function ownerOf(file) {
  let current = path.dirname(file);
  while (current.startsWith(root)) {
    if (packageNames.has(current)) return packageNames.get(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

const allowed = new Map([
  ['@ems/contracts', new Set()],
  ['@ems/core', new Set(['@ems/contracts'])],
  ['@ems/shell', new Set(['@ems/contracts', '@ems/shared-controls'])],
  ['@ems/shared-controls', new Set()],
  ['@ems/demo-module', new Set(['@ems/contracts', '@ems/shared-controls'])],
  ['@ems/diagnostic-extension', new Set(['@ems/contracts', '@ems/shared-controls'])],
  ['@ems/web', new Set([...packageRoots.keys()].filter((name) => name !== '@ems/web'))],
]);

// Явно разрешенные публичные subpath exports для межпакетных импортов.
// Все остальные импорты пакета должны использовать корневой спецификатор.
const allowedSubpathExports = new Map([
  ['@ems/core', new Set(['@ems/core/registry', '@ems/core/directory', '@ems/core/cli'])],
]);

// Внешние зависимости, которые открывают соединение со службой каталога или БД,
// либо обращаются к секретам. Они не должны попадать в граф пакетов, код которых
// может быть отправлен в браузер (S2-NFR-002).
const serverOnlyDependencies = new Set(['ldapts', 'pg']);

// Пакеты, чей код целиком или частично исполняется в браузере.
const clientReachablePackages = new Set([
  '@ems/contracts',
  '@ems/shell',
  '@ems/shared-controls',
  '@ems/demo-module',
  '@ems/diagnostic-extension',
  '@ems/web',
]);

for (const [packageName, relativeRoot] of packageRoots) {
  const packageRoot = path.resolve(root, relativeRoot);
  if (!fs.existsSync(packageRoot)) continue;
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ]);
  const sourceFiles = filesUnder(path.join(packageRoot, 'src'));
  graph.set(packageName, new Set());
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imports = [];
    parsed.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    });
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue;
      let dependency = specifier;
      if (specifier.startsWith('.')) {
        const resolved = ts.resolveModuleName(specifier, file, {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          target: ts.ScriptTarget.ES2022,
        }, ts.sys).resolvedModule?.resolvedFileName;
        const targetOwner = resolved ? ownerOf(path.resolve(resolved)) : packageName;
        if (targetOwner && targetOwner !== packageName) {
          errors.push(`${file}: relative import crosses package boundary into ${targetOwner}`);
        }
        continue;
      }
      const packageSpecifier = specifier.startsWith('@ems/') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      dependency = packageSpecifier;
      if (packageRoots.has(dependency)) {
        graph.get(packageName).add(dependency);
        if (specifier !== dependency && !allowedSubpathExports.get(dependency)?.has(specifier)) {
          errors.push(`${file}: private deep import ${specifier}`);
        }
        if (!allowed.get(packageName)?.has(dependency)) errors.push(`${file}: forbidden dependency ${dependency}`);
        if (!declared.has(dependency)) errors.push(`${file}: undeclared dependency ${dependency}`);
      }
      if (!packageRoots.has(dependency) && !declared.has(dependency) && dependency !== packageName) {
        errors.push(`${file}: undeclared dependency ${dependency}`);
      }
      if (serverOnlyDependencies.has(dependency) && clientReachablePackages.has(packageName)) {
        errors.push(`${file}: server-only dependency ${dependency} is not allowed in client-reachable package ${packageName}`);
      }
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(name, chain) {
  if (visiting.has(name)) {
    errors.push(`dependency cycle: ${[...chain, name].join(' -> ')}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...chain, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of graph.keys()) visit(name, []);

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Boundary check passed');
}
