import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeTestPath,
  createTestStorageDirectory,
  getOriginalHome,
  getTestStorageRoot,
} from './test-storage';
import { getStorageConfig } from '../services/storage';

describe('test storage safety', () => {
  it('places storage below the worker-specific temporary root', () => {
    const root = getTestStorageRoot();
    const fakeHome = path.join(root, 'home');
    const dataDir = path.join(fakeHome, '.mockmate');

    expect(path.relative(os.tmpdir(), root)).not.toMatch(/^\.\.(?:\/|\\|$)/);
    expect(process.env.HOME).toBe(fakeHome);
    expect(process.env.USERPROFILE).toBe(fakeHome);
    expect(process.env.MOCKMATE_DATA_DIR).toBe(dataDir);
    expect(getStorageConfig().certsDir).toBe(
      path.join(os.homedir(), '.mockmate', 'certs'),
    );
  });

  it('rejects cleanup outside the test root', () => {
    expect(() => assertSafeTestPath(getOriginalHome())).toThrow(
      /Refusing to modify a path outside MockMate test storage/,
    );
  });

  it('creates isolated storage directories inside the worker-specific root', async () => {
    const first = await createTestStorageDirectory('traffic-cache-');
    const second = await createTestStorageDirectory('traffic-cache-');

    expect(first).not.toBe(second);
    expect(path.relative(getTestStorageRoot(), first)).not.toMatch(/^\.\.(?:\/|\\|$)/);
    expect(path.basename(first)).toMatch(/^traffic-cache-/);
    expect(() => assertSafeTestPath(first)).not.toThrow();
  });
});
