import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as model from './model';
import * as schemas from './schemas';
import { parsePersistedRecord } from './validation';
import { ProjectSchema } from './schemas';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('contains no migration subsystem or pending-cutover domain export', () => {
  expect(existsSync(path.join(srcRoot, 'migration'))).toBe(false);
  expect(model).not.toHaveProperty('PendingMigrationCutover');
  expect(schemas).not.toHaveProperty('PendingMigrationCutoverSchema');
});

it('gives fresh-install recovery for an unsupported schema version', () => {
  const result = parsePersistedRecord(ProjectSchema, {
    schemaVersion: 2,
    id: 'prj_old',
    name: 'Unsupported',
    appStateMode: 'enabled',
    revision: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
  }, 'projects/prj_old/project.json');

  expect(result).toEqual({
    ok: false,
    findings: [expect.objectContaining({
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      recovery: 'Reset the configured MockMate data directory and restart the fresh schema-v4 application.',
    })],
  });
  expect(JSON.stringify(result)).not.toMatch(/migrat|backup|rollback/i);
});

it('keeps production domain sources free of the migration-only symbol', () => {
  const sources = ['model.ts', 'schemas.ts', 'validation.ts']
    .map(file => readFileSync(path.join(srcRoot, 'domain', file), 'utf8'))
    .join('\n');
  expect(sources).not.toContain('PendingMigrationCutover');
});
