import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLEANUP_MANIFEST_FILE,
  extendCleanupManifest,
  finalizeCleanup,
  readCleanupManifest,
  readOwnerCloseReport,
  validateOwnerCloseReport,
  writeCleanupManifest,
  writeOwnerCloseReport,
  type CleanupOwnerCloseReport,
  type CleanupManifest,
} from './cleanup-report';

const roots: string[] = [];

async function parent(): Promise<string> {
  const value = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-integration-cleanup-'));
  roots.push(value);
  return value;
}

const manifest: CleanupManifest = {
  listeners: ['admin', 'proxy'],
  socketOwners: ['proxy-clients'],
  roots: [
    { owner: 'runtime', relativePath: 'runtime', afterOwnerClose: 'contained-until-parent-removal' },
    { owner: 'traffic-cache', relativePath: 'cache', afterOwnerClose: 'absent-or-empty' },
    { owner: 'body-staging', relativePath: 'staging', afterOwnerClose: 'absent-or-empty' },
  ],
};

describe('cleanup report artifacts', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
  });

  it('atomically writes, reads, and extends a strict cleanup manifest', async () => {
    const root = await parent();
    await writeCleanupManifest(root, manifest);
    expect(await readCleanupManifest(root)).toEqual(manifest);

    const extended = await extendCleanupManifest(root, {
      listeners: ['upstream-http'],
      socketOwners: [],
      roots: [{
        owner: 'upstream', relativePath: 'upstreams/http',
        afterOwnerClose: 'contained-until-parent-removal',
      }],
    });

    expect(extended.listeners).toEqual(['admin', 'proxy', 'upstream-http']);
    expect(extended.roots).toHaveLength(4);
    expect(await readCleanupManifest(root)).toEqual(extended);
    expect(await fs.promises.readdir(root)).toEqual([CLEANUP_MANIFEST_FILE]);
  });

  it('rejects unknown keys, duplicates, and escaped root identities', async () => {
    const root = await parent();
    await fs.promises.writeFile(path.join(root, CLEANUP_MANIFEST_FILE), JSON.stringify({
      ...manifest,
      unexpected: true,
    }));
    await expect(readCleanupManifest(root)).rejects.toThrow();

    await writeCleanupManifest(root, manifest);
    await expect(extendCleanupManifest(root, {
      listeners: ['admin'], socketOwners: [], roots: [],
    })).rejects.toThrow(/Duplicate cleanup listener/);
    await expect(writeCleanupManifest(root, {
      listeners: [], socketOwners: [], roots: [{
        owner: 'runtime', relativePath: '../outside',
        afterOwnerClose: 'contained-until-parent-removal',
      }],
    })).rejects.toThrow(/contained relative path/);
    expect(await readCleanupManifest(root)).toEqual(manifest);
  });

  it('writes and validates exact owner-close evidence against the manifest and disk', async () => {
    const root = await parent();
    await writeCleanupManifest(root, manifest);
    await fs.promises.mkdir(path.join(root, 'runtime'));
    await fs.promises.writeFile(path.join(root, 'runtime', 'workspace.json'), '{}');
    await fs.promises.mkdir(path.join(root, 'cache'));
    const report: CleanupOwnerCloseReport = {
      manifest,
      closedListeners: ['proxy', 'admin'],
      closedSocketOwners: ['proxy-clients'],
      rootsAfterOwnerClose: [
        { owner: 'traffic-cache', relativePath: 'cache', state: 'empty' },
        { owner: 'body-staging', relativePath: 'staging', state: 'absent' },
        { owner: 'runtime', relativePath: 'runtime', state: 'contained' },
      ],
    };

    await writeOwnerCloseReport(root, report);

    expect(await readOwnerCloseReport(root)).toEqual(report);
    await expect(validateOwnerCloseReport(root, report)).resolves.toBeUndefined();
  });

  it('rejects omitted, additional, duplicate, escaped, and policy-incompatible evidence', async () => {
    const root = await parent();
    await writeCleanupManifest(root, manifest);
    await fs.promises.mkdir(path.join(root, 'runtime'));
    await fs.promises.writeFile(path.join(root, 'runtime', 'workspace.json'), '{}');
    await fs.promises.mkdir(path.join(root, 'cache'));
    const valid: CleanupOwnerCloseReport = {
      manifest,
      closedListeners: ['admin', 'proxy'],
      closedSocketOwners: ['proxy-clients'],
      rootsAfterOwnerClose: [
        { owner: 'runtime', relativePath: 'runtime', state: 'contained' },
        { owner: 'traffic-cache', relativePath: 'cache', state: 'empty' },
        { owner: 'body-staging', relativePath: 'staging', state: 'absent' },
      ],
    };

    await expect(validateOwnerCloseReport(root, {
      ...valid, closedListeners: ['admin'],
    })).rejects.toThrow(/listener settlement mismatch/);
    await expect(validateOwnerCloseReport(root, {
      ...valid, closedSocketOwners: ['proxy-clients', 'additional'],
    })).rejects.toThrow(/socket-owner settlement mismatch/);
    await expect(validateOwnerCloseReport(root, {
      ...valid, rootsAfterOwnerClose: [...valid.rootsAfterOwnerClose, valid.rootsAfterOwnerClose[0]],
    })).rejects.toThrow(/Duplicate reported root/);
    await expect(validateOwnerCloseReport(root, {
      ...valid,
      rootsAfterOwnerClose: valid.rootsAfterOwnerClose.map(value => value.owner === 'traffic-cache'
        ? { ...value, state: 'contained' as const }
        : value),
    })).rejects.toThrow(/ephemeral policy/);

    await fs.promises.rm(path.join(root, 'runtime'), { recursive: true });
    await fs.promises.symlink(os.tmpdir(), path.join(root, 'runtime'));
    await expect(validateOwnerCloseReport(root, valid)).rejects.toThrow(/resolves outside parent/);
  });

  it('validates owner settlement before removing only the checked parent', async () => {
    const root = await parent();
    await writeCleanupManifest(root, manifest);
    await fs.promises.mkdir(path.join(root, 'runtime'));
    await fs.promises.writeFile(path.join(root, 'runtime', 'workspace.json'), '{}');
    const report: CleanupOwnerCloseReport = {
      manifest,
      closedListeners: ['admin', 'proxy'],
      closedSocketOwners: ['proxy-clients'],
      rootsAfterOwnerClose: [
        { owner: 'runtime', relativePath: 'runtime', state: 'contained' },
        { owner: 'traffic-cache', relativePath: 'cache', state: 'absent' },
        { owner: 'body-staging', relativePath: 'staging', state: 'absent' },
      ],
    };
    await writeOwnerCloseReport(root, report);

    const completed = await finalizeCleanup(root, report);

    expect(completed).toEqual({
      ...report,
      parentRemoved: true,
      rootsAfterParentRemoval: [
        { owner: 'runtime', relativePath: 'runtime', state: 'absent' },
        { owner: 'traffic-cache', relativePath: 'cache', state: 'absent' },
        { owner: 'body-staging', relativePath: 'staging', state: 'absent' },
      ],
    });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('refuses to finalize an unowned parent', async () => {
    const unsafe = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ordinary-cleanup-'));
    roots.push(unsafe);
    await expect(finalizeCleanup(unsafe, {
      manifest: { listeners: [], socketOwners: [], roots: [] },
      closedListeners: [], closedSocketOwners: [], rootsAfterOwnerClose: [],
    })).rejects.toThrow(/unsafe cleanup parent/);
    expect(fs.existsSync(unsafe)).toBe(true);
  });
});
