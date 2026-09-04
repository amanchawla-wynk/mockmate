import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAtomicFileWriter } from './atomic-write';
import { nodeFileSystem, type FileSystem } from './file-system';

type FailurePoint = 'open' | 'write' | 'flush' | 'close' | 'rename';

let root: string;
let destination: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-atomic-'));
  destination = path.join(root, 'nested', 'record.json');
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function tempFiles(): Promise<string[]> {
  const directory = path.dirname(destination);
  try {
    return (await fs.promises.readdir(directory)).filter(name => name !== path.basename(destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function failingFileSystem(
  failure: FailurePoint,
  options: { cleanupAlsoFails?: boolean } = {},
): FileSystem {
  return {
    ...nodeFileSystem,
    async open(filePath, flags, mode) {
      if (failure === 'open') throw new Error('open failure');
      const handle = await nodeFileSystem.open(filePath, flags, mode);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'write' && failure === 'write') {
            return async () => { throw new Error('write failure'); };
          }
          if (property === 'sync' && failure === 'flush') {
            return async () => { throw new Error('flush failure'); };
          }
          if (property === 'close' && failure === 'close') {
            return async () => {
              await target.close();
              throw new Error('close failure');
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
    async rename(from, to) {
      if (failure === 'rename') throw new Error('rename failure');
      await nodeFileSystem.rename(from, to);
    },
    async unlink(filePath) {
      if (options.cleanupAlsoFails) throw new Error('cleanup failure');
      await nodeFileSystem.unlink(filePath);
    },
  };
}

describe('createAtomicFileWriter', () => {
  it('runs the JSON publication hook after sync and close but before rename', async () => {
    const events: string[] = [];
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'sync') return async () => { events.push('sync'); await target.sync(); };
            if (property === 'close') return async () => { events.push('close'); await target.close(); };
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as FileHandle;
      },
      async rename(from, to) {
        events.push('rename');
        await nodeFileSystem.rename(from, to);
      },
    };

    await createAtomicFileWriter(fileSystem).writeJson(
      destination,
      { value: 'new' },
      { beforePublish: async () => { events.push('beforePublish'); } },
    );

    expect(events).toEqual(['sync', 'close', 'beforePublish', 'rename']);
  });

  it('leaves the destination unchanged and removes the temp when publication hook rejects', async () => {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, 'old');

    await expect(createAtomicFileWriter(nodeFileSystem).writeJson(
      destination,
      { value: 'new' },
      { beforePublish: async () => { throw new Error('publication blocked'); } },
    )).rejects.toThrow('publication blocked');

    expect(await fs.promises.readFile(destination, 'utf8')).toBe('old');
    expect(await tempFiles()).toEqual([]);
  });

  it('writes JSON through a randomized sibling and atomically publishes it', async () => {
    let renamedFrom: string | undefined;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rename(from, to) {
        renamedFrom = from;
        await nodeFileSystem.rename(from, to);
      },
    };

    await createAtomicFileWriter(fileSystem).writeJson(destination, { value: 'new' });

    expect(JSON.parse(await fs.promises.readFile(destination, 'utf8'))).toEqual({ value: 'new' });
    expect(path.dirname(renamedFrom!)).toBe(path.dirname(destination));
    expect(renamedFrom).not.toBe(destination);
    expect(path.basename(renamedFrom!)).toContain(path.basename(destination));
    expect(await tempFiles()).toEqual([]);
  });

  it('streams exact bytes while returning their size and SHA-256 digest', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 2]);

    const result = await createAtomicFileWriter(nodeFileSystem)
      .writeStream(destination, Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]));

    expect(await fs.promises.readFile(destination)).toEqual(bytes);
    expect(result).toEqual({
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it.each<FailurePoint>(['open', 'write', 'flush', 'close', 'rename'])(
    'preserves the destination and removes sibling temps after %s failure',
    async failure => {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, 'old');

      await expect(createAtomicFileWriter(failingFileSystem(failure)).writeJson(destination, { next: true }))
        .rejects.toThrow(`${failure} failure`);

      expect(await fs.promises.readFile(destination, 'utf8')).toBe('old');
      expect(await tempFiles()).toEqual([]);
    },
  );

  it('preserves the primary write error when temp cleanup also reports failure', async () => {
    await expect(createAtomicFileWriter(failingFileSystem('write', { cleanupAlsoFails: true }))
      .writeJson(destination, { next: true }))
      .rejects.toThrow('write failure');

    expect(await tempFiles()).toHaveLength(1);
  });

  it('retries close in final cleanup before removing the temp and preserves the close error', async () => {
    let closeAttempts = 0;
    let underlyingClosed = false;
    let unlinkObservedClosedHandle = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'close') {
              return async () => {
                closeAttempts += 1;
                if (closeAttempts === 1) throw new Error('close failure');
                await target.close();
                underlyingClosed = true;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as FileHandle;
      },
      async unlink(filePath) {
        unlinkObservedClosedHandle = underlyingClosed;
        await nodeFileSystem.unlink(filePath);
      },
    };

    await expect(createAtomicFileWriter(fileSystem).writeJson(destination, { next: true }))
      .rejects.toThrow('close failure');

    expect(closeAttempts).toBe(2);
    expect(unlinkObservedClosedHandle).toBe(true);
    expect(await tempFiles()).toEqual([]);
  });

  it('removes its candidate and preserves a hard-link failure', async () => {
    const failure = new Error('link failure');
    const unlink = vi.fn(nodeFileSystem.unlink);
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link() {
        throw failure;
      },
      unlink,
    };

    await expect(createAtomicFileWriter(fileSystem).writeJsonIfAbsent(destination, { next: true }))
      .rejects.toBe(failure);

    expect(await tempFiles()).toEqual([]);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('removes its candidate when hard-link publication finds an existing destination', async () => {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, 'old');
    const unlink = vi.fn(nodeFileSystem.unlink);
    const fileSystem: FileSystem = { ...nodeFileSystem, unlink };

    await expect(createAtomicFileWriter(fileSystem).writeJsonIfAbsent(destination, { next: true }))
      .resolves.toBe(false);

    expect(await fs.promises.readFile(destination, 'utf8')).toBe('old');
    expect(await tempFiles()).toEqual([]);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful hard-link publication when candidate cleanup fails', async () => {
    const unlink = vi.fn(async () => {
      throw new Error('unlink failure');
    });
    const fileSystem: FileSystem = { ...nodeFileSystem, unlink };

    await expect(createAtomicFileWriter(fileSystem).writeJsonIfAbsent(destination, { next: true }))
      .resolves.toBe(true);

    await expect(fs.promises.readFile(destination, 'utf8')).resolves.toBe('{"next":true}');
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});
