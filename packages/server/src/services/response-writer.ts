import { Readable, Writable } from 'node:stream';
import type { OutgoingHttpHeaders } from 'node:http';
import type { BodyAsset, ResponseHeaders } from '../domain/model';
import { AuthoredResponseStatusSchema } from '../domain/schemas';
import type { ResolvedMock } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';

const BODY_OWNED_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);
const MAXIMUM_TIMER_DELAY = 2_147_483_647;

export type ResponseWriterTarget = Writable & {
  status(code: number): unknown;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
};

export interface ResponseBodyRepository {
  getBody(
    ...arguments_: Parameters<ProjectRepository['getBody']>
  ): ReturnType<ProjectRepository['getBody']>;
  openBody(...arguments_: Parameters<ProjectRepository['openBody']>): NodeJS.ReadableStream;
}

export function outgoingHeaderTuples(headers: OutgoingHttpHeaders): Array<readonly [string, string]> {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map(item => [name, String(item)] as const);
  });
}

interface StreamSignal {
  completed: boolean;
  error?: Error;
}

interface StreamTerminal {
  error?: Error;
}

interface OwnedStreamLifecycle {
  notification: Promise<StreamSignal>;
  terminal: Promise<StreamTerminal>;
  cleanup(): void;
  destroy(error?: Error): void;
  settleIfTerminating(): Promise<void>;
  signal(): StreamSignal | undefined;
}

interface LifecycleDestroyable {
  destroy(error?: Error): Readable | Writable;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function destinationError(error?: Error): Error {
  return error ?? new Error('Response destination closed before completion');
}

function sourceError(error?: Error): Error {
  return error ?? new Error('Response source closed before completion');
}

function nextImmediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function ownStream(
  stream: Readable | Writable,
  role: 'source' | 'destination',
): OwnedStreamLifecycle {
  const normalEvent = role === 'source' ? 'end' : 'finish';
  const normalComplete = (): boolean => role === 'source'
    ? (stream as Readable).readableEnded
    : (stream as Writable).writableFinished;
  const closedError = role === 'source' ? sourceError : destinationError;
  const observedErrors: Error[] = [];
  let normalCompleted = false;
  let observedSignal: StreamSignal | undefined;
  let terminalResult: StreamTerminal | undefined;
  let resolveNotification!: (signal: StreamSignal) => void;
  let resolveTerminal!: (result: StreamTerminal) => void;
  let watchingDestroy = false;
  let terminationAttempted = false;
  const notification = new Promise<StreamSignal>(resolve => { resolveNotification = resolve; });
  const terminal = new Promise<StreamTerminal>(resolve => { resolveTerminal = resolve; });

  const recordError = (error: Error): void => {
    observedErrors.push(error);
  };
  const notify = (signal: StreamSignal): void => {
    if (observedSignal) return;
    observedSignal = signal;
    resolveNotification(signal);
  };
  const settleTerminal = (): void => {
    if (terminalResult) return;
    terminalResult = observedErrors[0] ? { error: observedErrors[0] } : {};
    resolveTerminal(terminalResult);
  };
  const watchDestroy = (): void => {
    if (watchingDestroy) return;
    watchingDestroy = true;
    void (async () => {
      while (!stream.closed) await nextImmediate();
      // Node can set `closed` immediately before scheduling the destroy callback's error event.
      await nextImmediate();
      settleTerminal();
    })();
  };
  const onError = (error: Error): void => {
    recordError(error);
    if (!normalCompleted) notify({ completed: false, error });
    if (stream.destroyed) watchDestroy();
  };
  const onNormal = (): void => {
    normalCompleted = true;
    notify({ completed: true });
    void (async () => {
      await nextImmediate();
      if (stream.destroyed) watchDestroy();
      else settleTerminal();
    })();
  };
  const onClose = (): void => {
    if (!normalCompleted) {
      const error = closedError();
      recordError(error);
      notify({ completed: false, error });
    }
    settleTerminal();
  };
  const destroyable: LifecycleDestroyable = stream;
  const originalDestroy = destroyable.destroy;
  const concreteDestroy = (error?: Error): Readable | Writable => role === 'source'
    ? Readable.prototype.destroy.call(stream as Readable, error)
    : Writable.prototype.destroy.call(stream as Writable, error);
  const monitoredDestroy = (error?: Error): Readable | Writable => {
    if (error) recordError(error);
    if (!normalCompleted) {
      const initiating = error ?? closedError();
      recordError(initiating);
      notify({ completed: false, error: initiating });
    }
    if (stream.closed) {
      settleTerminal();
      return stream;
    }
    if (stream.destroyed) {
      watchDestroy();
      return stream;
    }
    if (terminationAttempted) return stream;
    terminationAttempted = true;

    let result: Readable | Writable = stream;
    try {
      result = originalDestroy.call(stream, error);
    } catch (destroyError) {
      recordError(toError(destroyError));
    }

    if (!stream.destroyed && !stream.closed) {
      try {
        result = concreteDestroy(error);
      } catch (destroyError) {
        recordError(toError(destroyError));
      }
    }

    if (stream.closed) settleTerminal();
    else if (stream.destroyed) watchDestroy();
    else settleTerminal();
    return result;
  };

  destroyable.destroy = monitoredDestroy;
  stream.on('error', onError);
  stream.once(normalEvent, onNormal);
  stream.once('close', onClose);

  if (normalComplete()) onNormal();
  else if (stream.destroyed || stream.closed) {
    const error = closedError();
    recordError(error);
    notify({ completed: false, error });
    if (stream.closed) settleTerminal();
    else watchDestroy();
  }

  return {
    notification,
    terminal,
    signal: () => observedSignal,
    destroy: error => { monitoredDestroy(error); },
    settleIfTerminating: async () => {
      if (observedSignal?.error) monitoredDestroy();
      if (terminationAttempted || stream.destroyed || stream.closed || normalCompleted) await terminal;
    },
    cleanup: () => {
      stream.off('error', onError);
      stream.off(normalEvent, onNormal);
      stream.off('close', onClose);
      if (destroyable.destroy === monitoredDestroy) destroyable.destroy = originalDestroy;
    },
  };
}

function assertDestinationOpen(
  target: ResponseWriterTarget,
  lifecycle: OwnedStreamLifecycle,
): void {
  const signal = lifecycle.signal();
  if (signal || target.destroyed || target.closed || target.writableEnded || target.writableFinished) {
    throw destinationError(signal?.error);
  }
}

async function awaitDestination<T>(
  operation: Promise<T>,
  destination: OwnedStreamLifecycle,
): Promise<T> {
  const outcome = await Promise.race([
    operation.then(
      value => ({ type: 'operation' as const, value }),
      error => ({ type: 'operation-error' as const, error }),
    ),
    destination.notification.then(signal => ({ type: 'destination' as const, signal })),
  ]);

  if (outcome.type === 'operation') return outcome.value;
  if (outcome.type === 'operation-error') throw outcome.error;
  throw destinationError(outcome.signal.error);
}

async function waitForDelay(delayMs: number, destination: OwnedStreamLifecycle): Promise<void> {
  let remaining = delayMs;
  while (remaining > 0) {
    const duration = Math.min(remaining, MAXIMUM_TIMER_DELAY);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await awaitDestination(new Promise<void>(resolve => {
        timer = setTimeout(resolve, duration);
      }), destination);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    remaining -= duration;
  }
}

function applyHeaders(
  target: ResponseWriterTarget,
  resolvedHeaders: ResponseHeaders,
  metadata: BodyAsset | undefined,
  bodyAllowed = true,
  status?: number,
): void {
  for (const [name, value] of Object.entries(resolvedHeaders)) {
    if (!BODY_OWNED_HEADERS.has(name.toLowerCase())) target.setHeader(name, value);
  }
  if (!bodyAllowed) {
    if (status === 205) target.setHeader('Content-Length', 0);
    return;
  }
  const variantHasContentType = Object.keys(resolvedHeaders)
    .some(name => name.toLowerCase() === 'content-type');
  if (metadata && !variantHasContentType) {
    target.setHeader('Content-Type', metadata.mediaType);
  }
  target.setHeader('Content-Length', metadata?.size ?? 0);
  if (metadata?.encoding) target.setHeader('Content-Encoding', metadata.encoding);
}

export function responseAllowsBody(requestMethod: string, status: number): boolean {
  return requestMethod.toUpperCase() !== 'HEAD'
    && !(status >= 100 && status < 200)
    && status !== 204
    && status !== 205
    && status !== 304;
}

function assertReadable(source: unknown): asserts source is Readable {
  if (!(source instanceof Readable)) {
    throw new TypeError('Body source must be a Node.js Readable stream');
  }
}

async function disposeSource(
  source: Readable,
  lifecycle: OwnedStreamLifecycle,
): Promise<StreamTerminal> {
  try {
    lifecycle.destroy();
    return await lifecycle.terminal;
  } finally {
    lifecycle.cleanup();
  }
}

async function pipeResponse(
  source: Readable,
  target: Writable,
  sourceLifecycle: OwnedStreamLifecycle,
  destination: OwnedStreamLifecycle,
): Promise<void> {
  let initiatingError: Error | undefined;
  const unpipe = (): void => {
    try {
      source.unpipe(target);
    } catch (error) {
      initiatingError ??= toError(error);
    }
  };
  const stop = (error: Error): void => {
    if (initiatingError) return;
    initiatingError = error;
    unpipe();
    sourceLifecycle.destroy();
    if (!target.writableFinished) destination.destroy();
  };
  const sourceNotification = sourceLifecycle.notification.then(signal => {
    if (signal.error) stop(sourceError(signal.error));
    return signal;
  });
  const destinationNotification = destination.notification.then(signal => {
    if (signal.error) stop(destinationError(signal.error));
    else if (!source.readableEnded) stop(destinationError());
    return signal;
  });

  try {
    source.pipe(target);
  } catch (error) {
    stop(toError(error));
  }

  try {
    await Promise.all([sourceNotification, destinationNotification]);
    const [sourceTerminal, destinationTerminal] = await Promise.all([
      sourceLifecycle.terminal,
      destination.terminal,
    ]);
    initiatingError ??= sourceTerminal.error ?? destinationTerminal.error;
    if (initiatingError) throw initiatingError;
  } finally {
    unpipe();
    sourceLifecycle.cleanup();
  }
}

export async function writeOwnedStream(
  target: Writable,
  sourceValue: NodeJS.ReadableStream,
): Promise<void> {
  if (target.destroyed || target.closed || target.writableEnded || target.writableFinished) {
    throw destinationError();
  }
  assertReadable(sourceValue);
  const destination = ownStream(target, 'destination');
  const source = sourceValue;
  const sourceLifecycle = ownStream(source, 'source');
  try {
    await pipeResponse(source, target, sourceLifecycle, destination);
  } finally {
    await destination.settleIfTerminating();
    destination.cleanup();
  }
}

export async function writeResolvedResponse(
  target: ResponseWriterTarget,
  resolved: ResolvedMock,
  bodies: ResponseBodyRepository,
  requestMethod = 'GET',
): Promise<number> {
  if (target.destroyed || target.closed || target.writableEnded || target.writableFinished) {
    throw destinationError();
  }
  if (!AuthoredResponseStatusSchema.safeParse(resolved.status).success) {
    throw new Error('Authored response status must be a final HTTP status from 200 through 599');
  }
  const destination = ownStream(target, 'destination');

  try {
    await waitForDelay(resolved.delayMs, destination);
    assertDestinationOpen(target, destination);
    target.status(resolved.status);
    assertDestinationOpen(target, destination);

    const bodyAllowed = responseAllowsBody(requestMethod, resolved.status);
    if (!bodyAllowed || !resolved.bodyAssetId) {
      applyHeaders(target, resolved.responseHeaders, undefined, bodyAllowed, resolved.status);
      assertDestinationOpen(target, destination);
      target.end();
      const signal = await destination.notification;
      const terminal = await destination.terminal;
      if (signal.error) throw destinationError(signal.error);
      if (terminal.error) throw destinationError(terminal.error);
      return 0;
    }

    const metadata = await awaitDestination(
      bodies.getBody(resolved.projectId, resolved.bodyAssetId),
      destination,
    );
    assertDestinationOpen(target, destination);
    applyHeaders(target, resolved.responseHeaders, metadata);
    assertDestinationOpen(target, destination);

    const sourceValue = bodies.openBody(resolved.projectId, resolved.bodyAssetId);
    assertReadable(sourceValue);
    const source = sourceValue;
    const sourceLifecycle = ownStream(source, 'source');
    const destinationSignal = destination.signal();
    if (destinationSignal) {
      await disposeSource(source, sourceLifecycle);
      throw destinationError(destinationSignal.error);
    }
    if (source.destroyed || source.closed || source.readableEnded) {
      const signal = sourceLifecycle.signal();
      await disposeSource(source, sourceLifecycle);
      throw sourceError(signal?.error);
    }

    await pipeResponse(source, target, sourceLifecycle, destination);
    return metadata.size;
  } finally {
    await destination.settleIfTerminating();
    destination.cleanup();
  }
}
