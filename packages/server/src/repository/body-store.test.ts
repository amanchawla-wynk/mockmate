import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BodyAsset } from '../domain/model';
import { HttpError } from '../services/api-errors';
import { createAtomicFileWriter, type AtomicFileWriter } from './atomic-write';
import {
  createBodyStore,
  MAX_EDITABLE_BODY_BYTES,
  type BodyStore,
  type PutBodyMetadata,
} from './body-store';
import { nodeFileSystem, type FileSystem } from './file-system';

const projectId = 'prj_1';
const editablePolicy = { maxBytes: MAX_EDITABLE_BODY_BYTES };
const execFileAsync = promisify(execFile);

let root: string;
let store: BodyStore;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-bodies-'));
  store = createBodyStore({
    rootDirectory: root,
    atomicWriter: createAtomicFileWriter(nodeFileSystem),
    fileSystem: nodeFileSystem,
  });
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function paths(assetId: string, selectedProjectId = projectId) {
  const directory = path.join(
    root,
    'projects',
    selectedProjectId,
    'bodies',
    'sha256',
    assetId.slice(0, 2),
  );
  return {
    content: path.join(directory, assetId),
    metadata: path.join(directory, `${assetId}.json`),
    directory,
  };
}

function projectBodyRoot(selectedProjectId = projectId): string {
  return path.join(root, 'projects', selectedProjectId, 'bodies', 'sha256');
}

async function importDirectories(): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(projectBodyRoot(), { withFileTypes: true });
    return entries
      .filter(entry => entry.name.startsWith('.import-'))
      .map(entry => path.join(projectBodyRoot(), entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function consume(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function put(
  bytes: Buffer | string,
  metadata: PutBodyMetadata = { mediaType: 'application/octet-stream' },
  policy = editablePolicy,
): Promise<BodyAsset> {
  return store.put(projectId, Readable.from([bytes]), metadata, policy);
}

async function writeRawAsset(asset: BodyAsset, bytes?: Buffer): Promise<void> {
  const assetPaths = paths(asset.id);
  await fs.promises.mkdir(path.dirname(assetPaths.content), { recursive: true });
  if (bytes !== undefined) await fs.promises.writeFile(assetPaths.content, bytes);
  await fs.promises.writeFile(assetPaths.metadata, JSON.stringify(asset));
}

async function allFiles(directory = root): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? allFiles(absolute) : [absolute];
  }));
  return files.flat();
}

function validAsset(bytes: Buffer, overrides: Partial<BodyAsset> = {}): BodyAsset {
  return {
    schemaVersion: 4,
    id: digest(bytes),
    mediaType: 'application/octet-stream',
    size: bytes.length,
    createdAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

function barrierAtomicWriter(writer: AtomicFileWriter): AtomicFileWriter {
  const bothReady = deferred();
  const release = deferred();
  let waiting = 0;

  return new Proxy(writer, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'writeJson' && property !== 'writeJsonIfAbsent') return value;
      return async (...args: unknown[]) => {
        waiting += 1;
        if (waiting === 2) bothReady.resolve();
        await bothReady.promise;
        release.resolve();
        await release.promise;
        return (value as (...parameters: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function blockedAtomicWriter(writer: AtomicFileWriter): {
  writer: AtomicFileWriter;
  started: Promise<void>;
  release(): void;
  writeCalls(): number;
} {
  const started = deferred();
  const release = deferred();
  let writeCalls = 0;
  return {
    writer: {
      ...writer,
      async writeStream(...args) {
        writeCalls += 1;
        started.resolve();
        await release.promise;
        return writer.writeStream(...args);
      },
    },
    started: started.promise,
    release: release.resolve,
    writeCalls: () => writeCalls,
  };
}

function replacePathAfterValidationFileSystem(
  contentPath: string,
  outsidePath: string,
): FileSystem {
  let armed = true;

  function replaceAfter(source: NodeJS.ReadableStream): fs.ReadStream {
    return Readable.from((async function* () {
      for await (const chunk of source as AsyncIterable<Buffer>) yield chunk;
      await fs.promises.unlink(contentPath);
      await fs.promises.symlink(outsidePath, contentPath);
    })()) as fs.ReadStream;
  }

  function maybeReplace(source: fs.ReadStream): fs.ReadStream {
    if (!armed) return source;
    armed = false;
    return replaceAfter(source);
  }

  return {
    ...nodeFileSystem,
    async open(filePath, flags, mode) {
      const handle = await nodeFileSystem.open(filePath, flags, mode);
      if (filePath !== contentPath) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'createReadStream') {
            return (options?: Parameters<FileHandle['createReadStream']>[0]) => (
              maybeReplace(target.createReadStream(options))
            );
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
    createReadStream(filePath, options) {
      const source = nodeFileSystem.createReadStream(filePath, options);
      return filePath === contentPath ? maybeReplace(source) : source;
    },
  };
}

function trackingContentHandleFileSystem(
  contentPath: string,
  options: { failDelivery?: boolean } = {},
): { fileSystem: FileSystem; closeCalls(): number } {
  let closes = 0;
  let streams = 0;
  return {
    fileSystem: {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        if (filePath !== contentPath) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'close') {
              return async () => {
                closes += 1;
                await target.close();
              };
            }
            if (property === 'createReadStream') {
              return (streamOptions?: Parameters<FileHandle['createReadStream']>[0]) => {
                streams += 1;
                if (options.failDelivery && streams === 2) {
                  return new Readable({
                    read() { this.destroy(new Error('delivery failure')); },
                  }) as fs.ReadStream;
                }
                return target.createReadStream(streamOptions);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as FileHandle;
      },
    },
    closeCalls: () => closes,
  };
}

function incrementalJsonFileSystem(): {
  fileSystem: FileSystem;
  readCalls(): number;
  readFileCalls(): number;
} {
  let reads = 0;
  let readFiles = 0;
  return {
    fileSystem: {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        const handle = await nodeFileSystem.open(filePath, flags, mode);
        if (!path.basename(filePath).startsWith('.incoming-') || typeof flags !== 'number') {
          return handle;
        }
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'readFile') {
              return async () => {
                readFiles += 1;
                throw new Error('JSON validation must not call readFile');
              };
            }
            if (property === 'read') {
              return async (...args: Parameters<FileHandle['read']>) => {
                reads += 1;
                return target.read(...args);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as FileHandle;
      },
    },
    readCalls: () => reads,
    readFileCalls: () => readFiles,
  };
}

function replaceAncestorAfterCheckFileSystem(
  digestDirectory: string,
  outsideDirectory: string,
): FileSystem {
  let replaced = false;
  return {
    ...nodeFileSystem,
    async lstat(filePath) {
      const stats = await nodeFileSystem.lstat(filePath);
      if (!replaced && filePath === digestDirectory) {
        replaced = true;
        await nodeFileSystem.rename(digestDirectory, `${digestDirectory}.original`);
        await fs.promises.symlink(outsideDirectory, digestDirectory);
      }
      return stats;
    },
  };
}

function failInitialPutSnapshotFileSystem(failure?: HttpError): FileSystem {
  const projectsDirectory = path.join(root, 'projects');
  let projectChecks = 0;
  return {
    ...nodeFileSystem,
    async lstat(filePath) {
      if (filePath !== projectsDirectory || ++projectChecks !== 2) {
        return nodeFileSystem.lstat(filePath);
      }
      if (failure) throw failure;
      const stats = await nodeFileSystem.lstat(filePath);
      await fs.promises.rm(projectsDirectory, { recursive: true, force: true });
      return stats;
    },
  };
}

function failingExistingContentHandleFileSystem(contentPath: string): FileSystem {
  return {
    ...nodeFileSystem,
    async open(filePath, flags, mode) {
      const handle = await nodeFileSystem.open(filePath, flags, mode);
      if (filePath !== contentPath) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'createReadStream') {
            return () => new Readable({
              read() { this.destroy(new Error('hash failure')); },
            }) as fs.ReadStream;
          }
          if (property === 'close') {
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
  };
}

function isCanonicalContentPath(filePath: string): boolean {
  return /^[a-f0-9]{64}$/.test(path.basename(filePath)) && !filePath.includes(`${path.sep}.import-`);
}

function isCanonicalMetadataPath(filePath: string): boolean {
  return /^[a-f0-9]{64}\.json$/.test(path.basename(filePath))
    && !filePath.includes(`${path.sep}.import-`);
}

describe('BodyStore.put', () => {
  it('stores exact bytes and strict metadata at the content-addressed paths', async () => {
    const bytes = Buffer.from('{"exact":true}');

    const asset = await put(bytes, {
      mediaType: 'Application/JSON; Charset="UTF-8"',
      encoding: ' GZip, identity, BR ',
    });

    expect(asset).toMatchObject({
      schemaVersion: 4,
      id: digest(bytes),
      mediaType: 'application/json; charset=UTF-8',
      encoding: 'gzip, br',
      size: bytes.length,
    });
    expect(asset.createdAt).toEqual(expect.any(String));
    expect(await fs.promises.readFile(paths(asset.id).content)).toEqual(bytes);
    expect(JSON.parse(await fs.promises.readFile(paths(asset.id).metadata, 'utf8'))).toEqual(asset);
  });

  it('accepts exactly 10 MiB and rejects after observing byte maxBytes + 1', async () => {
    const exact = Buffer.alloc(MAX_EDITABLE_BODY_BYTES, 0x61);
    await expect(put(exact)).resolves.toMatchObject({ size: exact.length });

    const oversized = Buffer.concat([exact, Buffer.of(0)]);
    await expect(put(oversized)).rejects.toMatchObject({ status: 413, code: 'BODY_TOO_LARGE' });
    expect((await allFiles()).filter(file => file.includes(digest(oversized)))).toEqual([]);
  });

  it('permits trusted ingestion to use a larger explicit policy', async () => {
    const media = Buffer.alloc(MAX_EDITABLE_BODY_BYTES + 1, 0x61);

    await expect(put(media, { mediaType: 'video/mp2t' }, { maxBytes: 100 * 1024 * 1024 }))
      .resolves.toMatchObject({ size: media.length });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxBytes policy value %s before consuming the source',
    async maxBytes => {
      let consumed = false;
      const source = Readable.from((async function* () {
        consumed = true;
        yield Buffer.of(1);
      })());

      await expect(store.put(projectId, source, { mediaType: 'application/octet-stream' }, { maxBytes }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_BODY_POLICY' });
      expect(consumed).toBe(false);
    },
  );

  it('removes staging files when the source stream fails', async () => {
    const source = Readable.from((async function* () {
      yield Buffer.from('partial');
      throw new Error('source failure');
    })());

    await expect(store.put(projectId, source, { mediaType: 'text/plain' }, editablePolicy))
      .rejects.toThrow('source failure');
    expect(await allFiles()).toEqual([]);
  });

  it('deduplicates exact content without replacing immutable metadata', async () => {
    const body = '{"same":true}';
    const first = await put(body, { mediaType: 'text/plain' });
    const firstMetadataBytes = await fs.promises.readFile(paths(first.id).metadata);
    const second = await put(body, { mediaType: 'text/plain' });

    expect(second).toEqual(first);
    expect(await fs.promises.readFile(paths(first.id).metadata)).toEqual(firstMetadataBytes);
    await expect(put(body, { mediaType: 'application/json' }))
      .rejects.toMatchObject({ status: 409, code: 'ASSET_METADATA_CONFLICT' });
  });

  it('publishes exactly one metadata definition for concurrent conflicting puts', async () => {
    const body = '{"concurrent":true}';
    const atomicWriter = barrierAtomicWriter(createAtomicFileWriter(nodeFileSystem));
    store = createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem });

    const results = await Promise.allSettled([
      put(body, { mediaType: 'text/plain' }),
      put(body, { mediaType: 'application/json' }),
    ]);

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { status: 409, code: 'ASSET_METADATA_CONFLICT' },
    });

    const persisted = JSON.parse(await fs.promises.readFile(paths(digest(Buffer.from(body))).metadata, 'utf8'));
    expect((fulfilled[0] as PromiseFulfilledResult<BodyAsset>).value).toEqual(persisted);
  });

  it.each([
    ['application/json', '{bad'],
    ['application/problem+json; charset=utf-8', '{bad'],
    ['application/json', '{} true'],
    ['application/json', '\u00a0{}'],
  ])('rejects malformed %s before publishing content or metadata', async (mediaType, body) => {
    const assetId = digest(Buffer.from(body));

    await expect(put(body, { mediaType })).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_JSON_BODY',
    });
    await expect(fs.promises.stat(paths(assetId).content)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(assetId).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid UTF-8 JSON before publishing metadata', async () => {
    const bytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);

    await expect(put(bytes, { mediaType: 'application/json' })).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_JSON_BODY',
    });
    expect(await allFiles()).toEqual([]);
  });

  it('accepts valid structured JSON media types', async () => {
    await expect(put('{"ok":true}', { mediaType: 'Application/Problem+Json; charset=utf-8' }))
      .resolves.toMatchObject({ mediaType: 'application/problem+json; charset=utf-8' });
  });

  it('validates trusted JSON over 10 MiB through incremental handle reads', async () => {
    const tracked = incrementalJsonFileSystem();
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(tracked.fileSystem),
      fileSystem: tracked.fileSystem,
    });
    const payloadBytes = MAX_EDITABLE_BODY_BYTES + 1;
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const source = Readable.from((async function* () {
      yield Buffer.from('{"data":"');
      let remaining = payloadBytes;
      while (remaining > 0) {
        const length = Math.min(remaining, chunk.length);
        yield chunk.subarray(0, length);
        remaining -= length;
      }
      yield Buffer.from('"}');
    })());

    await expect(store.put(
      projectId,
      source,
      { mediaType: 'application/json' },
      { maxBytes: 12 * 1024 * 1024 },
    )).resolves.toMatchObject({ size: payloadBytes + 11 });
    expect(tracked.readFileCalls()).toBe(0);
    expect(tracked.readCalls()).toBeGreaterThan(1);
  });

  it.each([
    [{ mediaType: '' }],
    [{ mediaType: 'text/plain', encoding: '' }],
  ])('rejects invalid requested metadata before publishing files', async metadata => {
    await expect(put('body', metadata)).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_BODY_METADATA',
    });
    expect(await allFiles()).toEqual([]);
  });

  it('rejects project paths that escape through a symlink', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-outside-'));
    const bodies = path.join(root, 'projects', projectId, 'bodies');
    await fs.promises.mkdir(path.dirname(bodies), { recursive: true });
    await fs.promises.symlink(outside, bodies);

    try {
      await expect(put('secret')).rejects.toMatchObject({ status: 400, code: 'INVALID_BODY_ASSET_PATH' });
      expect(await fs.promises.readdir(outside)).toEqual([]);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not publish through a digest ancestor replaced after a successful check', async () => {
    const bytes = Buffer.from('publish-race');
    const assetId = digest(bytes);
    const digestDirectory = path.dirname(paths(assetId).content);
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-publish-race-'));
    await fs.promises.mkdir(digestDirectory, { recursive: true });
    const fileSystem = replaceAncestorAfterCheckFileSystem(digestDirectory, outsideRoot);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });

    try {
      await expect(put(bytes)).rejects.toMatchObject({
        status: 422,
        code: 'ASSET_INTEGRITY_ERROR',
      });
      expect(await fs.promises.readdir(outsideRoot)).toEqual([]);
    } finally {
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('maps an initial put snapshot race while preserving explicit HttpErrors', async () => {
    const fileSystem = failInitialPutSnapshotFileSystem();
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });

    await expect(put('snapshot-race'))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });

    const failure = new HttpError(409, 'SNAPSHOT_FAILURE', 'snapshot failure');
    const explicitFileSystem = failInitialPutSnapshotFileSystem(failure);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(explicitFileSystem),
      fileSystem: explicitFileSystem,
    });

    await expect(put('snapshot-error')).rejects.toBe(failure);
  });

  it('preserves existing-content hash failure when handle close also fails', async () => {
    const bytes = Buffer.from('existing-content-close');
    const asset = await put(bytes);
    const fileSystem = failingExistingContentHandleFileSystem(paths(asset.id).content);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });

    await expect(put(bytes))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });
});

describe('BodyStore reads', () => {
  it('opens an empty body as an empty stream', async () => {
    const asset = await put(Buffer.alloc(0));

    expect(await consume(store.openReadStream(projectId, asset.id))).toEqual(Buffer.alloc(0));
  });

  it('preserves exact binary bytes and opens inclusive bounded ranges', async () => {
    const bytes = Buffer.from([0, 255, 1, 254]);
    const asset = await put(bytes);

    expect(await consume(store.openReadStream(projectId, asset.id))).toEqual(bytes);
    expect(await consume(store.openReadStream(projectId, asset.id, { start: 1, end: 2 })))
      .toEqual(Buffer.from([255, 1]));
    expect(await consume(store.openReadStream(projectId, asset.id, { start: 2 })))
      .toEqual(Buffer.from([1, 254]));
    expect(await consume(store.openReadStream(projectId, asset.id, { end: 1 })))
      .toEqual(Buffer.from([0, 255]));
  });

  it('streams the validated inode when its path is replaced before delivery', async () => {
    const inside = Buffer.from('inside');
    const outside = Buffer.from('escape');
    const asset = await put(inside);
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-race-'));
    const outsidePath = path.join(outsideRoot, 'outside.bin');
    await fs.promises.writeFile(outsidePath, outside);

    try {
      const fileSystem = replacePathAfterValidationFileSystem(paths(asset.id).content, outsidePath);
      store = createBodyStore({
        rootDirectory: root,
        atomicWriter: createAtomicFileWriter(fileSystem),
        fileSystem,
      });

      expect(await consume(store.openReadStream(projectId, asset.id))).toEqual(inside);
      expect((await fs.promises.lstat(paths(asset.id).content)).isSymbolicLink()).toBe(true);
    } finally {
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects a digest ancestor replaced after a successful read check', async () => {
    const bytes = Buffer.from('ancestor-race');
    const asset = await put(bytes, { mediaType: 'inside/type' });
    const digestDirectory = path.dirname(paths(asset.id).content);
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-read-race-'));
    await fs.promises.writeFile(path.join(outsideRoot, asset.id), bytes);
    await fs.promises.writeFile(path.join(outsideRoot, `${asset.id}.json`), JSON.stringify({
      ...asset,
      mediaType: 'outside/type',
    }));
    const fileSystem = replaceAncestorAfterCheckFileSystem(digestDirectory, outsideRoot);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });

    try {
      await expect(consume(store.openReadStream(projectId, asset.id)))
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    } finally {
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects FIFO metadata without opening it', async () => {
    const bytes = Buffer.from('fifo-metadata');
    const asset = await put(bytes);
    const metadataPath = paths(asset.id).metadata;
    await fs.promises.unlink(metadataPath);
    await execFileAsync('mkfifo', [metadataPath]);
    let fifoOpenCount = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        if (filePath === metadataPath) {
          fifoOpenCount += 1;
          throw new Error('test prevented a blocking FIFO open');
        }
        return nodeFileSystem.open(filePath, flags, mode);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });

    await expect(store.getMetadata(projectId, asset.id))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    expect(fifoOpenCount).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects FIFO content without opening it', async () => {
    const bytes = Buffer.from('fifo-content');
    const asset = await put(bytes);
    const contentPath = paths(asset.id).content;
    await fs.promises.unlink(contentPath);
    await execFileAsync('mkfifo', [contentPath]);
    let fifoOpenCount = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async open(filePath, flags, mode) {
        if (filePath === contentPath) {
          fifoOpenCount += 1;
          throw new Error('test prevented a blocking FIFO open');
        }
        return nodeFileSystem.open(filePath, flags, mode);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });

    await expect(consume(store.openReadStream(projectId, asset.id)))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    expect(fifoOpenCount).toBe(0);
  });

  it('rejects a directory used as content', async () => {
    const bytes = Buffer.from('directory-content');
    const asset = await put(bytes);
    const contentPath = paths(asset.id).content;
    await fs.promises.unlink(contentPath);
    await fs.promises.mkdir(contentPath);

    await expect(consume(store.openReadStream(projectId, asset.id)))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });

  it('closes the pinned content handle after successful delivery', async () => {
    const asset = await put(Buffer.from('body'));
    const tracked = trackingContentHandleFileSystem(paths(asset.id).content);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(tracked.fileSystem),
      fileSystem: tracked.fileSystem,
    });

    await consume(store.openReadStream(projectId, asset.id));

    expect(tracked.closeCalls()).toBe(1);
  });

  it('closes the pinned content handle after range rejection', async () => {
    const asset = await put(Buffer.from('body'));
    const tracked = trackingContentHandleFileSystem(paths(asset.id).content);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(tracked.fileSystem),
      fileSystem: tracked.fileSystem,
    });

    await expect(consume(store.openReadStream(projectId, asset.id, { start: 99 })))
      .rejects.toMatchObject({ status: 416, code: 'INVALID_BODY_RANGE' });

    expect(tracked.closeCalls()).toBe(1);
  });

  it('closes the pinned content handle after consumer cancellation', async () => {
    const asset = await put(Buffer.alloc(128 * 1024, 0x61));
    const tracked = trackingContentHandleFileSystem(paths(asset.id).content);
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(tracked.fileSystem),
      fileSystem: tracked.fileSystem,
    });
    const stream = store.openReadStream(projectId, asset.id);
    const iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();

    await iterator.next();
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;

    expect(tracked.closeCalls()).toBe(1);
  });

  it('closes the pinned content handle and reports delivery failures as integrity errors', async () => {
    const asset = await put(Buffer.from('body'));
    const tracked = trackingContentHandleFileSystem(paths(asset.id).content, { failDelivery: true });
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(tracked.fileSystem),
      fileSystem: tracked.fileSystem,
    });

    await expect(consume(store.openReadStream(projectId, asset.id)))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });

    expect(tracked.closeCalls()).toBe(1);
  });

  it.each([
    { start: -1 },
    { end: -1 },
    { start: 0.5 },
    { end: 0.5 },
    { start: 2, end: 1 },
    { start: 4 },
    { end: 4 },
  ])('rejects invalid stream range $start..$end', async range => {
    const asset = await put(Buffer.from([0, 1, 2, 3]));

    await expect(consume(store.openReadStream(projectId, asset.id, range)))
      .rejects.toMatchObject({ status: 416, code: 'INVALID_BODY_RANGE' });
  });

  it.each([
    ['strict metadata', async () => {
      const bytes = Buffer.of(1);
      const asset = validAsset(bytes);
      await writeRawAsset({ ...asset, unexpected: true } as BodyAsset, bytes);
      return asset.id;
    }],
    ['wrong size', async () => {
      const bytes = Buffer.of(1);
      const asset = validAsset(bytes, { size: 99 });
      await writeRawAsset(asset, bytes);
      return asset.id;
    }],
    ['wrong content digest', async () => {
      const expected = Buffer.of(1);
      const asset = validAsset(expected);
      await writeRawAsset(asset, Buffer.of(2));
      return asset.id;
    }],
    ['metadata identity disagreement', async () => {
      const bytes = Buffer.of(1);
      const requestedId = digest(bytes);
      const asset = validAsset(bytes, { id: digest(Buffer.of(2)) });
      const assetPaths = paths(requestedId);
      await fs.promises.mkdir(path.dirname(assetPaths.content), { recursive: true });
      await fs.promises.writeFile(assetPaths.content, bytes);
      await fs.promises.writeFile(assetPaths.metadata, JSON.stringify(asset));
      return requestedId;
    }],
    ['missing content', async () => {
      const asset = validAsset(Buffer.of(1));
      await writeRawAsset(asset);
      return asset.id;
    }],
  ] as const)('reports ASSET_INTEGRITY_ERROR for %s', async (_name, arrange) => {
    const assetId = await arrange();

    await expect(store.getMetadata(projectId, assetId))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });

  it('reports invalid JSON metadata as an integrity error', async () => {
    const assetId = digest(Buffer.of(1));
    await fs.promises.mkdir(path.dirname(paths(assetId).metadata), { recursive: true });
    await fs.promises.writeFile(paths(assetId).metadata, '{bad');

    await expect(store.getMetadata(projectId, assetId))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });

  it('reports invalid UTF-8 metadata as an integrity error', async () => {
    const bytes = Buffer.of(1);
    const asset = validAsset(bytes);
    const serialized = Buffer.from(JSON.stringify(asset));
    const mediaType = Buffer.from(asset.mediaType);
    const mediaTypeOffset = serialized.indexOf(mediaType);
    const invalidMetadata = Buffer.concat([
      serialized.subarray(0, mediaTypeOffset),
      Buffer.from([0xff]),
      serialized.subarray(mediaTypeOffset + mediaType.length),
    ]);
    await fs.promises.mkdir(path.dirname(paths(asset.id).content), { recursive: true });
    await fs.promises.writeFile(paths(asset.id).content, bytes);
    await fs.promises.writeFile(paths(asset.id).metadata, invalidMetadata);

    await expect(store.getMetadata(projectId, asset.id))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });

  it('returns a structured not-found error when metadata is missing', async () => {
    const assetId = digest(Buffer.of(1));

    await expect(store.getMetadata(projectId, assetId))
      .rejects.toMatchObject({ status: 404, code: 'BODY_ASSET_NOT_FOUND' });
    await expect(consume(store.openReadStream(projectId, assetId)))
      .rejects.toMatchObject({ status: 404, code: 'BODY_ASSET_NOT_FOUND' });
  });

  it('rejects symlinked content without reading outside the Body Asset root', async () => {
    const expected = Buffer.from('inside');
    const outside = path.join(root, 'outside.bin');
    const asset = validAsset(expected);
    await fs.promises.mkdir(path.dirname(paths(asset.id).content), { recursive: true });
    await fs.promises.writeFile(outside, expected);
    await fs.promises.symlink(outside, paths(asset.id).content);
    await fs.promises.writeFile(paths(asset.id).metadata, JSON.stringify(asset));

    await expect(store.getMetadata(projectId, asset.id))
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
  });
});

describe('BodyStore import transactions', () => {
  it('stream-stages exact chunked bytes without materializing the complete body', async () => {
    const chunks = Array.from({ length: 32 }, (_, index) => Buffer.alloc(4096, index));
    const bytes = Buffer.concat(chunks);
    let largestContentChunk = 0;
    const atomicWriter = createAtomicFileWriter(nodeFileSystem);
    store = createBodyStore({
      rootDirectory: root,
      fileSystem: nodeFileSystem,
      atomicWriter: {
        ...atomicWriter,
        writeStream(destination, source, guard) {
          const observed = destination.endsWith('.json')
            ? source
            : Readable.from((async function* () {
              for await (const chunk of source as AsyncIterable<Buffer | string>) {
                const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                largestContentChunk = Math.max(largestContentChunk, value.length);
                yield value;
              }
            })());
          return atomicWriter.writeStream(destination, observed, guard);
        },
      },
    });
    const transaction = await store.beginImport(projectId);

    const asset = await transaction.stageStream(
      Readable.from(chunks),
      { sha256: digest(bytes), byteCount: bytes.length },
      { mediaType: 'Application/Octet-Stream', encoding: 'GZip' },
    );

    expect(asset).toMatchObject({
      id: digest(bytes),
      size: bytes.length,
      mediaType: 'application/octet-stream',
      encoding: 'gzip',
    });
    expect(largestContentChunk).toBe(4096);
    expect(largestContentChunk).toBeLessThan(bytes.length);
    await transaction.promote();
    await transaction.complete();
    expect(await fs.promises.readFile(paths(asset.id).content)).toEqual(bytes);
  });

  it.each([
    ['digest', { sha256: digest(Buffer.from('different')), byteCount: 7 }],
    ['size', { sha256: digest(Buffer.from('payload')), byteCount: 8 }],
  ])('rejects a stream whose %s differs from its exact expectation', async (_case, expected) => {
    const transaction = await store.beginImport(projectId);

    await expect(transaction.stageStream(
      Readable.from([Buffer.from('payload')]),
      expected,
      { mediaType: 'application/octet-stream' },
    )).rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });

    await transaction.rollback();
    expect(await importDirectories()).toEqual([]);
  });

  it('reuses exact canonical and concurrently staged stream assets', async () => {
    const bytes = Buffer.from('stream deduplication');
    const expected = { sha256: digest(bytes), byteCount: bytes.length };
    const canonical = await store.put(
      projectId,
      Readable.from([bytes]),
      { mediaType: 'text/plain' },
      { maxBytes: bytes.length },
    );
    const existingTransaction = await store.beginImport(projectId);
    await expect(existingTransaction.stageStream(
      Readable.from([bytes]),
      expected,
      { mediaType: 'text/plain' },
    )).resolves.toEqual(canonical);
    await existingTransaction.complete();

    const transaction = await store.beginImport(projectId);
    const metadata = { mediaType: 'application/octet-stream' };
    const otherBytes = Buffer.from('concurrent stream asset');
    const otherExpected = { sha256: digest(otherBytes), byteCount: otherBytes.length };
    const [first, second] = await Promise.all([
      transaction.stageStream(Readable.from([otherBytes]), otherExpected, metadata),
      transaction.stageStream(Readable.from([otherBytes]), otherExpected, metadata),
    ]);

    expect(second).toEqual(first);
    await transaction.rollback();
  });

  it('cleans failed streams and exposes awaited idempotent completion', async () => {
    const transaction = await store.beginImport(projectId);
    const failure = new Error('stream failed');
    const source = Readable.from((async function* () {
      yield Buffer.from('prefix');
      throw failure;
    })());

    await expect(transaction.stageStream(
      source,
      { sha256: digest(Buffer.from('prefix')), byteCount: 6 },
      { mediaType: 'application/octet-stream' },
    )).rejects.toBe(failure);
    await transaction.rollback();
    await expect(transaction.complete()).resolves.toBeUndefined();
    expect(await importDirectories()).toEqual([]);
  });

  it('keeps staged metadata transaction-local, defensively cloned, and deduplicated', async () => {
    const transaction = await store.beginImport(projectId);
    const bytes = Buffer.from('staged body');
    const metadata = { mediaType: 'application/octet-stream' };

    const first = await transaction.stage(bytes, metadata);
    const second = await transaction.stage(Buffer.from(bytes), metadata);

    expect(second).toEqual(first);
    const staged = await transaction.getMetadata(first.id);
    expect(staged).toEqual(first);
    staged.mediaType = 'mutated/type';
    await expect(transaction.getMetadata(first.id)).resolves.toEqual(first);
    await expect(store.getMetadata(projectId, first.id))
      .rejects.toMatchObject({ status: 404, code: 'BODY_ASSET_NOT_FOUND' });
    await expect(transaction.stage(bytes, { mediaType: 'text/plain' }))
      .rejects.toMatchObject({ status: 409, code: 'ASSET_METADATA_CONFLICT' });

    await transaction.rollback();
  });

  it('rejects a staged content path replaced before promotion', async () => {
    const transaction = await store.beginImport(projectId);
    const bytes = Buffer.from('replaced staged content');
    const asset = await transaction.stage(bytes, { mediaType: 'application/octet-stream' });
    const [stagingDirectory] = await importDirectories();
    const stagedContent = path.join(stagingDirectory, asset.id);
    await fs.promises.unlink(stagedContent);
    await fs.promises.writeFile(stagedContent, bytes);

    try {
      await expect(transaction.promote())
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    } finally {
      await transaction.rollback().catch(() => undefined);
    }
  });

  it('rejects a staged metadata path replaced before promotion', async () => {
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(Buffer.from('replaced staged metadata'), {
      mediaType: 'application/octet-stream',
    });
    const [stagingDirectory] = await importDirectories();
    const stagedMetadata = path.join(stagingDirectory, `${asset.id}.json`);
    const metadataBytes = await fs.promises.readFile(stagedMetadata);
    await fs.promises.unlink(stagedMetadata);
    await fs.promises.writeFile(stagedMetadata, metadataBytes);

    try {
      await expect(transaction.promote())
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    } finally {
      await transaction.rollback().catch(() => undefined);
    }
  });

  it('rejects staged metadata mutated in place without changing its inode', async () => {
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(Buffer.from('mutated staged metadata'), {
      mediaType: 'text/plain',
    });
    const [stagingDirectory] = await importDirectories();
    const stagedMetadata = path.join(stagingDirectory, `${asset.id}.json`);
    const before = await fs.promises.lstat(stagedMetadata);
    const mutated = Buffer.from(JSON.stringify({ ...asset, mediaType: 'text/html' }));
    const handle = await fs.promises.open(stagedMetadata, 'r+');
    try {
      await handle.writeFile(mutated);
      await handle.truncate(mutated.length);
    } finally {
      await handle.close();
    }
    const after = await fs.promises.lstat(stagedMetadata);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });

    try {
      await expect(transaction.promote())
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    } finally {
      await transaction.rollback().catch(() => undefined);
    }
  });

  it('deterministically rejects a conflicting stage while the asset ID is reserved', async () => {
    const blocked = blockedAtomicWriter(createAtomicFileWriter(nodeFileSystem));
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: blocked.writer,
      fileSystem: nodeFileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const bytes = Buffer.from('concurrent conflicting stage');
    const first = transaction.stage(bytes, { mediaType: 'text/plain' });
    await blocked.started;
    const second = transaction.stage(bytes, { mediaType: 'text/html' });
    blocked.release();

    const results = await Promise.allSettled([first, second]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 409, code: 'ASSET_METADATA_CONFLICT' }),
      }),
    ]);
    await transaction.rollback();
  });

  it('deduplicates equivalent concurrent stages through one reserved write', async () => {
    const blocked = blockedAtomicWriter(createAtomicFileWriter(nodeFileSystem));
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: blocked.writer,
      fileSystem: nodeFileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const bytes = Buffer.from('concurrent equivalent stage');
    const metadata = { mediaType: 'application/octet-stream' };
    const first = transaction.stage(bytes, metadata);
    await blocked.started;
    const second = transaction.stage(Buffer.from(bytes), metadata);
    blocked.release();

    const [firstAsset, secondAsset] = await Promise.all([first, second]);

    expect(secondAsset).toEqual(firstAsset);
    expect(blocked.writeCalls()).toBe(2);
    await transaction.rollback();
  });

  it('does not create an external import directory after the staging ancestor is replaced', async () => {
    const bytes = Buffer.from('staging ancestor replacement');
    const assetId = digest(bytes);
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-import-ancestor-'));
    const bodyRoot = projectBodyRoot();
    const originalBodyRoot = `${bodyRoot}.original`;
    let replaced = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async lstat(filePath) {
        try {
          return await nodeFileSystem.lstat(filePath);
        } catch (error) {
          if (!replaced
            && filePath === paths(assetId).metadata
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            replaced = true;
            await nodeFileSystem.rename(bodyRoot, originalBodyRoot);
            await fs.promises.symlink(outside, bodyRoot);
          }
          throw error;
        }
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    await fs.promises.mkdir(path.dirname(paths(assetId).content), { recursive: true });

    try {
      await expect(transaction.stage(bytes, { mediaType: 'application/octet-stream' }))
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
      expect(await fs.promises.readdir(outside)).toEqual([]);
    } finally {
      if (replaced) {
        await fs.promises.unlink(bodyRoot).catch(() => undefined);
        await fs.promises.rename(originalBodyRoot, bodyRoot).catch(() => undefined);
      }
      await transaction.rollback().catch(() => undefined);
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('promotes deduplicated content and metadata exactly once and completes idempotently', async () => {
    let contentPromotions = 0;
    let metadataPromotions = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        if (isCanonicalContentPath(newPath)) contentPromotions += 1;
        if (isCanonicalMetadataPath(newPath)) metadataPromotions += 1;
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const bytes = Buffer.from('promote once');
    const first = await transaction.stage(bytes, { mediaType: 'application/octet-stream' });
    const second = await transaction.stage(bytes, { mediaType: 'application/octet-stream' });

    await transaction.promote();

    expect(second).toEqual(first);
    expect(contentPromotions).toBe(1);
    expect(metadataPromotions).toBe(1);
    expect(await fs.promises.readFile(paths(first.id).content)).toEqual(bytes);
    expect(JSON.parse(await fs.promises.readFile(paths(first.id).metadata, 'utf8'))).toEqual(first);

    await Promise.all([transaction.complete(), transaction.complete()]);
    expect((await allFiles()).filter(file => file.includes('.import-'))).toEqual([]);
  });

  it('reports a transient complete cleanup failure and permits an awaited retry', async () => {
    let stagingCleanupAttempts = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(filePath, options) {
        if (path.basename(filePath).startsWith('.import-') && ++stagingCleanupAttempts === 1) {
          throw new Error('transient staging cleanup failure');
        }
        await nodeFileSystem.rm(filePath, options);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    await transaction.stage(Buffer.from('complete retry'), { mediaType: 'application/octet-stream' });

    await expect(transaction.complete()).rejects.toThrow('transient staging cleanup failure');
    await expect(transaction.complete()).resolves.toBeUndefined();
    expect(await importDirectories()).toEqual([]);
    expect(stagingCleanupAttempts).toBe(2);
  });

  it('rolls back earlier promotions when the second asset promotion fails without touching pre-existing assets', async () => {
    const existingBytes = Buffer.from('already canonical');
    const existing = await put(existingBytes);
    const existingContent = await fs.promises.readFile(paths(existing.id).content);
    const existingMetadata = await fs.promises.readFile(paths(existing.id).metadata);
    let promotionCount = 0;
    const promotionFailure = new Error('second promotion failed');
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        if (isCanonicalContentPath(newPath) && ++promotionCount === 2) throw promotionFailure;
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    await transaction.stage(existingBytes, { mediaType: 'application/octet-stream' });
    const first = await transaction.stage(Buffer.from('first new body'), {
      mediaType: 'application/octet-stream',
    });
    const second = await transaction.stage(Buffer.from('second new body'), {
      mediaType: 'application/octet-stream',
    });

    await expect(transaction.promote()).rejects.toBe(promotionFailure);
    await transaction.rollback();
    await transaction.rollback();

    await expect(fs.promises.stat(paths(first.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(first.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(first.id).directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(second.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(second.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(second.id).directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.promises.readFile(paths(existing.id).content)).toEqual(existingContent);
    expect(await fs.promises.readFile(paths(existing.id).metadata)).toEqual(existingMetadata);
    expect((await allFiles()).filter(file => file.includes('.import-'))).toEqual([]);
  });

  it('removes promoted content and staging when canonical metadata publication fails', async () => {
    const metadataFailure = new Error('metadata publication failed');
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        if (isCanonicalMetadataPath(newPath)) throw metadataFailure;
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(Buffer.from('metadata failure'), {
      mediaType: 'application/octet-stream',
    });

    await expect(transaction.promote()).rejects.toBe(metadataFailure);
    await transaction.rollback();

    await expect(fs.promises.stat(paths(asset.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(asset.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(asset.id).directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await allFiles()).filter(file => file.includes('.import-'))).toEqual([]);
  });

  it('preserves a pre-existing empty digest directory during rollback', async () => {
    const bytes = Buffer.from('pre-existing empty digest directory');
    const directory = paths(digest(bytes)).directory;
    await fs.promises.mkdir(directory, { recursive: true });
    const transaction = await store.beginImport(projectId);
    await transaction.stage(bytes, { mediaType: 'application/octet-stream' });
    await transaction.promote();

    await transaction.rollback();

    expect(await fs.promises.readdir(directory)).toEqual([]);
  });

  it('continues rollback cleanup after an injected removal failure and remains idempotent', async () => {
    const rollbackFailure = new Error('rollback removal failed');
    let injected = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(filePath, options) {
        await nodeFileSystem.rm(filePath, options);
        if (!injected && isCanonicalContentPath(filePath)) {
          injected = true;
          throw rollbackFailure;
        }
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const first = await transaction.stage(Buffer.from('rollback one'), {
      mediaType: 'application/octet-stream',
    });
    const second = await transaction.stage(Buffer.from('rollback two'), {
      mediaType: 'application/octet-stream',
    });
    await transaction.promote();

    await expect(transaction.rollback()).rejects.toBe(rollbackFailure);
    await expect(transaction.rollback()).resolves.toBeUndefined();

    for (const asset of [first, second]) {
      await expect(fs.promises.stat(paths(asset.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.promises.stat(paths(asset.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await allFiles()).filter(file => file.includes('.import-'))).toEqual([]);
  });

  it('guards staged metadata when the staging directory is replaced after content publication', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-import-stage-race-'));
    let stagingDirectory: string | undefined;
    let originalDirectory: string | undefined;
    let stagingMkdirCalls = 0;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async mkdir(directory, options) {
        const result = await nodeFileSystem.mkdir(directory, options);
        if (path.basename(directory).startsWith('.import-') && ++stagingMkdirCalls === 3) {
          stagingDirectory = directory;
          originalDirectory = `${stagingDirectory}.original`;
          await nodeFileSystem.rename(stagingDirectory, originalDirectory);
          await fs.promises.symlink(outside, stagingDirectory);
        }
        return result;
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);

    try {
      await expect(transaction.stage(Buffer.from('guard metadata'), {
        mediaType: 'application/octet-stream',
      })).rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
      expect(await fs.promises.readdir(outside)).toEqual([]);
      await expect(transaction.rollback())
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
      expect(await fs.promises.readdir(outside)).toEqual([]);
    } finally {
      if (stagingDirectory && originalDirectory) {
        await fs.promises.unlink(stagingDirectory).catch(() => undefined);
        await fs.promises.rename(originalDirectory, stagingDirectory).catch(() => undefined);
        await transaction.rollback().catch(() => undefined);
      }
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('skips rollback removal when a canonical ancestor is replaced and retries after restoration', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-import-rollback-race-'));
    const bytes = Buffer.from('guard rollback');
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(bytes, { mediaType: 'application/octet-stream' });
    await transaction.promote();
    const directory = path.dirname(paths(asset.id).content);
    const originalDirectory = `${directory}.original`;
    await fs.promises.writeFile(path.join(outside, asset.id), Buffer.from('outside content'));
    await fs.promises.writeFile(path.join(outside, `${asset.id}.json`), 'outside metadata');
    await fs.promises.rename(directory, originalDirectory);
    await fs.promises.symlink(outside, directory);

    try {
      await expect(transaction.rollback())
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
      expect(await fs.promises.readFile(path.join(outside, asset.id), 'utf8')).toBe('outside content');
      expect(await fs.promises.readFile(path.join(outside, `${asset.id}.json`), 'utf8'))
        .toBe('outside metadata');

      await fs.promises.unlink(directory);
      await fs.promises.rename(originalDirectory, directory);
      await expect(transaction.rollback()).resolves.toBeUndefined();
      await expect(fs.promises.stat(paths(asset.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.promises.stat(paths(asset.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.promises.unlink(directory).catch(() => undefined);
      await fs.promises.rename(originalDirectory, directory).catch(() => undefined);
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects complete safely and permits retry after a replaced ancestor is restored', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-import-complete-race-'));
    const transaction = await store.beginImport(projectId);
    await transaction.stage(Buffer.from('guard complete'), { mediaType: 'application/octet-stream' });
    const [stagingDirectory] = await importDirectories();
    const bodyRoot = projectBodyRoot();
    const originalBodyRoot = `${bodyRoot}.original`;
    const outsideStaging = path.join(outside, path.basename(stagingDirectory));
    await fs.promises.mkdir(outsideStaging, { recursive: true });
    await fs.promises.writeFile(path.join(outsideStaging, 'marker'), 'outside marker');
    await fs.promises.rename(bodyRoot, originalBodyRoot);
    await fs.promises.symlink(outside, bodyRoot);

    try {
      await expect(transaction.complete())
        .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
      expect(await fs.promises.readFile(path.join(outsideStaging, 'marker'), 'utf8'))
        .toBe('outside marker');

      await fs.promises.unlink(bodyRoot);
      await fs.promises.rename(originalBodyRoot, bodyRoot);
      await expect(transaction.complete()).resolves.toBeUndefined();
      expect(await importDirectories()).toEqual([]);
    } finally {
      await fs.promises.unlink(bodyRoot).catch(() => undefined);
      await fs.promises.rename(originalBodyRoot, bodyRoot).catch(() => undefined);
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('deduplicates a canonical content race without replacing the winning file', async () => {
    const bytes = Buffer.from('content race');
    let winningIdentity: { dev: number; ino: number } | undefined;
    let raced = false;
    const installWinner = async (destination: string): Promise<void> => {
      if (raced) return;
      raced = true;
      await fs.promises.writeFile(destination, bytes, { flag: 'wx' });
      const stats = await fs.promises.lstat(destination);
      winningIdentity = { dev: stats.dev, ino: stats.ino };
    };
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rename(from, to) {
        if (isCanonicalContentPath(to)) await installWinner(to);
        await nodeFileSystem.rename(from, to);
      },
      async link(existingPath, newPath) {
        if (isCanonicalContentPath(newPath)) await installWinner(newPath);
        await nodeFileSystem.link(existingPath, newPath);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(bytes, { mediaType: 'application/octet-stream' });

    await transaction.promote();

    const persisted = await fs.promises.lstat(paths(asset.id).content);
    expect({ dev: persisted.dev, ino: persisted.ino }).toEqual(winningIdentity);
    expect(await fs.promises.readFile(paths(asset.id).content)).toEqual(bytes);
    await transaction.rollback();
    expect(await fs.promises.readFile(paths(asset.id).content)).toEqual(bytes);
    await expect(fs.promises.stat(paths(asset.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back both owned links when a guard fails after metadata publication', async () => {
    let failNextGuard = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async link(existingPath, newPath) {
        await nodeFileSystem.link(existingPath, newPath);
        if (isCanonicalMetadataPath(newPath)) failNextGuard = true;
      },
      async lstat(filePath) {
        if (failNextGuard) {
          failNextGuard = false;
          throw new Error(`post-publication guard failed at ${filePath}`);
        }
        return nodeFileSystem.lstat(filePath);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(Buffer.from('post metadata publication'), {
      mediaType: 'application/octet-stream',
    });

    await expect(transaction.promote())
      .rejects.toMatchObject({ status: 422, code: 'ASSET_INTEGRITY_ERROR' });
    await transaction.rollback();

    await expect(fs.promises.stat(paths(asset.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(paths(asset.id).metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['mkdir', 'snapshot'] as const)(
    'cleans staging after beginImport %s setup failure while preserving the original error',
    async failurePoint => {
      const setupFailure = new Error(`${failurePoint} setup failed`);
      let injected = false;
      const fileSystem: FileSystem = {
        ...nodeFileSystem,
        async mkdir(directory, options) {
          const result = await nodeFileSystem.mkdir(directory, options);
          if (!injected && failurePoint === 'mkdir' && path.basename(directory).startsWith('.import-')) {
            injected = true;
            throw setupFailure;
          }
          return result;
        },
        async lstat(filePath) {
          if (!injected && failurePoint === 'snapshot' && path.basename(filePath).startsWith('.import-')) {
            injected = true;
            throw setupFailure;
          }
          return nodeFileSystem.lstat(filePath);
        },
      };
      store = createBodyStore({
        rootDirectory: root,
        atomicWriter: createAtomicFileWriter(fileSystem),
        fileSystem,
      });

      await expect(store.beginImport(projectId)).rejects.toBe(setupFailure);
      expect(await importDirectories()).toEqual([]);
    },
  );

  it('keeps rollback pending after a pre-delete failure and succeeds on explicit retry', async () => {
    const cleanupFailure = new Error('cleanup failed before delete');
    let injected = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(filePath, options) {
        if (!injected && isCanonicalContentPath(filePath)) {
          injected = true;
          throw cleanupFailure;
        }
        await nodeFileSystem.rm(filePath, options);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    const asset = await transaction.stage(Buffer.from('retry rollback'), {
      mediaType: 'application/octet-stream',
    });
    await transaction.promote();

    await expect(transaction.rollback()).rejects.toBe(cleanupFailure);
    expect(await fs.promises.readFile(paths(asset.id).content)).toEqual(Buffer.from('retry rollback'));
    await expect(transaction.rollback()).resolves.toBeUndefined();
    await expect(fs.promises.stat(paths(asset.id).content)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports synchronous complete cleanup failure and permits a serialized retry', async () => {
    const cleanupFailure = new Error('synchronous complete failure');
    let injected = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      rm(filePath, options) {
        if (!injected && path.basename(filePath).startsWith('.import-')) {
          injected = true;
          throw cleanupFailure;
        }
        return nodeFileSystem.rm(filePath, options);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    await transaction.stage(Buffer.from('sync complete'), { mediaType: 'application/octet-stream' });

    await expect(transaction.complete()).rejects.toBe(cleanupFailure);
    await expect(transaction.complete()).resolves.toBeUndefined();
    expect(await importDirectories()).toEqual([]);
  });

  it('serializes overlapping rollback calls', async () => {
    const removalStarted = deferred();
    const releaseRemoval = deferred();
    let blocked = false;
    const fileSystem: FileSystem = {
      ...nodeFileSystem,
      async rm(filePath, options) {
        if (!blocked && path.basename(filePath).startsWith('.import-')) {
          blocked = true;
          removalStarted.resolve();
          await releaseRemoval.promise;
        }
        await nodeFileSystem.rm(filePath, options);
      },
    };
    store = createBodyStore({
      rootDirectory: root,
      atomicWriter: createAtomicFileWriter(fileSystem),
      fileSystem,
    });
    const transaction = await store.beginImport(projectId);
    await transaction.stage(Buffer.from('overlap rollback'), { mediaType: 'application/octet-stream' });

    const first = transaction.rollback();
    await removalStarted.promise;
    let secondSettled = false;
    const second = transaction.rollback().then(() => { secondSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    releaseRemoval.resolve();
    await Promise.all([first, second]);
    expect(await importDirectories()).toEqual([]);
  });
});

describe('BodyStore path validation', () => {
  it.each(['', '.', '..', '../escape', '/absolute', 'nested/project', 'nested\\project']) (
    'rejects unstable project ID %j',
    async invalidProjectId => {
      await expect(store.put(
        invalidProjectId,
        Readable.from(['body']),
        { mediaType: 'text/plain' },
        editablePolicy,
      )).rejects.toMatchObject({ status: 400, code: 'INVALID_BODY_ASSET_PATH' });
    },
  );

  it.each(['', '..', '../asset', '/absolute', 'g'.repeat(64), 'A'.repeat(64), '0'.repeat(63)])(
    'rejects invalid asset ID %j',
    async invalidAssetId => {
      await expect(store.getMetadata(projectId, invalidAssetId))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_BODY_ASSET_PATH' });
      await expect(consume(store.openReadStream(projectId, invalidAssetId)))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_BODY_ASSET_PATH' });
    },
  );
});
