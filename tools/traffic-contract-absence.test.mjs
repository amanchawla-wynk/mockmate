import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const files = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean).filter(path => existsSync(new URL(path, root)));

const sourceExtension = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const isPackageSource = path => /^packages\/(server|dashboard)\/src\//.test(path)
  && sourceExtension.has(extname(path));
const isFixture = path => /^packages\/(server|dashboard)\//.test(path)
  && /(?:^|\/)(?:test|tests|test-support|fixtures?|integration)(?:\/|\.|-)/.test(path)
  && (sourceExtension.has(extname(path)) || extname(path) === '.json');
const isRuntime = path => isPackageSource(path)
  && !/(?:^|\/)(?:test-support|fixtures?|integration|performance)(?:\/|$)/.test(path)
  && !/\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/.test(path);

const runtimeFiles = files.filter(isRuntime);
const fixtureFiles = files.filter(isFixture);
const importFiles = runtimeFiles.filter(path => (
  path.startsWith('packages/server/src/import/')
  || path.startsWith('packages/dashboard/src/components/import/')
  || path.endsWith('/useImportWizard.ts')
));
const activeDocs = [
  'README.md',
  'packages/dashboard/README.md',
  'docs/Development Plan.md',
  'docs/Mockmate V2 Passive Income AI.md',
  'docs/traffic-capture.md',
  'packages/server/src/routes/setup-page.ts',
].filter(path => existsSync(new URL(path, root)));

const read = path => readFileSync(new URL(path, root), 'utf8');

function matchingLines(path, pattern) {
  return read(path).split(/\r?\n/).flatMap((line, index) => {
    pattern.lastIndex = 0;
    return pattern.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [];
  });
}

function assertAbsent(paths, pattern, label) {
  const violations = paths.flatMap(path => matchingLines(path, pattern));
  assert.deepEqual(violations, [], `${label}\n${violations.join('\n')}`);
}

function section(source, startPattern) {
  const start = source.search(startPattern);
  assert.notEqual(start, -1, `Missing section ${startPattern}`);
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`Unclosed section ${startPattern}`);
}

test('schema-v4 direct cutover has no active old contracts', () => {
  const schemaTestPath = 'packages/server/src/domain/schemas.test.ts';
  const schemaTest = read(schemaTestPath);
  const schemaThree = /["']?schemaVersion["']?\s*[:=]\s*3\b/g;
  assert.equal([...schemaTest.matchAll(schemaThree)].length, 1);
  const negativeTest = section(schemaTest, /it\('rejects schema-v3 persisted documents'/);
  assert.match(negativeTest, /ProjectSchema\.safeParse\(\{[\s\S]*schemaVersion:\s*3[\s\S]*\.success\)\.toBe\(false\)/);

  const fixtureInputs = fixtureFiles.map(path => ({
    path,
    source: path === schemaTestPath ? read(path).replace(schemaThree, 'schemaVersion: 4') : read(path),
  }));
  const fixtureViolations = fixtureInputs.flatMap(({ path, source }) => source.split(/\r?\n/)
    .flatMap((line, index) => (
      /["']?schemaVersion["']?\s*[:=]\s*3\b|(?:SCHEMA_VERSION|SchemaVersion)\s*=\s*3\b|z\.literal\(\s*3\s*\)/.test(line)
        ? [`${path}:${index + 1}: ${line.trim()}`]
        : []
    )));
  assert.deepEqual(fixtureViolations, [], `schema v3 values and fixtures\n${fixtureViolations.join('\n')}`);

  assertAbsent(runtimeFiles,
    /(?:schema(?:Version)?[^\n]{0,40}(?:migration|compat(?:ibility)?|legacy)|(?:migration|compat(?:ibility)?|legacy)[^\n]{0,40}schema(?:Version)?)/i,
    'schema-v3 reader/migration/compatibility entry points');
  assertAbsent(runtimeFiles, /passthroughEnabled/, 'Project passthrough setting');
  assertAbsent(runtimeFiles, /\/logs(?:\b|\/)|LogsView|useLogs/, 'Logs contract');
  assertAbsent(runtimeFiles,
    /createCapturedMock|CapturedMockInput|create-mock|createMockFromTraffic/,
    'preview-based captured mock path');
  assertAbsent(importFiles,
    /IMPORT_SCHEME_PORT_DISCARDED|discoveredHosts|matcher\.host/,
    'hostname-only Import identity');
  assertAbsent(activeDocs, /\/api\/admin\/logs|project(?:'s)? Base URL|Project base URL/i,
    'stale active setup or product documentation');

  const badNames = files.filter(path => /(?:^|[-_.])(?:schema-v3|schema3|v3-fixture)(?:[-_.]|$)/i.test(path));
  assert.deepEqual(badNames, [], `active schema-v3 file names\n${badNames.join('\n')}`);
});

test('removed traffic contract paths do not exist', () => {
  const forbiddenPaths = [
    'packages/dashboard/src/components/PassthroughSettings.tsx',
    'packages/dashboard/src/components/LogsView.tsx',
    'packages/dashboard/src/hooks/useLogs.ts',
    'packages/dashboard/src/hooks/useLogs.test.tsx',
    'packages/server/src/services/logger.ts',
    'packages/server/src/services/logger.test.ts',
    'packages/server/src/services/logger.test-d.ts',
    'packages/server/src/services/proxy.ts',
    'packages/server/src/utils/curl-parser.ts',
    'packages/server/src/utils/postman-parser.ts',
  ].filter(path => existsSync(new URL(path, root)));
  assert.deepEqual(forbiddenPaths, [], `forbidden active paths\n${forbiddenPaths.join('\n')}`);
});

test('schema-v4 owners remain explicit', () => {
  const model = read('packages/server/src/domain/model.ts');
  const schemas = read('packages/server/src/domain/schemas.ts');
  const dashboardTypes = read('packages/dashboard/src/api/types.ts');
  const projectForm = read('packages/dashboard/src/components/ProjectModal.tsx');
  const compiler = read('packages/server/src/repository/compile-project.ts');

  assert.doesNotMatch(section(model, /export interface Project\b/), /\bbaseUrl\b/);
  assert.doesNotMatch(section(dashboardTypes, /export interface Project\b/), /\bbaseUrl\b/);
  assert.doesNotMatch(section(dashboardTypes, /export type ProjectPatch\b/), /\bbaseUrl\b/);
  assert.doesNotMatch(projectForm, /\bbaseUrl\b/);
  assert.doesNotMatch(compiler, /matcher\.host/);
  assert.doesNotMatch(section(schemas, /const EndpointMatcherSchema\b/), /\bhost\b/);
  assert.match(section(model, /export interface EndpointDetail\b/), /\bbaseUrl:\s*string/);
  assert.match(section(schemas, /export const EndpointSchema\b/), /\bbaseUrl:/);
  assert.match(section(model, /export interface ProjectRuntimeSettings\b/), /debugProvenanceHeaders:\s*boolean/);
  assert.match(section(schemas, /export const ProjectRuntimeSettingsSchema\b/), /debugProvenanceHeaders:/);

  const admin = read('packages/server/src/routes/admin.ts');
  assert.equal((admin.match(/['"]\/projects\/:projectId\/traffic['"]/g) ?? []).length, 1);
  const traffic = read('packages/server/src/routes/admin/traffic.ts');
  for (const route of [
    /router\.get\('\/'/,
    /router\.get\('\/:trafficId'/,
    /router\.delete\('\/'/,
    /router\.get\('\/:trafficId\/bodies\/:side'/,
    /router\.post\('\/:trafficId\/mock'/,
  ]) assert.match(traffic, route);
});
