import * as fs from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { getStorageConfig, isStablePathSegment, readConfig } from './storage';

beforeEach(() => {
  fs.rmSync(getStorageConfig().configFile, { force: true });
});

describe('server-only storage configuration', () => {
  it('keeps only base, certificate, and server-config paths', () => {
    const config = getStorageConfig();
    expect(config.baseDir).toBe(path.resolve(process.env.MOCKMATE_DATA_DIR!));
    expect(config.certsDir).toBe(path.join(config.baseDir, 'certs'));
    expect(config.configFile).toBe(path.join(config.baseDir, 'config.json'));
    expect(config).not.toHaveProperty('projectsDir');
  });

  it('creates default server ports without repository ownership fields', () => {
    const config = readConfig();
    expect(config).toEqual({ server: { httpPort: 3456, httpsPort: 3457, proxyPort: 8888 } });
    expect(JSON.parse(fs.readFileSync(getStorageConfig().configFile, 'utf8'))).toEqual(config);
  });

  it('reads existing server-port configuration without overwriting it', () => {
    const storage = getStorageConfig();
    fs.mkdirSync(storage.baseDir, { recursive: true });
    fs.writeFileSync(storage.configFile, JSON.stringify({ server: { httpPort: 9999 } }));
    expect(readConfig()).toEqual({ server: { httpPort: 9999 } });
  });
});

describe('isStablePathSegment', () => {
  it('accepts stable IDs and rejects traversal, absolute, and nested paths', () => {
    expect(isStablePathSegment('prj_1')).toBe(true);
    expect(isStablePathSegment('project-name')).toBe(true);
    for (const value of ['', '.', '..', '../escape', '/absolute', 'nested/project', 'nested\\project', 'nul\0id']) {
      expect(isStablePathSegment(value)).toBe(false);
    }
  });
});
