import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { normalizeContentEncoding } from '../domain/http-metadata';
import type { TrafficBodyDescriptor } from '../domain/traffic';
import type { FileSystem } from '../repository/file-system';
import { isStablePathSegment } from './storage';
import type {
  TrafficBodyBudgetManager,
  TrafficBodyBudgetReservation,
} from './traffic-body-budget';

export interface TrafficBodyLease {
  projectId: string;
  sha256: string;
  byteCount: number;
  openStream(): NodeJS.ReadableStream;
  release(): Promise<void>;
}

export interface TrafficBodyCache {
  initialize(): Promise<void>;
  finalize(input: {
    projectId: string;
    trafficId: string;
    generation: string;
    side: 'request' | 'response';
    temporaryPath?: string;
    sha256: string;
    byteCount: number;
    mediaType?: string;
    contentEncoding?: string;
  }): Promise<TrafficBodyDescriptor>;
  attach(
    projectId: string,
    trafficId: string,
    generation: string,
    side: 'request' | 'response',
    descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>,
  ): Promise<boolean>;
  acquire(
    projectId: string,
    trafficId: string,
    generation: string,
    side: 'request' | 'response',
  ): Promise<TrafficBodyLease | undefined>;
  releaseBody(
    projectId: string,
    trafficId: string,
    generation: string,
    side: 'request' | 'response',
  ): Promise<void>;
  releaseRow(projectId: string, trafficId: string, generation: string): Promise<void>;
  clearProject(projectId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface TrafficBodyDescriptorPublication {
  projectId: string;
  trafficId: string;
  generation: string;
  side: 'request' | 'response';
  descriptor: TrafficBodyDescriptor;
}

interface TrafficBodyCacheBaseOptions {
  rootDirectory: string;
  runtimeNamespace: string;
  budgets: TrafficBodyBudgetManager;
  fileSystem: FileSystem;
}

type TrafficBodyDescriptorPublisher = (
  publication: TrafficBodyDescriptorPublication,
  signal: AbortSignal,
) => Promise<boolean> | boolean;

type TrafficBodyDescriptorPublicationErrorOwner = (
  publication: TrafficBodyDescriptorPublication,
  error: unknown,
) => Promise<void> | void;

export type TrafficBodyCacheOptions = TrafficBodyCacheBaseOptions & (
  | {
    publishDescriptor?: undefined;
    onDescriptorPublicationError?: undefined;
  }
  | {
    publishDescriptor: TrafficBodyDescriptorPublisher;
    onDescriptorPublicationError: TrafficBodyDescriptorPublicationErrorOwner;
  }
);

type TrafficBodyFinalizeInput = Parameters<TrafficBodyCache['finalize']>[0];

interface TrafficBodyCacheInternals {
  openTemporary(signal: AbortSignal): Promise<{ temporaryPath: string; handle: FileHandle }>;
  finalizeReservations: WeakMap<object, TrafficBodyBudgetReservation>;
  finalizeSignals: WeakMap<object, AbortSignal>;
  discard(temporaryPath: string): Promise<void>;
  registerCapture(
    identity: { projectId: string; trafficId: string; generation: string },
    abort: () => void,
  ): () => void;
}

const cacheInternals = new WeakMap<TrafficBodyCache, TrafficBodyCacheInternals>();

function internalsFor(cache: TrafficBodyCache): TrafficBodyCacheInternals {
  const internals = cacheInternals.get(cache);
  if (internals === undefined) throw new Error('Traffic body cache implementation is unsupported');
  return internals;
}

export function openTrafficBodyTemporary(
  cache: TrafficBodyCache,
  signal: AbortSignal,
): Promise<{ temporaryPath: string; handle: FileHandle }> {
  return internalsFor(cache).openTemporary(signal);
}

export function finalizeTrafficBodyTemporary(
  cache: TrafficBodyCache,
  input: TrafficBodyFinalizeInput,
  reservation: TrafficBodyBudgetReservation,
  signal: AbortSignal,
): Promise<TrafficBodyDescriptor> {
  const internals = internalsFor(cache);
  internals.finalizeReservations.set(input, reservation);
  internals.finalizeSignals.set(input, signal);
  return cache.finalize(input);
}

export function discardTrafficBodyTemporary(
  cache: TrafficBodyCache,
  temporaryPath: string,
): Promise<void> {
  return internalsFor(cache).discard(temporaryPath);
}

export function registerTrafficBodyCapture(
  cache: TrafficBodyCache,
  identity: { projectId: string; trafficId: string; generation: string },
  abort: () => void,
): () => void {
  return internalsFor(cache).registerCapture(identity, abort);
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface BodyReference {
  key: string;
  projectId: string;
  trafficId: string;
  generation: string;
  side: 'request' | 'response';
  descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>;
  sequence: number;
}

interface CacheEntry {
  projectId: string;
  sha256: string;
  byteCount: number;
  filePath?: string;
  identity?: { dev: number; ino: number };
  disposalOnly?: boolean;
  references: Set<string>;
  leases: number;
  deletePending: boolean;
}

interface PublishedFile {
  filePath: string;
  identity: { dev: number; ino: number };
}

class LinkedFileOwnershipError extends Error {
  constructor(
    readonly filePath: string,
    readonly identity: { dev: number; ino: number } | undefined,
    readonly disposalOnly = false,
  ) {
    super('Traffic body cache linked-file cleanup remains owned');
  }
}

interface FinalizeResult {
  descriptor: TrafficBodyDescriptor;
  publications: TrafficBodyDescriptorPublication[];
}

interface ActiveCapture {
  projectId: string;
  rowKey: string;
  settled: { promise: Promise<void>; resolve(): void };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CAPTURE_NAME_PATTERN = /^\.capture-[a-zA-Z0-9-]+$/;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EISDIR',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

function integrityError(): Error {
  return new Error('Traffic body cache integrity check failed');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code);
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function referenceKey(
  projectId: string,
  trafficId: string,
  generation: string,
  side: 'request' | 'response',
): string {
  return `${projectId}\0${trafficId}\0${generation}\0${side}`;
}

function rowKey(projectId: string, trafficId: string, generation: string): string {
  return `${projectId}\0${trafficId}\0${generation}`;
}

function safeContentEncoding(input: string | undefined): string | undefined {
  try {
    return normalizeContentEncoding(input);
  } catch {
    return undefined;
  }
}

function unavailable(
  input: {
    side: 'request' | 'response';
    byteCount: number;
    mediaType?: string;
    contentEncoding?: string;
  },
  reason: Extract<TrafficBodyDescriptor, { state: 'unavailable' }>['reason'],
): TrafficBodyDescriptor {
  const contentEncoding = safeContentEncoding(input.contentEncoding);
  return {
    side: input.side,
    state: 'unavailable',
    observedSize: input.byteCount,
    reason,
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(contentEncoding === undefined ? {} : { contentEncoding }),
  };
}

export function createTrafficBodyCache(options: TrafficBodyCacheOptions): TrafficBodyCache {
  if (options.publishDescriptor !== undefined
    && options.onDescriptorPublicationError === undefined) {
    throw new Error('Traffic body descriptor publication error owner is required');
  }
  const {
    rootDirectory,
    runtimeNamespace,
    budgets,
    fileSystem,
    publishDescriptor = () => true,
    onDescriptorPublicationError,
  } = options;
  const root = path.resolve(rootDirectory);
  const cacheRoot = path.join(root, 'traffic-cache');
  const incomingRoot = path.join(cacheRoot, 'incoming');
  const projectsRoot = path.join(cacheRoot, 'projects');
  const projects = new Map<string, Map<string, CacheEntry>>();
  const references = new Map<string, BodyReference>();
  const tombstonedRows = new Set<string>();
  let sequence = 0;
  let initialized = false;
  let disposing = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let operationTail = Promise.resolve();
  let publicationTail = Promise.resolve();
  let activeLeases = 0;
  let leasesReleased = deferred();
  const activeCaptures = new Map<() => void, ActiveCapture>();
  const activeCaptureRows = new Map<string, number>();
  const finalizeReservations = new WeakMap<object, TrafficBodyBudgetReservation>();
  const finalizeSignals = new WeakMap<object, AbortSignal>();
  const disposalCancellation = new AbortController();

  function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>(settle => { resolve = settle; });
    return { promise, resolve };
  }

  function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = operationTail.then(operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function requireAvailable(): void {
    if (!initialized || disposing || disposed) throw new Error('Traffic body cache is unavailable');
  }

  function assertContained(candidate: string): void {
    const relative = path.relative(root, path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw integrityError();
    }
  }

  async function snapshotDirectory(directory: string): Promise<DirectoryIdentity[]> {
    assertContained(directory);
    const relative = path.relative(root, path.resolve(directory));
    const paths = [root];
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      paths.push(current);
    }
    const snapshot: DirectoryIdentity[] = [];
    for (const directoryPath of paths) {
      const stats = await fileSystem.lstat(directoryPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw integrityError();
      snapshot.push({ path: directoryPath, dev: stats.dev, ino: stats.ino });
    }
    return snapshot;
  }

  async function verifySnapshot(snapshot: readonly DirectoryIdentity[]): Promise<void> {
    try {
      for (const expected of snapshot) {
        const actual = await fileSystem.lstat(expected.path);
        if (!actual.isDirectory()
          || actual.isSymbolicLink()
          || !sameIdentity(actual, expected)) throw integrityError();
      }
    } catch {
      throw integrityError();
    }
  }

  async function assertNoSymlinkComponents(candidate: string): Promise<void> {
    assertContained(candidate);
    const relative = path.relative(root, path.resolve(candidate));
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stats = await fileSystem.lstat(current);
        if (stats.isSymbolicLink()) throw integrityError();
        if (!stats.isDirectory() && current !== candidate) throw integrityError();
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
  }

  async function syncDirectory(directory: string, snapshot: readonly DirectoryIdentity[]): Promise<void> {
    await verifySnapshot(snapshot);
    let handle: FileHandle;
    try {
      handle = await fileSystem.open(directory, fsConstants.O_RDONLY);
    } catch (error) {
      if (isUnsupportedDirectorySync(error)) {
        await verifySnapshot(snapshot);
        return;
      }
      throw integrityError();
    }
    let operationError: unknown;
    try {
      const stats = await handle.stat();
      if (!stats.isDirectory()) throw integrityError();
      try {
        await handle.sync();
      } catch (error) {
        if (!isUnsupportedDirectorySync(error)) operationError = error;
      }
    } catch (error) {
      operationError ??= error;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        operationError ??= error;
      }
    }
    if (operationError) throw integrityError();
    await verifySnapshot(snapshot);
  }

  function projectEntries(projectId: string): Map<string, CacheEntry> {
    let entries = projects.get(projectId);
    if (entries === undefined) {
      entries = new Map();
      projects.set(projectId, entries);
    }
    return entries;
  }

  function canonicalPath(projectId: string, sha256: string): string {
    return path.join(
      projectsRoot,
      projectId,
      'sha256',
      sha256.slice(0, 2),
      sha256,
    );
  }

  function validateIdentity(projectId: string, sha256: string, byteCount: number): void {
    if (!isStablePathSegment(projectId)
      || !SHA256_PATTERN.test(sha256)
      || !Number.isSafeInteger(byteCount)
      || byteCount < 0) throw integrityError();
  }

  function validateTemporaryPath(temporaryPath: string): void {
    const resolved = path.resolve(temporaryPath);
    if (path.dirname(resolved) !== incomingRoot
      || !CAPTURE_NAME_PATTERN.test(path.basename(resolved))) throw integrityError();
  }

  async function hashHandle(handle: FileHandle): Promise<{ sha256: string; byteCount: number }> {
    const hash = createHash('sha256');
    let byteCount = 0;
    const stream = handle.createReadStream({ start: 0, autoClose: false });
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteCount += bytes.length;
    }
    return { sha256: hash.digest('hex'), byteCount };
  }

  async function openValidatedFile(
    filePath: string,
    directorySnapshot: readonly DirectoryIdentity[],
    sha256: string,
    byteCount: number,
    sync: boolean,
    expectedIdentity?: { dev: number; ino: number },
  ): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      await verifySnapshot(directorySnapshot);
      const pathStats = await fileSystem.lstat(filePath);
      if (!pathStats.isFile()
        || pathStats.isSymbolicLink()
        || (expectedIdentity !== undefined && !sameIdentity(pathStats, expectedIdentity))) {
        throw integrityError();
      }
      await verifySnapshot(directorySnapshot);
      handle = await fileSystem.open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
      );
      const handleStats = await handle.stat();
      if (!handleStats.isFile()
        || !sameIdentity(handleStats, pathStats)
        || (expectedIdentity !== undefined && !sameIdentity(handleStats, expectedIdentity))) {
        throw integrityError();
      }
      if (sync) await handle.sync();
      const actual = await hashHandle(handle);
      await verifySnapshot(directorySnapshot);
      if (actual.sha256 !== sha256 || actual.byteCount !== byteCount) throw integrityError();
      return handle;
    } catch {
      await handle?.close().catch(() => undefined);
      throw integrityError();
    }
  }

  async function openLinkedCanonical(
    filePath: string,
    directorySnapshot: readonly DirectoryIdentity[],
    sha256: string,
    byteCount: number,
    expectedIdentity: { dev: number; ino: number },
  ): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      await verifySnapshot(directorySnapshot);
      handle = await fileSystem.open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
      );
      const handleStats = await handle.stat();
      if (!handleStats.isFile() || !sameIdentity(handleStats, expectedIdentity)) {
        throw integrityError();
      }
      const identity = { dev: handleStats.dev, ino: handleStats.ino };
      const pathStats = await fileSystem.lstat(filePath);
      if (!pathStats.isFile()
        || pathStats.isSymbolicLink()
        || !sameIdentity(pathStats, identity)) throw integrityError();
      await verifySnapshot(directorySnapshot);
      const actual = await hashHandle(handle);
      await verifySnapshot(directorySnapshot);
      if (actual.sha256 !== sha256 || actual.byteCount !== byteCount) throw integrityError();
      return handle;
    } catch {
      await handle?.close().catch(() => undefined);
      throw integrityError();
    }
  }

  async function safeUnlinkTemporary(temporaryPath: string | undefined): Promise<void> {
    if (temporaryPath === undefined) return;
    try {
      validateTemporaryPath(temporaryPath);
      const snapshot = await snapshotDirectory(incomingRoot);
      const stats = await fileSystem.lstat(temporaryPath);
      if (!stats.isFile() || stats.isSymbolicLink()) return;
      await verifySnapshot(snapshot);
      await fileSystem.unlink(temporaryPath);
    } catch {
      // Cleanup never follows or reports an untrusted path.
    }
  }

  async function openTemporary(signal: AbortSignal): Promise<{ temporaryPath: string; handle: FileHandle }> {
    requireAvailable();
    if (signal.aborted) throw signal.reason;
    const temporaryPath = path.join(incomingRoot, `.capture-${randomUUID()}`);
    const snapshot = await snapshotDirectory(incomingRoot);
    let handle: FileHandle | undefined;
    try {
      await verifySnapshot(snapshot);
      handle = await fileSystem.open(
        temporaryPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
        signal,
      );
      if (signal.aborted) throw signal.reason;
      await verifySnapshot(snapshot);
      const stats = await handle.stat();
      if (!stats.isFile()) throw integrityError();
      return { temporaryPath, handle };
    } catch {
      await handle?.close().catch(() => undefined);
      await safeUnlinkTemporary(temporaryPath);
      throw integrityError();
    }
  }

  async function publishFile(
    projectId: string,
    sha256: string,
    byteCount: number,
    temporaryPath: string,
  ): Promise<PublishedFile> {
    validateTemporaryPath(temporaryPath);
    const temporarySnapshot = await snapshotDirectory(incomingRoot);
    const temporaryHandle = await openValidatedFile(
      temporaryPath,
      temporarySnapshot,
      sha256,
      byteCount,
      true,
    );
    let temporaryHandleCloseAttempted = false;

    try {
      const temporaryStats = await temporaryHandle.stat();
      if (!temporaryStats.isFile()) throw integrityError();
      const temporaryIdentity = { dev: temporaryStats.dev, ino: temporaryStats.ino };
      const filePath = canonicalPath(projectId, sha256);
      const directory = path.dirname(filePath);
      await assertNoSymlinkComponents(directory);
      await fileSystem.mkdir(directory, { recursive: true });
      const destinationSnapshot = await snapshotDirectory(directory);
      await verifySnapshot(temporarySnapshot);
      await verifySnapshot(destinationSnapshot);
      let linked = false;
      let canonicalIdentity: { dev: number; ino: number } | undefined;
      let sourceCorrelationUnavailable = false;
      try {
        try {
          await fileSystem.link(temporaryPath, filePath);
          linked = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw integrityError();
          const existing = await openValidatedFile(
            filePath,
            destinationSnapshot,
            sha256,
            byteCount,
            false,
          );
          const existingStats = await existing.stat();
          canonicalIdentity = { dev: existingStats.dev, ino: existingStats.ino };
          await existing.close().catch(() => { throw integrityError(); });
        }
        if (linked) {
          const canonical = await openLinkedCanonical(
            filePath,
            destinationSnapshot,
            sha256,
            byteCount,
            temporaryIdentity,
          );
          try {
            let linkedSourceStats;
            try {
              linkedSourceStats = await fileSystem.lstat(temporaryPath);
            } catch {
              sourceCorrelationUnavailable = true;
              throw integrityError();
            }
            if (!linkedSourceStats.isFile() || linkedSourceStats.isSymbolicLink()) {
              sourceCorrelationUnavailable = true;
              throw integrityError();
            }
            if (!sameIdentity(linkedSourceStats, temporaryIdentity)) throw integrityError();
          } finally {
            await canonical.close().catch(() => { throw integrityError(); });
          }
        }
        await verifySnapshot(temporarySnapshot);
        await verifySnapshot(destinationSnapshot);
        await syncDirectory(directory, destinationSnapshot);
        await fileSystem.unlink(temporaryPath);
        temporaryHandleCloseAttempted = true;
        await temporaryHandle.close().catch(() => { throw integrityError(); });
        return {
          filePath,
          identity: linked ? temporaryIdentity : canonicalIdentity!,
        };
      } catch {
        if (linked) {
          if (sourceCorrelationUnavailable) {
            throw new LinkedFileOwnershipError(filePath, temporaryIdentity, true);
          }
          try {
            await verifySnapshot(destinationSnapshot);
          } catch {
            throw new LinkedFileOwnershipError(filePath, temporaryIdentity);
          }
          let current;
          try {
            current = await fileSystem.lstat(filePath);
          } catch (error) {
            if (!isMissing(error)) {
              throw new LinkedFileOwnershipError(filePath, temporaryIdentity);
            }
          }
          if (current !== undefined
            && current.isFile()
            && !current.isSymbolicLink()
            && sameIdentity(current, temporaryIdentity)) {
            try {
              await fileSystem.unlink(filePath);
            } catch (error) {
              if (!isMissing(error)) {
                throw new LinkedFileOwnershipError(filePath, temporaryIdentity);
              }
            }
          }
        }
        throw integrityError();
      }
    } finally {
      if (!temporaryHandleCloseAttempted) {
        temporaryHandleCloseAttempted = true;
        await temporaryHandle.close().catch(() => undefined);
      }
    }
  }

  async function verifyTemporary(input: TrafficBodyFinalizeInput): Promise<void> {
    if (input.byteCount === 0) {
      if (input.sha256 !== createHash('sha256').digest('hex')) throw integrityError();
      return;
    }
    if (input.temporaryPath === undefined) throw integrityError();
    validateTemporaryPath(input.temporaryPath);
    const snapshot = await snapshotDirectory(incomingRoot);
    const handle = await openValidatedFile(
      input.temporaryPath,
      snapshot,
      input.sha256,
      input.byteCount,
      true,
    );
    await handle.close().catch(() => { throw integrityError(); });
  }

  function evictedDescriptor(
    descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>,
  ): Extract<TrafficBodyDescriptor, { state: 'evicted' }> {
    return {
      ...descriptor,
      state: 'evicted',
      reason: 'retention_evicted',
    };
  }

  async function deleteEntry(entry: CacheEntry): Promise<boolean> {
    if (entry.references.size > 0 || entry.leases > 0) {
      entry.deletePending = true;
      return false;
    }
    if (entry.filePath !== undefined) {
      if (entry.identity === undefined || entry.disposalOnly) {
        entry.deletePending = true;
        return false;
      }
      const directory = path.dirname(entry.filePath);
      try {
        const snapshot = await snapshotDirectory(directory);
        const stats = await fileSystem.lstat(entry.filePath);
        if (!stats.isFile()
          || stats.isSymbolicLink()
          || (entry.identity !== undefined && !sameIdentity(stats, entry.identity))) {
          throw integrityError();
        }
        await verifySnapshot(snapshot);
        await fileSystem.unlink(entry.filePath);
      } catch (error) {
        if (!isMissing(error)) {
          entry.deletePending = true;
          return false;
        }
      }
    }
    projects.get(entry.projectId)?.delete(entry.sha256);
    if (projects.get(entry.projectId)?.size === 0) projects.delete(entry.projectId);
    budgets.releaseRetained(runtimeNamespace, entry.projectId, entry.sha256, entry.byteCount);
    return true;
  }

  async function reclaimPendingEntries(projectId: string): Promise<boolean> {
    const entries = projects.get(projectId);
    if (entries === undefined) return true;
    for (const entry of [...entries.values()]) {
      if (entry.deletePending
        && entry.references.size === 0
        && entry.leases === 0
        && !await deleteEntry(entry)) return false;
    }
    return true;
  }

  async function detachReference(reference: BodyReference): Promise<boolean> {
    if (references.get(reference.key) !== reference) return true;
    references.delete(reference.key);
    const entry = projects.get(reference.projectId)?.get(reference.descriptor.sha256);
    if (entry === undefined) return true;
    entry.references.delete(reference.key);
    if (entry.references.size === 0) {
      if (entry.leases > 0) {
        entry.deletePending = true;
        return true;
      }
      return deleteEntry(entry);
    }
    return true;
  }

  function oldestEvictionCandidate(projectId: string): BodyReference | undefined {
    let oldest: BodyReference | undefined;
    for (const reference of references.values()) {
      if (reference.projectId !== projectId) continue;
      const entry = projects.get(projectId)?.get(reference.descriptor.sha256);
      if (entry === undefined || entry.leases > 0) continue;
      if (oldest === undefined || reference.sequence < oldest.sequence) oldest = reference;
    }
    return oldest;
  }

  function addReference(
    input: {
      projectId: string;
      trafficId: string;
      generation: string;
      side: 'request' | 'response';
    },
    descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>,
    entry: CacheEntry,
  ): boolean {
    if (tombstonedRows.has(rowKey(input.projectId, input.trafficId, input.generation))) return false;
    const key = referenceKey(input.projectId, input.trafficId, input.generation, input.side);
    const existing = references.get(key);
    if (existing !== undefined) return existing.descriptor.sha256 === descriptor.sha256;
    const reference: BodyReference = {
      key,
      projectId: input.projectId,
      trafficId: input.trafficId,
      generation: input.generation,
      side: input.side,
      descriptor: { ...descriptor },
      sequence: ++sequence,
    };
    references.set(key, reference);
    entry.references.add(key);
    entry.deletePending = false;
    return true;
  }

  async function scanStartupTree(directory: string): Promise<void> {
    const entries = await fileSystem.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stats = await fileSystem.lstat(candidate);
      if (stats.isSymbolicLink()) throw integrityError();
      if (stats.isDirectory()) {
        await scanStartupTree(candidate);
        continue;
      }
      if (!stats.isFile()) throw integrityError();
      const relative = path.relative(cacheRoot, candidate).split(path.sep);
      const validIncoming = relative.length === 2
        && relative[0] === 'incoming'
        && CAPTURE_NAME_PATTERN.test(relative[1]);
      const validBody = relative.length === 5
        && relative[0] === 'projects'
        && isStablePathSegment(relative[1])
        && relative[2] === 'sha256'
        && /^[a-f0-9]{2}$/.test(relative[3])
        && SHA256_PATTERN.test(relative[4] ?? '')
        && relative[3] === relative[4]?.slice(0, 2);
      if (!validIncoming && !validBody) throw integrityError();
    }
  }

  async function removeCacheRoot(): Promise<void> {
    const rootSnapshot = await snapshotDirectory(root);
    let stats;
    try {
      stats = await fileSystem.lstat(cacheRoot);
    } catch (error) {
      if (isMissing(error)) return;
      throw integrityError();
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw integrityError();
    const identity = { dev: stats.dev, ino: stats.ino };
    await scanStartupTree(cacheRoot);
    await verifySnapshot(rootSnapshot);
    const current = await fileSystem.lstat(cacheRoot);
    if (!current.isDirectory()
      || current.isSymbolicLink()
      || !sameIdentity(current, identity)) throw integrityError();
    await fileSystem.rm(cacheRoot, { recursive: true, force: true });
  }

  async function runPublications(
    publications: readonly TrafficBodyDescriptorPublication[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const publication of publications) {
      try {
        await publishDescriptor(publication, signal);
      } catch (error) {
        if (onDescriptorPublicationError === undefined) throw error;
        try {
          await onDescriptorPublicationError(publication, error);
        } catch {
          // Installed cache state remains authoritative; the error owner may retry independently.
        }
      }
    }
  }

  function enqueuePublications(
    publications: readonly TrafficBodyDescriptorPublication[],
    signal: AbortSignal,
  ): Promise<void> {
    if (publications.length === 0) return Promise.resolve();
    const operation = publicationTail.then(() => runPublications(publications, signal));
    publicationTail = operation.catch(() => undefined);
    return operation;
  }

  function releaseResidualRetainedEntries(): void {
    for (const entries of projects.values()) {
      for (const entry of entries.values()) {
        budgets.releaseRetained(runtimeNamespace, entry.projectId, entry.sha256, entry.byteCount);
      }
    }
    projects.clear();
    references.clear();
    tombstonedRows.clear();
    activeCaptureRows.clear();
    activeCaptures.clear();
  }

  const cache: TrafficBodyCache = {
    async initialize() {
      try {
        if (initialized) return;
        if (disposing || disposed) throw new Error('Traffic body cache is unavailable');
        await enqueue(async () => {
          if (initialized) return;
          await fileSystem.mkdir(root, { recursive: true });
          const rootStats = await fileSystem.lstat(root);
          if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw integrityError();
          await removeCacheRoot();
          await assertNoSymlinkComponents(incomingRoot);
          await fileSystem.mkdir(incomingRoot, { recursive: true });
          await fileSystem.mkdir(projectsRoot, { recursive: true });
          await snapshotDirectory(incomingRoot);
          await snapshotDirectory(projectsRoot);
          initialized = true;
        });
      } catch {
        throw integrityError();
      }
    },

    async finalize(input) {
      requireAvailable();
      const suppliedReservation = finalizeReservations.get(input);
      finalizeReservations.delete(input);
      const signal = finalizeSignals.get(input) ?? disposalCancellation.signal;
      finalizeSignals.delete(input);
      const result = await enqueue(async (): Promise<FinalizeResult> => {
        const publications: TrafficBodyDescriptorPublication[] = [];
        let reservation: TrafficBodyBudgetReservation | undefined;
        let retainedAdded = false;
        try {
          if (signal.aborted) throw signal.reason;
          validateIdentity(input.projectId, input.sha256, input.byteCount);
          await verifyTemporary(input);
          if (signal.aborted) throw signal.reason;
          if (suppliedReservation === undefined) {
            const admission = budgets.reserveSidecar(
              runtimeNamespace,
              input.projectId,
              0,
              input.byteCount,
            );
            if (!admission.ok) {
              return { descriptor: unavailable(input, admission.reason), publications };
            }
            reservation = admission.reservation;
          } else {
            reservation = suppliedReservation;
          }

          if (!await reclaimPendingEntries(input.projectId)) throw integrityError();
          let conversion = reservation.convertTemporaryToRetained(input.sha256, input.byteCount);
          while (!conversion.ok) {
            const candidate = oldestEvictionCandidate(input.projectId);
            if (candidate === undefined) {
              return {
                descriptor: unavailable(input, 'retained_budget_exceeded'),
                publications,
              };
            }
            const descriptor = evictedDescriptor(candidate.descriptor);
            const deleted = await detachReference(candidate);
            publications.push({
              projectId: candidate.projectId,
              trafficId: candidate.trafficId,
              generation: candidate.generation,
              side: candidate.side,
              descriptor,
            });
            if (!deleted) throw integrityError();
            conversion = reservation.convertTemporaryToRetained(input.sha256, input.byteCount);
          }
          retainedAdded = conversion.physicalBytesAdded;

          let publishedFile: PublishedFile | undefined;
          if (input.byteCount > 0) {
            try {
              publishedFile = await publishFile(
                input.projectId,
                input.sha256,
                input.byteCount,
                input.temporaryPath!,
              );
            } catch (error) {
              if (error instanceof LinkedFileOwnershipError) {
                projectEntries(input.projectId).set(input.sha256, {
                  projectId: input.projectId,
                  sha256: input.sha256,
                  byteCount: input.byteCount,
                  filePath: error.filePath,
                  identity: error.identity,
                  disposalOnly: error.disposalOnly,
                  references: new Set(),
                  leases: 0,
                  deletePending: true,
                });
                retainedAdded = false;
              }
              throw error;
            }
          }
          let entry = projectEntries(input.projectId).get(input.sha256);
          if (entry === undefined) {
            entry = {
              projectId: input.projectId,
              sha256: input.sha256,
              byteCount: input.byteCount,
              ...(publishedFile === undefined ? {} : {
                filePath: publishedFile.filePath,
                identity: publishedFile.identity,
              }),
              references: new Set(),
              leases: 0,
              deletePending: false,
            };
            projectEntries(input.projectId).set(input.sha256, entry);
          } else if (entry.byteCount !== input.byteCount) {
            throw integrityError();
          }
          const contentEncoding = safeContentEncoding(input.contentEncoding);
          const descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }> = {
            side: input.side,
            state: 'available',
            observedSize: input.byteCount,
            retainedSize: input.byteCount,
            sha256: input.sha256,
            ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
            ...(contentEncoding === undefined ? {} : { contentEncoding }),
          };
          if (!addReference(input, descriptor, entry)) {
            if (entry.references.size === 0) await deleteEntry(entry);
            return { descriptor: unavailable(input, 'capture_io_failed'), publications };
          }
          return { descriptor, publications };
        } catch {
          if (retainedAdded) {
            budgets.releaseRetained(
              runtimeNamespace,
              input.projectId,
              input.sha256,
              input.byteCount,
            );
          }
          return { descriptor: unavailable(input, 'capture_io_failed'), publications };
        } finally {
          reservation?.release();
          await safeUnlinkTemporary(input.temporaryPath);
        }
      });
      await enqueuePublications(result.publications, signal);
      return result.descriptor;
    },

    async attach(projectId, trafficId, generation, side, descriptor) {
      requireAvailable();
      return enqueue(async () => {
        if (descriptor.side !== side) return false;
        validateIdentity(projectId, descriptor.sha256, descriptor.retainedSize);
        const entry = projects.get(projectId)?.get(descriptor.sha256);
        if (entry === undefined || entry.byteCount !== descriptor.retainedSize) return false;
        return addReference({ projectId, trafficId, generation, side }, descriptor, entry);
      });
    },

    async acquire(projectId, trafficId, generation, side) {
      try {
        requireAvailable();
        return await enqueue(async () => {
          const key = referenceKey(projectId, trafficId, generation, side);
          const reference = references.get(key);
          if (reference === undefined) return undefined;
          const entry = projects.get(projectId)?.get(reference.descriptor.sha256);
          if (entry === undefined) return undefined;
          let handle: FileHandle | undefined;
          if (entry.filePath !== undefined) {
            const snapshot = await snapshotDirectory(path.dirname(entry.filePath));
            handle = await openValidatedFile(
              entry.filePath,
              snapshot,
              entry.sha256,
              entry.byteCount,
              false,
              entry.identity,
            );
          }
          entry.leases += 1;
          activeLeases += 1;
          if (activeLeases === 1) leasesReleased = deferred();
          let released = false;
          let opened = false;
          const lease: TrafficBodyLease = {
            projectId,
            sha256: entry.sha256,
            byteCount: entry.byteCount,
            openStream() {
              if (released || opened) throw new Error('Traffic body lease is unavailable');
              opened = true;
              return handle === undefined
                ? Readable.from([])
                : handle.createReadStream({ start: 0, autoClose: false });
            },
            async release() {
              if (released) return;
              released = true;
              await enqueue(async () => {
                await handle?.close().catch(() => undefined);
                handle = undefined;
                entry.leases -= 1;
                activeLeases -= 1;
                if (entry.leases === 0 && entry.references.size === 0) await deleteEntry(entry);
                if (activeLeases === 0) leasesReleased.resolve();
              });
            },
          };
          return lease;
        });
      } catch {
        throw integrityError();
      }
    },

    async releaseRow(projectId, trafficId, generation) {
      if ((!initialized || disposed) && !disposing) return;
      await enqueue(async () => {
        const selectedRow = rowKey(projectId, trafficId, generation);
        if (activeCaptureRows.has(selectedRow)) tombstonedRows.add(selectedRow);
        for (const side of ['request', 'response'] as const) {
          const reference = references.get(referenceKey(projectId, trafficId, generation, side));
          if (reference !== undefined) await detachReference(reference);
        }
      });
    },

    async releaseBody(projectId, trafficId, generation, side) {
      if ((!initialized || disposed) && !disposing) return;
      await enqueue(async () => {
        const reference = references.get(referenceKey(projectId, trafficId, generation, side));
        if (reference !== undefined) await detachReference(reference);
      });
    },

    async clearProject(projectId) {
      requireAvailable();
      const captures = [...activeCaptures.entries()]
        .filter(([, capture]) => capture.projectId === projectId);
      const tombstoning = enqueue(async () => {
        for (const [, capture] of captures) {
          tombstonedRows.add(capture.rowKey);
        }
        if (!await reclaimPendingEntries(projectId)) throw integrityError();
        const selected = [...references.values()].filter(reference => reference.projectId === projectId);
        for (const reference of selected) {
          if (!await detachReference(reference)) throw integrityError();
        }
      });
      for (const [abort] of captures) abort();
      await tombstoning;
      await Promise.all(captures.map(([, capture]) => capture.settled.promise));
    },

    dispose() {
      if (disposePromise !== undefined) return disposePromise;
      disposing = true;
      disposalCancellation.abort(new Error('Traffic body cache disposal cancelled persistence'));
      disposePromise = (async () => {
        const captures = [...activeCaptures.entries()];
        const tombstoning = enqueue(async () => {
          for (const [, capture] of captures) {
            tombstonedRows.add(capture.rowKey);
            for (const side of ['request', 'response'] as const) {
              const reference = references.get(`${capture.rowKey}\0${side}`);
              if (reference !== undefined) await detachReference(reference);
            }
          }
        });
        for (const [abort] of captures) abort();
        await tombstoning;
        await Promise.all(captures.map(([, capture]) => capture.settled.promise));
        await enqueue(async () => {
          for (const reference of [...references.values()]) await detachReference(reference);
          for (const entries of projects.values()) {
            for (const entry of entries.values()) {
              if (entry.leases > 0) entry.deletePending = true;
              else await deleteEntry(entry);
            }
          }
        });
        if (activeLeases > 0) await leasesReleased.promise;
        await operationTail;
        await publicationTail;
        await enqueue(async () => {
          if (initialized) {
            await removeCacheRoot();
            releaseResidualRetainedEntries();
          }
          initialized = false;
          disposed = true;
        });
      })().catch(() => { throw integrityError(); });
      return disposePromise;
    },
  };

  cacheInternals.set(cache, {
    openTemporary,
    finalizeReservations,
    finalizeSignals,
    discard(temporaryPath) {
      return enqueue(() => safeUnlinkTemporary(temporaryPath));
    },
    registerCapture(identity, abort) {
      requireAvailable();
      const settled = deferred();
      const selectedRow = rowKey(identity.projectId, identity.trafficId, identity.generation);
      activeCaptures.set(abort, {
        projectId: identity.projectId,
        rowKey: selectedRow,
        settled,
      });
      activeCaptureRows.set(selectedRow, (activeCaptureRows.get(selectedRow) ?? 0) + 1);
      return () => {
        if (!activeCaptures.delete(abort)) return;
        const remaining = (activeCaptureRows.get(selectedRow) ?? 1) - 1;
        if (remaining === 0) {
          activeCaptureRows.delete(selectedRow);
          tombstonedRows.delete(selectedRow);
        } else {
          activeCaptureRows.set(selectedRow, remaining);
        }
        settled.resolve();
      };
    },
  });

  return cache;
}
