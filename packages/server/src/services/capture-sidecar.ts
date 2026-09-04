import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import {
  type TrafficBodyDescriptor,
  type TrafficBodyUnavailableReason,
  type TrafficLimits,
} from '../domain/traffic';
import { normalizeContentEncoding } from '../domain/http-metadata';
import type { FileSystem } from '../repository/file-system';
import type {
  TrafficBodyBudgetManager,
  TrafficBodyBudgetReservation,
} from './traffic-body-budget';
import {
  discardTrafficBodyTemporary,
  finalizeTrafficBodyTemporary,
  openTrafficBodyTemporary,
  registerTrafficBodyCapture,
  type TrafficBodyCache,
} from './traffic-body-cache';

export interface CaptureObservation {
  preview?: string;
  previewEncoding?: 'utf8' | 'base64';
  observedSize: number;
  descriptor: TrafficBodyDescriptor;
}

export interface CaptureSidecar {
  observe(bytes: Uint8Array): void;
  acceptsObservation(): boolean;
  complete(): Promise<CaptureObservation>;
  abandon(reason: TrafficBodyUnavailableReason): void;
}

interface PendingChunk {
  bytes: Buffer;
  reservedBytes: number;
}

type ExactState =
  | { state: 'active' }
  | { state: 'unavailable'; reason: TrafficBodyUnavailableReason }
  | { state: 'truncated' };

function writeAll(handle: FileHandle, bytes: Buffer, signal: AbortSignal): Promise<void> {
  return (async () => {
    let offset = 0;
    while (offset < bytes.length) {
      if (signal.aborted) throw signal.reason;
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => {
          void handle.close().catch(() => undefined);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
      });
      const writing = handle.write(bytes, offset, bytes.length - offset, null);
      let result;
      try {
        result = await Promise.race([writing, aborted]);
      } catch (error) {
        await writing.catch(() => undefined);
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
      if (result.bytesWritten <= 0) throw new Error('Traffic capture write made no progress');
      offset += result.bytesWritten;
    }
  })();
}

export function createCaptureSidecar(input: {
  runtimeNamespace: string;
  projectId: string;
  trafficId: string;
  generation: string;
  side: 'request' | 'response';
  enabled: boolean;
  mediaType?: string;
  contentEncoding?: string;
  textPreview: boolean;
  cache: TrafficBodyCache;
  budgets: TrafficBodyBudgetManager;
  fileSystem: FileSystem;
  limits: Readonly<TrafficLimits>;
}): CaptureSidecar {
  let contentEncoding: string | undefined;
  try {
    contentEncoding = normalizeContentEncoding(input.contentEncoding);
  } catch {
    contentEncoding = undefined;
  }
  const previewChunks: Buffer[] = [];
  const pending: PendingChunk[] = [];
  const hash = createHash('sha256');
  let previewBytes = 0;
  let observedSize = 0;
  let queuedBytes = 0;
  let exactState: ExactState;
  let reservation: TrafficBodyBudgetReservation | undefined;
  let temporaryPath: string | undefined;
  let handle: FileHandle | undefined;
  let openPromise: Promise<void> | undefined;
  let draining = false;
  let drainPromise = Promise.resolve();
  let completing = false;
  let completionPromise: Promise<CaptureObservation> | undefined;
  let unregisterCapture: (() => void) | undefined;
  let observationClosed = false;
  const persistenceCancellation = new AbortController();

  function cancelPendingPersistence(): void {
    if (persistenceCancellation.signal.aborted) return;
    persistenceCancellation.abort(new Error('Traffic capture persistence cancelled'));
  }

  if (!input.enabled) {
    exactState = { state: 'unavailable', reason: 'raw_capture_disabled' };
  } else {
    const admission = input.budgets.reserveSidecar(
      input.runtimeNamespace,
      input.projectId,
      0,
      0,
    );
    if (admission.ok) {
      reservation = admission.reservation;
      exactState = { state: 'active' };
    } else {
      exactState = { state: 'unavailable', reason: admission.reason };
    }
  }

  function metadata(): { mediaType?: string; contentEncoding?: string } {
    return {
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(contentEncoding === undefined ? {} : { contentEncoding }),
    };
  }

  function releasePending(): void {
    for (const chunk of pending.splice(0)) {
      reservation?.releaseQueued(chunk.reservedBytes);
      queuedBytes -= chunk.reservedBytes;
    }
  }

  function failExact(reason: TrafficBodyUnavailableReason): void {
    if (exactState.state !== 'active') return;
    exactState = { state: 'unavailable', reason };
    releasePending();
    cancelPendingPersistence();
  }

  function unavailableReason(): TrafficBodyUnavailableReason | undefined {
    return exactState.state === 'unavailable' ? exactState.reason : undefined;
  }

  async function ensureOpen(): Promise<void> {
    if (handle !== undefined) return;
    if (openPromise === undefined) {
      openPromise = (async () => {
        const opened = await openTrafficBodyTemporary(input.cache, persistenceCancellation.signal);
        temporaryPath = opened.temporaryPath;
        handle = opened.handle;
      })();
    }
    await openPromise;
  }

  function scheduleDrain(): void {
    if (draining || pending.length === 0) return;
    draining = true;
    drainPromise = (async () => {
      try {
        await ensureOpen();
        while (pending.length > 0) {
          const chunk = pending.shift()!;
          try {
            await writeAll(handle!, chunk.bytes, persistenceCancellation.signal);
          } finally {
            reservation?.releaseQueued(chunk.reservedBytes);
            queuedBytes -= chunk.reservedBytes;
          }
        }
      } catch {
        failExact('capture_io_failed');
      } finally {
        draining = false;
        if (pending.length > 0) scheduleDrain();
      }
    })();
  }

  function observePreview(bytes: Uint8Array): void {
    const remaining = input.limits.previewBytes - previewBytes;
    if (remaining <= 0 || bytes.byteLength === 0) return;
    const copied = Buffer.from(bytes.subarray(0, remaining));
    previewChunks.push(copied);
    previewBytes += copied.length;
  }

  function previewObservation(): Pick<CaptureObservation, 'preview' | 'previewEncoding'> {
    if (previewBytes === 0) return {};
    const bytes = Buffer.concat(previewChunks, previewBytes);
    if (input.textPreview) {
      try {
        return {
          preview: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          previewEncoding: 'utf8',
        };
      } catch {
        // Binary fallback preserves the bounded bytes exactly.
      }
    }
    return { preview: bytes.toString('base64'), previewEncoding: 'base64' };
  }

  function unavailableDescriptor(reason: TrafficBodyUnavailableReason): TrafficBodyDescriptor {
    return {
      side: input.side,
      state: 'unavailable',
      observedSize,
      reason,
      ...metadata(),
    };
  }

  async function closeHandle(sync: boolean): Promise<boolean> {
    if (handle === undefined) return true;
    let succeeded = true;
    try {
      if (sync) await handle.sync();
    } catch {
      succeeded = false;
    }
    try {
      await handle.close();
    } catch {
      succeeded = false;
    }
    handle = undefined;
    return succeeded;
  }

  async function settle(): Promise<CaptureObservation> {
    let reservationTransferred = false;
    try {
      while (draining) {
        await drainPromise;
      }
      if (exactState.state === 'active' && !await closeHandle(true)) {
        failExact('capture_io_failed');
      } else if (exactState.state !== 'active') {
        await closeHandle(false);
      }

      let descriptor: TrafficBodyDescriptor;
      if (exactState.state === 'active') {
        const sha256 = hash.digest('hex');
        const finalizeInput = {
          projectId: input.projectId,
          trafficId: input.trafficId,
          generation: input.generation,
          side: input.side,
          ...(temporaryPath === undefined ? {} : { temporaryPath }),
          sha256,
          byteCount: observedSize,
          ...metadata(),
        };
        reservationTransferred = true;
        const finalized = await finalizeTrafficBodyTemporary(
          input.cache,
          finalizeInput,
          reservation!,
          persistenceCancellation.signal,
        );
        const terminalReason = unavailableReason();
        if (terminalReason !== undefined) {
          await input.cache.releaseBody(
            input.projectId,
            input.trafficId,
            input.generation,
            input.side,
          );
          descriptor = unavailableDescriptor(terminalReason);
        } else {
          descriptor = finalized;
        }
      } else if (exactState.state === 'truncated') {
        descriptor = {
          side: input.side,
          state: 'truncated',
          observedSize,
          reason: 'body_limit_exceeded',
          ...metadata(),
        };
      } else {
        descriptor = unavailableDescriptor(exactState.reason);
      }

      if (!reservationTransferred && temporaryPath !== undefined) {
        await discardTrafficBodyTemporary(input.cache, temporaryPath);
      }
      return {
        ...previewObservation(),
        observedSize,
        descriptor,
      };
    } catch {
      if (temporaryPath !== undefined) {
        await discardTrafficBodyTemporary(input.cache, temporaryPath).catch(() => undefined);
      }
      return {
        ...previewObservation(),
        observedSize,
        descriptor: unavailableDescriptor(
          exactState.state === 'unavailable' ? exactState.reason : 'capture_io_failed',
        ),
      };
    } finally {
      reservation?.release();
      unregisterCapture?.();
    }
  }

  const sidecar: CaptureSidecar = {
    observe(bytes) {
      if (observationClosed) return;
      if (completing) throw new Error('Traffic capture is already complete');
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Traffic capture bytes are invalid');
      if (exactState.state === 'truncated') return;
      observedSize = Math.min(input.limits.bodyBytes + 1, observedSize + bytes.byteLength);
      observePreview(bytes);
      if (exactState.state !== 'active' || bytes.byteLength === 0) return;
      if (observedSize > input.limits.bodyBytes) {
        exactState = { state: 'truncated' };
        observationClosed = true;
        releasePending();
        cancelPendingPersistence();
        return;
      }
      if (queuedBytes + bytes.byteLength > input.limits.sidecarQueueBytes
        || !reservation!.growQueued(bytes.byteLength)) {
        failExact('queue_saturated');
        return;
      }
      if (!reservation!.growTemporary(bytes.byteLength)) {
        reservation!.releaseQueued(bytes.byteLength);
        failExact('temporary_budget_exceeded');
        return;
      }
      const copied = Buffer.from(bytes);
      hash.update(copied);
      pending.push({ bytes: copied, reservedBytes: copied.length });
      queuedBytes += copied.length;
      scheduleDrain();
    },

    acceptsObservation() {
      return !observationClosed && !completing;
    },

    complete() {
      if (completionPromise === undefined) {
        completing = true;
        observationClosed = true;
        completionPromise = settle();
      }
      return completionPromise;
    },

    abandon(reason) {
      if (reason === 'stream_cancelled') observationClosed = true;
      failExact(reason);
      if (reason === 'stream_cancelled') cancelPendingPersistence();
    },
  };

  if (reservation !== undefined) {
    try {
      unregisterCapture = registerTrafficBodyCapture(
        input.cache,
        {
          projectId: input.projectId,
          trafficId: input.trafficId,
          generation: input.generation,
        },
        () => {
          sidecar.abandon('stream_cancelled');
          void sidecar.complete();
        },
      );
    } catch {
      reservation.release();
      reservation = undefined;
      exactState = { state: 'unavailable', reason: 'stream_cancelled' };
      observationClosed = true;
    }
  }

  return sidecar;
}
