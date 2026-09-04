import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { BodyAsset } from '../domain/model';
import { normalizeContentEncoding, normalizeMediaType } from '../domain/http-metadata';
import { BodyAssetSchema } from '../domain/schemas';
import { HttpError } from '../services/api-errors';
import { isStablePathSegment } from '../services/storage';
import type { AtomicFileWriter, AtomicPathGuard } from './atomic-write';
import type { FileSystem } from './file-system';
import { validateJsonHandle } from './json-stream-validator';

export const MAX_EDITABLE_BODY_BYTES = 10 * 1024 * 1024;

export interface PutBodyMetadata {
  mediaType: string;
  encoding?: string;
}

export interface BodyImportTransaction {
  stage(bytes: Buffer, metadata: PutBodyMetadata): Promise<BodyAsset>;
  stageStream(
    source: NodeJS.ReadableStream,
    expected: { sha256: string; byteCount: number },
    metadata: PutBodyMetadata,
  ): Promise<BodyAsset>;
  getMetadata(assetId: string): Promise<BodyAsset>;
  promote(): Promise<void>;
  rollback(): Promise<void>;
  complete(): Promise<void>;
}

export interface BodyStore {
  put(
    projectId: string,
    source: NodeJS.ReadableStream,
    metadata: PutBodyMetadata,
    policy: { maxBytes: number },
  ): Promise<BodyAsset>;
  getMetadata(projectId: string, assetId: string): Promise<BodyAsset>;
  openReadStream(
    projectId: string,
    assetId: string,
    range?: { start?: number; end?: number },
  ): NodeJS.ReadableStream;
  beginImport(projectId: string): Promise<BodyImportTransaction>;
}

export interface BodyStoreOptions {
  rootDirectory: string;
  atomicWriter: AtomicFileWriter;
  fileSystem: FileSystem;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function pathError(): HttpError {
  return new HttpError(400, 'INVALID_BODY_ASSET_PATH', 'Body Asset path is invalid');
}

function integrityError(): HttpError {
  return new HttpError(422, 'ASSET_INTEGRITY_ERROR', 'Body Asset content and metadata disagree');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function validateProjectId(projectId: string): void {
  if (!isStablePathSegment(projectId)) throw pathError();
}

function validateAssetId(assetId: string): void {
  if (!SHA256_PATTERN.test(assetId)) throw pathError();
}

function assertContained(rootDirectory: string, candidate: string): void {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw pathError();
  }
}

async function assertNoSymlinkComponents(
  fileSystem: FileSystem,
  rootDirectory: string,
  candidate: string,
): Promise<void> {
  assertContained(rootDirectory, candidate);
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(candidate));
  let current = path.resolve(rootDirectory);

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fileSystem.lstat(current)).isSymbolicLink()) throw pathError();
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

type DirectorySnapshot = readonly DirectoryIdentity[];

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function snapshotDirectory(
  fileSystem: FileSystem,
  rootDirectory: string,
  directory: string,
): Promise<DirectorySnapshot> {
  assertContained(rootDirectory, directory);
  const root = path.resolve(rootDirectory);
  const relative = path.relative(root, path.resolve(directory));
  const directories = [root];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    directories.push(current);
  }

  const snapshot: DirectoryIdentity[] = [];
  for (const directoryPath of directories) {
    const stats = await fileSystem.lstat(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw integrityError();
    snapshot.push({ path: directoryPath, dev: stats.dev, ino: stats.ino });
  }
  return snapshot;
}

async function verifyDirectorySnapshot(
  fileSystem: FileSystem,
  snapshot: DirectorySnapshot,
): Promise<void> {
  try {
    for (const expected of snapshot) {
      const actual = await fileSystem.lstat(expected.path);
      if (!actual.isDirectory() || actual.isSymbolicLink() || !sameIdentity(actual, expected)) {
        throw integrityError();
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw integrityError();
  }
}

async function hashHandle(handle: FileHandle): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const stream = handle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest('hex'), size };
}

function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0].trim().toLowerCase();
  return essence === 'application/json' || essence.endsWith('+json');
}

async function validateJsonFile(
  fileSystem: FileSystem,
  filePath: string,
  guard: AtomicPathGuard,
): Promise<void> {
  let handle: FileHandle | undefined;
  let operationError: unknown;
  try {
    await guard();
    const pathStats = await fileSystem.lstat(filePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) throw integrityError();
    await guard();
    handle = await fileSystem.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    await guard();
    const handleStats = await handle.stat();
    if (!handleStats.isFile() || !sameIdentity(handleStats, pathStats)) throw integrityError();
    await validateJsonHandle(handle);
    await guard();
  } catch (error) {
    operationError = error instanceof HttpError
      ? error
      : new HttpError(422, 'INVALID_JSON_BODY', 'JSON Body Asset is not valid UTF-8 JSON');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        if (!operationError) {
          operationError = new HttpError(422, 'INVALID_JSON_BODY', 'JSON Body Asset could not be validated');
        }
      }
    }
  }
  if (operationError) throw operationError;
}

function normalizeRequestedMetadata(metadata: PutBodyMetadata): PutBodyMetadata {
  let normalized: PutBodyMetadata;
  try {
    const encoding = normalizeContentEncoding(metadata.encoding);
    normalized = {
      mediaType: normalizeMediaType(metadata.mediaType),
      ...(encoding === undefined ? {} : { encoding }),
    };
  } catch {
    throw new HttpError(422, 'INVALID_BODY_METADATA', 'Body Asset metadata is invalid');
  }
  const candidate = {
    schemaVersion: 4 as const,
    id: '0'.repeat(64),
    mediaType: normalized.mediaType,
    size: 0,
    ...(normalized.encoding === undefined ? {} : { encoding: normalized.encoding }),
    createdAt: new Date(0).toISOString(),
  };
  if (!BodyAssetSchema.safeParse(candidate).success) {
    throw new HttpError(422, 'INVALID_BODY_METADATA', 'Body Asset metadata is invalid');
  }
  return normalized;
}

function limitedSource(source: NodeJS.ReadableStream, maxBytes: number): NodeJS.ReadableStream {
  return Readable.from((async function* () {
    let observed = 0;
    for await (const chunk of source as AsyncIterable<Buffer | string | Uint8Array>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (observed + bytes.length > maxBytes) {
        observed = maxBytes + 1;
        throw new HttpError(413, 'BODY_TOO_LARGE', 'Body exceeds the allowed size limit');
      }
      observed += bytes.length;
      yield bytes;
    }
  })());
}

function metadataMatches(existing: BodyAsset, requested: BodyAsset): boolean {
  return existing.id === requested.id
    && existing.mediaType === requested.mediaType
    && existing.size === requested.size
    && existing.encoding === requested.encoding;
}

interface ImportAssetDisposition {
  asset: BodyAsset;
  contentStagingPath?: string;
  metadataStagingPath?: string;
  contentStagingIdentity?: { dev: number; ino: number };
  metadataStagingIdentity?: { dev: number; ino: number };
  contentIdentity?: { dev: number; ino: number };
  metadataIdentity?: { dev: number; ino: number };
  canonicalSnapshot?: DirectorySnapshot;
  canonicalDirectoryCreated?: boolean;
  contentPromoted: boolean;
  metadataPromoted: boolean;
  preExisting: boolean;
}

function metadataConflict(): HttpError {
  return new HttpError(
    409,
    'ASSET_METADATA_CONFLICT',
    'Immutable Body Asset metadata conflicts with the requested metadata',
  );
}

export function createBodyStore(options: BodyStoreOptions): BodyStore {
  const { rootDirectory, atomicWriter, fileSystem } = options;
  const bodyRoot = (projectId: string) => path.join(
    rootDirectory,
    'projects',
    projectId,
    'bodies',
    'sha256',
  );
  const assetPaths = (projectId: string, assetId: string) => {
    const directory = path.join(bodyRoot(projectId), assetId.slice(0, 2));
    return {
      directory,
      content: path.join(directory, assetId),
      metadata: path.join(directory, `${assetId}.json`),
    };
  };

  async function snapshotPutDirectory(directory: string): Promise<DirectorySnapshot> {
    try {
      return await snapshotDirectory(fileSystem, rootDirectory, directory);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw integrityError();
    }
  }

  async function openRegularFile(
    filePath: string,
    snapshot: DirectorySnapshot,
    missingError?: () => HttpError,
  ): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      await verifyDirectorySnapshot(fileSystem, snapshot);
      const pathStats = await fileSystem.lstat(filePath);
      if (!pathStats.isFile() || pathStats.isSymbolicLink()) throw integrityError();
      await verifyDirectorySnapshot(fileSystem, snapshot);
      handle = await fileSystem.open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
      );
      await verifyDirectorySnapshot(fileSystem, snapshot);
      const handleStats = await handle.stat();
      if (!handleStats.isFile() || !sameIdentity(handleStats, pathStats)) throw integrityError();
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (isMissing(error) && missingError) throw missingError();
      if (error instanceof HttpError) throw error;
      throw integrityError();
    }
  }

  async function readMetadata(
    paths: ReturnType<typeof assetPaths>,
    assetId: string,
    snapshot: DirectorySnapshot,
  ): Promise<BodyAsset> {
    const metadataHandle = await openRegularFile(
      paths.metadata,
      snapshot,
      () => new HttpError(404, 'BODY_ASSET_NOT_FOUND', 'Body Asset metadata was not found'),
    );

    let operationError: unknown;
    let metadata: BodyAsset | undefined;
    try {
      const metadataText = new TextDecoder('utf-8', { fatal: true })
        .decode(await metadataHandle.readFile());
      await verifyDirectorySnapshot(fileSystem, snapshot);
      const result = BodyAssetSchema.safeParse(JSON.parse(metadataText));
      if (!result.success || result.data.id !== assetId) throw integrityError();
      metadata = result.data;
    } catch (error) {
      operationError = error instanceof HttpError ? error : integrityError();
    } finally {
      try {
        await metadataHandle.close();
      } catch {
        if (!operationError) operationError = integrityError();
      }
    }
    if (operationError) throw operationError;
    return metadata!;
  }

  async function openValidatedAsset(
    paths: ReturnType<typeof assetPaths>,
    assetId: string,
    snapshot: DirectorySnapshot,
  ): Promise<{ metadata: BodyAsset; handle: FileHandle }> {
    const metadata = await readMetadata(paths, assetId, snapshot);
    let handle: FileHandle | undefined;
    try {
      handle = await openRegularFile(paths.content, snapshot);
      const actual = await hashHandle(handle);
      await verifyDirectorySnapshot(fileSystem, snapshot);
      if (actual.size !== metadata.size || actual.sha256 !== assetId) throw integrityError();
      return { metadata, handle };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof HttpError) throw error;
      throw integrityError();
    }
  }

  async function openValidatedContent(
    projectId: string,
    assetId: string,
  ): Promise<{ metadata: BodyAsset; handle: FileHandle }> {
    validateProjectId(projectId);
    validateAssetId(assetId);
    const paths = assetPaths(projectId, assetId);
    await assertNoSymlinkComponents(fileSystem, rootDirectory, paths.directory);
    let snapshot: DirectorySnapshot;
    try {
      snapshot = await snapshotDirectory(fileSystem, rootDirectory, paths.directory);
    } catch (error) {
      if (isMissing(error)) {
        throw new HttpError(404, 'BODY_ASSET_NOT_FOUND', 'Body Asset metadata was not found');
      }
      if (error instanceof HttpError) throw error;
      throw integrityError();
    }
    return openValidatedAsset(paths, assetId, snapshot);
  }

  async function getMetadataFromSnapshot(
    paths: ReturnType<typeof assetPaths>,
    assetId: string,
    snapshot: DirectorySnapshot,
  ): Promise<BodyAsset> {
    const opened = await openValidatedAsset(paths, assetId, snapshot);
    try {
      await opened.handle.close();
    } catch {
      throw integrityError();
    }
    return opened.metadata;
  }

  async function getMetadata(projectId: string, assetId: string): Promise<BodyAsset> {
    const opened = await openValidatedContent(projectId, assetId);
    try {
      await opened.handle.close();
    } catch {
      throw integrityError();
    }
    return opened.metadata;
  }

  async function beginImport(projectId: string): Promise<BodyImportTransaction> {
    validateProjectId(projectId);
    const projectBodyRoot = bodyRoot(projectId);
    await assertNoSymlinkComponents(fileSystem, rootDirectory, projectBodyRoot);
    await fileSystem.mkdir(projectBodyRoot, { recursive: true });
    const bodySnapshot = await snapshotPutDirectory(projectBodyRoot);
    const bodyGuard = () => verifyDirectorySnapshot(fileSystem, bodySnapshot);
    const stagingDirectory = path.join(projectBodyRoot, `.import-${randomUUID()}`);
    let stagingSnapshot: DirectorySnapshot;

    async function removeFailedSetupDirectory(): Promise<void> {
      await bodyGuard();
      let observed;
      try {
        observed = await fileSystem.lstat(stagingDirectory);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!observed.isDirectory() || observed.isSymbolicLink()) throw integrityError();
      const expected = { dev: observed.dev, ino: observed.ino };
      await bodyGuard();
      const current = await fileSystem.lstat(stagingDirectory);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
        throw integrityError();
      }
      await bodyGuard();
      await fileSystem.rm(stagingDirectory, { recursive: true, force: true });
    }

    try {
      await bodyGuard();
      await fileSystem.mkdir(stagingDirectory, { recursive: true });
      await bodyGuard();
      stagingSnapshot = await snapshotDirectory(fileSystem, rootDirectory, stagingDirectory);
      await verifyDirectorySnapshot(fileSystem, stagingSnapshot);
    } catch (error) {
      try {
        await removeFailedSetupDirectory();
      } catch {
        // Preserve the setup failure.
      }
      throw error;
    }

    const stagingGuard = () => verifyDirectorySnapshot(fileSystem, stagingSnapshot);
    const dispositions = new Map<string, ImportAssetDisposition>();
    const stageReservations = new Map<string, {
      asset: BodyAsset;
      promise: Promise<BodyAsset>;
    }>();
    let lifecycleState: 'active' | 'cleanup-pending' | 'released' = 'active';
    let cleanupIntent: 'undo' | 'release' | undefined;
    let lifecycleTail: Promise<void> = Promise.resolve();
    let stagingRemoved = false;

    const cloneAsset = (asset: BodyAsset): BodyAsset => structuredClone(asset);
    const requireActive = (): void => {
      if (lifecycleState !== 'active') throw new Error('Body import transaction is complete');
    };
    const matchingAsset = (existing: BodyAsset, requested: BodyAsset): BodyAsset => {
      if (!metadataMatches(existing, requested)) throw metadataConflict();
      return existing;
    };

    async function findCanonical(asset: BodyAsset): Promise<BodyAsset | undefined> {
      try {
        return matchingAsset(await getMetadata(projectId, asset.id), asset);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'BODY_ASSET_NOT_FOUND') return undefined;
        throw error;
      }
    }

    async function regularFileIdentity(
      filePath: string,
      snapshot: DirectorySnapshot,
    ): Promise<{ dev: number; ino: number }> {
      await verifyDirectorySnapshot(fileSystem, snapshot);
      const stats = await fileSystem.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw integrityError();
      await verifyDirectorySnapshot(fileSystem, snapshot);
      return { dev: stats.dev, ino: stats.ino };
    }

    async function validateContentFile(
      filePath: string,
      asset: BodyAsset,
      snapshot: DirectorySnapshot,
      expectedIdentity?: { dev: number; ino: number },
    ): Promise<void> {
      if (expectedIdentity
        && !sameIdentity(await regularFileIdentity(filePath, snapshot), expectedIdentity)) {
        throw integrityError();
      }
      const handle = await openRegularFile(filePath, snapshot);
      let operationError: unknown;
      try {
        const actual = await hashHandle(handle);
        await verifyDirectorySnapshot(fileSystem, snapshot);
        if (actual.size !== asset.size || actual.sha256 !== asset.id) throw integrityError();
        if (expectedIdentity
          && !sameIdentity(await regularFileIdentity(filePath, snapshot), expectedIdentity)) {
          throw integrityError();
        }
      } catch (error) {
        operationError = error instanceof HttpError ? error : integrityError();
      } finally {
        try {
          await handle.close();
        } catch {
          if (!operationError) operationError = integrityError();
        }
      }
      if (operationError) throw operationError;
    }

    async function validateMetadataFile(
      filePath: string,
      asset: BodyAsset,
      snapshot: DirectorySnapshot,
      expectedIdentity: { dev: number; ino: number },
    ): Promise<void> {
      if (!sameIdentity(await regularFileIdentity(filePath, snapshot), expectedIdentity)) {
        throw integrityError();
      }
      const handle = await openRegularFile(filePath, snapshot);
      let operationError: unknown;
      try {
        const actual = await handle.readFile();
        await verifyDirectorySnapshot(fileSystem, snapshot);
        if (!actual.equals(Buffer.from(JSON.stringify(asset)))) throw integrityError();
        if (!sameIdentity(await regularFileIdentity(filePath, snapshot), expectedIdentity)) {
          throw integrityError();
        }
      } catch (error) {
        operationError = error instanceof HttpError ? error : integrityError();
      } finally {
        try {
          await handle.close();
        } catch {
          if (!operationError) operationError = integrityError();
        }
      }
      if (operationError) throw operationError;
    }

    async function validateCanonicalContent(
      paths: ReturnType<typeof assetPaths>,
      asset: BodyAsset,
      snapshot: DirectorySnapshot,
      expectedIdentity?: { dev: number; ino: number },
    ): Promise<void> {
      await validateContentFile(paths.content, asset, snapshot, expectedIdentity);
    }

    async function removeOwnedFile(
      filePath: string,
      snapshot: DirectorySnapshot,
      identity: { dev: number; ino: number },
    ): Promise<void> {
      await verifyDirectorySnapshot(fileSystem, snapshot);
      let stats;
      try {
        stats = await fileSystem.lstat(filePath);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(stats, identity)) {
        throw integrityError();
      }
      await verifyDirectorySnapshot(fileSystem, snapshot);
      await fileSystem.rm(filePath, { recursive: true, force: true });
    }

    async function removeOwnedEmptyDirectory(
      directory: string,
      snapshot: DirectorySnapshot,
    ): Promise<void> {
      const parentSnapshot = snapshot.slice(0, -1);
      const expected = snapshot.at(-1)!;
      await verifyDirectorySnapshot(fileSystem, snapshot);
      const entries = await fileSystem.readdir(directory, { withFileTypes: true });
      if (entries.length > 0) return;
      await verifyDirectorySnapshot(fileSystem, parentSnapshot);
      const stats = await fileSystem.lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, expected)) {
        throw integrityError();
      }
      await verifyDirectorySnapshot(fileSystem, parentSnapshot);
      try {
        await fileSystem.rmdir(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }
    }

    async function removeStagingDirectory(): Promise<void> {
      const parentSnapshot = stagingSnapshot.slice(0, -1);
      const expected = stagingSnapshot.at(-1)!;
      await verifyDirectorySnapshot(fileSystem, parentSnapshot);
      let stats;
      try {
        stats = await fileSystem.lstat(stagingDirectory);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, expected)) {
        throw integrityError();
      }
      await verifyDirectorySnapshot(fileSystem, parentSnapshot);
      await fileSystem.rm(stagingDirectory, { recursive: true, force: true });
    }

    async function cleanup(): Promise<void> {
      let cleanupError: unknown;
      if (cleanupIntent === 'undo') {
        const rollbackDispositions = [...dispositions.values()].reverse();
        for (const disposition of rollbackDispositions) {
          if (disposition.metadataPromoted) {
            try {
              await removeOwnedFile(
                assetPaths(projectId, disposition.asset.id).metadata,
                disposition.canonicalSnapshot!,
                disposition.metadataIdentity!,
              );
              disposition.metadataPromoted = false;
            } catch (error) {
              cleanupError ??= error;
            }
          }
          if (disposition.contentPromoted) {
            try {
              await removeOwnedFile(
                assetPaths(projectId, disposition.asset.id).content,
                disposition.canonicalSnapshot!,
                disposition.contentIdentity!,
              );
              disposition.contentPromoted = false;
            } catch (error) {
              cleanupError ??= error;
            }
          }
        }
        for (const disposition of rollbackDispositions) {
          if (disposition.canonicalDirectoryCreated && disposition.canonicalSnapshot) {
            const directory = assetPaths(projectId, disposition.asset.id).directory;
            const directoryHasPendingRemoval = [...dispositions.values()].some(candidate => (
              assetPaths(projectId, candidate.asset.id).directory === directory
              && (candidate.contentPromoted || candidate.metadataPromoted)
            ));
            if (directoryHasPendingRemoval) continue;
            try {
              await removeOwnedEmptyDirectory(directory, disposition.canonicalSnapshot);
              disposition.canonicalDirectoryCreated = false;
            } catch (error) {
              cleanupError ??= error;
            }
          }
        }
      }
      if (!stagingRemoved) {
        try {
          await removeStagingDirectory();
          stagingRemoved = true;
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError) throw cleanupError;
      lifecycleState = 'released';
    }

    function selectCleanup(intent: 'undo' | 'release'): void {
      if (lifecycleState === 'active') {
        lifecycleState = 'cleanup-pending';
        cleanupIntent = intent;
      }
    }

    function enqueueCleanup(intent: 'undo' | 'release'): Promise<void> {
      if (lifecycleState === 'released') return lifecycleTail;
      selectCleanup(intent);
      const operation = lifecycleTail.then(async () => {
        if (lifecycleState !== 'released') await cleanup();
      });
      lifecycleTail = operation.then(() => undefined, () => undefined);
      return operation;
    }

    async function stageStream(
      source: NodeJS.ReadableStream,
      expected: { sha256: string; byteCount: number },
      metadata: PutBodyMetadata,
    ): Promise<BodyAsset> {
      const discardSource = (): void => {
        const destroy = (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy;
        destroy?.call(source);
      };
      try {
        requireActive();
        if (!SHA256_PATTERN.test(expected.sha256)
          || !Number.isSafeInteger(expected.byteCount)
          || expected.byteCount < 0) {
          throw integrityError();
        }
        const normalizedMetadata = normalizeRequestedMetadata(metadata);
        const asset: BodyAsset = {
          schemaVersion: 4,
          id: expected.sha256,
          mediaType: normalizedMetadata.mediaType,
          size: expected.byteCount,
          ...(normalizedMetadata.encoding === undefined ? {} : { encoding: normalizedMetadata.encoding }),
          createdAt: new Date().toISOString(),
        };
        if (!BodyAssetSchema.safeParse(asset).success) {
          throw new HttpError(422, 'INVALID_BODY_METADATA', 'Body Asset metadata is invalid');
        }

        const staged = dispositions.get(asset.id);
        if (staged) {
          const result = cloneAsset(matchingAsset(staged.asset, asset));
          discardSource();
          return result;
        }

        const reserved = stageReservations.get(asset.id);
        if (reserved) {
          matchingAsset(reserved.asset, asset);
          discardSource();
          return cloneAsset(await reserved.promise);
        }

        let sourceConsumed = false;
        const operation = (async (): Promise<BodyAsset> => {
          const canonical = await findCanonical(asset);
          if (canonical) {
            dispositions.set(asset.id, {
              asset: canonical,
              contentPromoted: false,
              metadataPromoted: false,
              preExisting: true,
            });
            discardSource();
            return canonical;
          }

          const contentStagingPath = path.join(stagingDirectory, asset.id);
          const metadataStagingPath = path.join(stagingDirectory, `${asset.id}.json`);
          await stagingGuard();
          sourceConsumed = true;
          const written = await atomicWriter.writeStream(contentStagingPath, source, stagingGuard);
          if (written.sha256 !== asset.id || written.size !== asset.size) throw integrityError();
          await stagingGuard();
          await atomicWriter.writeStream(
            metadataStagingPath,
            Readable.from([Buffer.from(JSON.stringify(asset))]),
            stagingGuard,
          );
          await stagingGuard();
          dispositions.set(asset.id, {
            asset,
            contentStagingPath,
            metadataStagingPath,
            contentStagingIdentity: await regularFileIdentity(contentStagingPath, stagingSnapshot),
            metadataStagingIdentity: await regularFileIdentity(metadataStagingPath, stagingSnapshot),
            contentPromoted: false,
            metadataPromoted: false,
            preExisting: false,
          });
          return asset;
        })();
        const reservation = { asset, promise: operation };
        stageReservations.set(asset.id, reservation);
        try {
          return cloneAsset(await operation);
        } catch (error) {
          if (stageReservations.get(asset.id) === reservation) stageReservations.delete(asset.id);
          if (!sourceConsumed) discardSource();
          throw error;
        }
      } catch (error) {
        discardSource();
        throw error;
      }
    }

    return {
      stage(bytes, metadata): Promise<BodyAsset> {
        return stageStream(
          Readable.from([bytes]),
          { sha256: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length },
          metadata,
        );
      },

      stageStream,

      async getMetadata(assetId): Promise<BodyAsset> {
        requireActive();
        validateAssetId(assetId);
        const staged = dispositions.get(assetId);
        return staged ? cloneAsset(staged.asset) : cloneAsset(await getMetadata(projectId, assetId));
      },

      async promote(): Promise<void> {
        requireActive();
        for (const disposition of dispositions.values()) {
          if (disposition.preExisting || disposition.metadataPromoted) continue;

          if (!disposition.contentPromoted) {
            const canonical = await findCanonical(disposition.asset);
            if (canonical) {
              disposition.asset = canonical;
              disposition.preExisting = true;
              continue;
            }
          }

          const paths = assetPaths(projectId, disposition.asset.id);
          await assertNoSymlinkComponents(fileSystem, rootDirectory, paths.directory);
          const createdDirectory = await fileSystem.mkdir(paths.directory, { recursive: true });
          const assetSnapshot = await snapshotPutDirectory(paths.directory);
          const assetGuard = () => verifyDirectorySnapshot(fileSystem, assetSnapshot);
          disposition.canonicalSnapshot = assetSnapshot;
          disposition.canonicalDirectoryCreated = createdDirectory !== undefined;

          await validateContentFile(
            disposition.contentStagingPath!,
            disposition.asset,
            stagingSnapshot,
            disposition.contentStagingIdentity!,
          );
          await validateMetadataFile(
            disposition.metadataStagingPath!,
            disposition.asset,
            stagingSnapshot,
            disposition.metadataStagingIdentity!,
          );

          if (!disposition.contentPromoted) {
            try {
              await validateContentFile(
                disposition.contentStagingPath!,
                disposition.asset,
                stagingSnapshot,
                disposition.contentStagingIdentity!,
              );
              await stagingGuard();
              await assetGuard();
              await fileSystem.link(disposition.contentStagingPath!, paths.content);
              disposition.contentPromoted = true;
              disposition.contentIdentity = disposition.contentStagingIdentity;
              const canonicalIdentity = await regularFileIdentity(paths.content, assetSnapshot);
              disposition.contentIdentity = canonicalIdentity;
              if (!sameIdentity(canonicalIdentity, disposition.contentStagingIdentity!)) {
                throw integrityError();
              }
              if (!sameIdentity(
                await regularFileIdentity(disposition.contentStagingPath!, stagingSnapshot),
                disposition.contentStagingIdentity!,
              )) throw integrityError();
              await validateCanonicalContent(
                paths,
                disposition.asset,
                assetSnapshot,
                canonicalIdentity,
              );
              await stagingGuard();
              await assetGuard();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              await validateCanonicalContent(paths, disposition.asset, assetSnapshot);
            }
          }

          const concurrent = await findCanonical(disposition.asset);
          if (concurrent) {
            disposition.asset = concurrent;
            disposition.contentPromoted = false;
            disposition.preExisting = true;
            continue;
          }

          try {
            await validateMetadataFile(
              disposition.metadataStagingPath!,
              disposition.asset,
              stagingSnapshot,
              disposition.metadataStagingIdentity!,
            );
            await stagingGuard();
            await assetGuard();
            await fileSystem.link(disposition.metadataStagingPath!, paths.metadata);
            disposition.metadataPromoted = true;
            disposition.metadataIdentity = disposition.metadataStagingIdentity;
            const canonicalIdentity = await regularFileIdentity(paths.metadata, assetSnapshot);
            disposition.metadataIdentity = canonicalIdentity;
            if (!sameIdentity(canonicalIdentity, disposition.metadataStagingIdentity!)) {
              throw integrityError();
            }
            if (!sameIdentity(
              await regularFileIdentity(disposition.metadataStagingPath!, stagingSnapshot),
              disposition.metadataStagingIdentity!,
            )) throw integrityError();
            await validateMetadataFile(
              paths.metadata,
              disposition.asset,
              assetSnapshot,
              canonicalIdentity,
            );
            await stagingGuard();
            await assetGuard();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            disposition.asset = matchingAsset(
              await getMetadataFromSnapshot(paths, disposition.asset.id, assetSnapshot),
              disposition.asset,
            );
            disposition.contentPromoted = false;
            disposition.preExisting = true;
          }

          await validateCanonicalContent(
            paths,
            disposition.asset,
            assetSnapshot,
            disposition.contentPromoted ? disposition.contentIdentity : undefined,
          );
          if (disposition.metadataPromoted) {
            await validateMetadataFile(
              paths.metadata,
              disposition.asset,
              assetSnapshot,
              disposition.metadataIdentity!,
            );
          }
        }
      },

      async rollback(): Promise<void> {
        await enqueueCleanup('undo');
      },

      async complete(): Promise<void> {
        await enqueueCleanup('release');
      },
    };
  }

  return {
    async put(projectId, source, metadata, policy): Promise<BodyAsset> {
      validateProjectId(projectId);
      const normalizedMetadata = normalizeRequestedMetadata(metadata);
      if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
        throw new HttpError(400, 'INVALID_BODY_POLICY', 'Body size policy must be a positive safe integer');
      }

      const projectBodyRoot = bodyRoot(projectId);
      await assertNoSymlinkComponents(fileSystem, rootDirectory, projectBodyRoot);
      await fileSystem.mkdir(projectBodyRoot, { recursive: true });
      const stagingSnapshot = await snapshotPutDirectory(projectBodyRoot);
      const stagingGuard = () => verifyDirectorySnapshot(fileSystem, stagingSnapshot);
      const staging = path.join(projectBodyRoot, `.incoming-${randomUUID()}`);
      let stagingExists = false;

      try {
        const written = await atomicWriter.writeStream(
          staging,
          limitedSource(source, policy.maxBytes),
          stagingGuard,
        );
        stagingExists = true;
        if (isJsonMediaType(normalizedMetadata.mediaType)) {
          await validateJsonFile(fileSystem, staging, stagingGuard);
        }

        const asset: BodyAsset = {
          schemaVersion: 4,
          id: written.sha256,
          mediaType: normalizedMetadata.mediaType,
          size: written.size,
          ...(normalizedMetadata.encoding === undefined ? {} : { encoding: normalizedMetadata.encoding }),
          createdAt: new Date().toISOString(),
        };
        const parsedAsset = BodyAssetSchema.safeParse(asset);
        if (!parsedAsset.success) {
          throw new HttpError(422, 'INVALID_BODY_METADATA', 'Body Asset metadata is invalid');
        }

        const paths = assetPaths(projectId, asset.id);
        await assertNoSymlinkComponents(fileSystem, rootDirectory, paths.directory);
        await fileSystem.mkdir(paths.directory, { recursive: true });
        const assetSnapshot = await snapshotPutDirectory(paths.directory);
        const assetGuard = () => verifyDirectorySnapshot(fileSystem, assetSnapshot);
        const promotionGuard = async () => {
          await stagingGuard();
          await assetGuard();
        };

        let contentExists = false;
        try {
          await assetGuard();
          const contentStat = await fileSystem.lstat(paths.content);
          await assetGuard();
          if (!contentStat.isFile() || contentStat.isSymbolicLink()) throw integrityError();
          contentExists = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (contentExists) {
          const existingHandle = await openRegularFile(paths.content, assetSnapshot);
          let operationError: unknown;
          try {
            const actual = await hashHandle(existingHandle);
            await assetGuard();
            if (actual.size !== asset.size || actual.sha256 !== asset.id) throw integrityError();
          } catch (error) {
            operationError = error instanceof HttpError ? error : integrityError();
          } finally {
            try {
              await existingHandle.close();
            } catch {
              if (!operationError) operationError = integrityError();
            }
          }
          if (operationError) throw operationError;
        } else {
          await promotionGuard();
          await fileSystem.rename(staging, paths.content);
          await promotionGuard();
          stagingExists = false;
        }

        try {
          const existing = await getMetadataFromSnapshot(paths, asset.id, assetSnapshot);
          if (!metadataMatches(existing, asset)) {
            throw new HttpError(
              409,
              'ASSET_METADATA_CONFLICT',
              'Immutable Body Asset metadata conflicts with the requested metadata',
            );
          }
          return existing;
        } catch (error) {
          if (!(error instanceof HttpError) || error.code !== 'BODY_ASSET_NOT_FOUND') throw error;
        }

        if (await atomicWriter.writeJsonIfAbsent(paths.metadata, asset, assetGuard)) return asset;

        const existing = await getMetadataFromSnapshot(paths, asset.id, assetSnapshot);
        if (!metadataMatches(existing, asset)) {
          throw new HttpError(
            409,
            'ASSET_METADATA_CONFLICT',
            'Immutable Body Asset metadata conflicts with the requested metadata',
          );
        }
        return existing;
      } finally {
        if (stagingExists) {
          try {
            await stagingGuard();
            await fileSystem.unlink(staging);
          } catch {
            // Preserve the operation error; AtomicFileWriter already cleaned its sibling temp.
          }
        }
      }
    },

    getMetadata,

    beginImport,

    openReadStream(projectId, assetId, range = {}): NodeJS.ReadableStream {
      return Readable.from((async function* () {
        let handle: FileHandle | undefined;
        let operationError: unknown;
        try {
          const opened = await openValidatedContent(projectId, assetId);
          handle = opened.handle;
          const { metadata } = opened;
          const { start, end } = range;
          if (metadata.size !== 0 || start !== undefined || end !== undefined) {
            const validStart = start === undefined || (Number.isSafeInteger(start) && start >= 0);
            const validEnd = end === undefined || (Number.isSafeInteger(end) && end >= 0);
            const resolvedStart = start ?? 0;
            const resolvedEnd = end ?? metadata.size - 1;
            if (!validStart
              || !validEnd
              || resolvedStart > resolvedEnd
              || resolvedStart >= metadata.size
              || resolvedEnd >= metadata.size) {
              throw new HttpError(416, 'INVALID_BODY_RANGE', 'Body Asset byte range is invalid');
            }

            const stream = handle.createReadStream({
              start: resolvedStart,
              end: resolvedEnd,
              autoClose: false,
            });
            for await (const chunk of stream) yield chunk;
          }
        } catch (error) {
          operationError = error instanceof HttpError ? error : integrityError();
        } finally {
          if (handle) {
            try {
              await handle.close();
            } catch {
              if (!operationError) operationError = integrityError();
            }
          }
        }
        if (operationError) throw operationError;
      })());
    },
  };
}
