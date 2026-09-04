export interface JsonWorkerOperation {
  documentIdentity: string;
  documentGeneration: number;
  operationGeneration: number;
  text: string;
}

export type JsonWorkerRequest = JsonWorkerOperation & {
  id: number;
  operation: 'validate' | 'format';
};

type JsonWorkerResponseOwner = Pick<
  JsonWorkerOperation,
  'documentIdentity' | 'documentGeneration' | 'operationGeneration'
> & { id: number };

export type JsonWorkerResponse = JsonWorkerResponseOwner & (
  | { ok: true; formatted?: string }
  | { ok: false; message: string; position?: number }
);

export interface JsonWorkerClient {
  validate(input: JsonWorkerOperation): Promise<JsonWorkerResponse>;
  format(input: JsonWorkerOperation): Promise<JsonWorkerResponse>;
  dispose(): void;
}

export function createJsonWorkerClient(worker: Worker): JsonWorkerClient {
  let nextId = 1;
  let terminalError: Error | undefined;
  const pending = new Map<
    number,
    { resolve(response: JsonWorkerResponse): void; reject(error: Error): void }
  >();

  const handleMessage = (event: MessageEvent<JsonWorkerResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    request.resolve(event.data);
  };

  const removeListeners = () => {
    worker.removeEventListener('message', handleMessage);
    worker.removeEventListener('error', handleError);
    worker.removeEventListener('messageerror', handleMessageError);
  };

  const failAll = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    removeListeners();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    try {
      worker.terminate();
    } catch {
      // Pending requests are already settled; termination is best-effort cleanup.
    }
  };

  function handleError(event: ErrorEvent) {
    failAll(event.error instanceof Error
      ? event.error
      : new Error(event.message || 'JSON worker error'));
  }

  function handleMessageError() {
    failAll(new Error('JSON worker message error'));
  }

  worker.addEventListener('message', handleMessage);
  worker.addEventListener('error', handleError);
  worker.addEventListener('messageerror', handleMessageError);

  const request = (
    operation: JsonWorkerRequest['operation'],
    input: JsonWorkerOperation,
  ): Promise<JsonWorkerResponse> => {
    if (terminalError) return Promise.reject(terminalError);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, operation, ...input } satisfies JsonWorkerRequest);
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error('JSON worker postMessage failed'));
      }
    });
  };

  return {
    validate: input => request('validate', input),
    format: input => request('format', input),
    dispose() {
      failAll(new Error('JSON worker disposed'));
    },
  };
}

export function createBrowserJsonWorkerClient(): JsonWorkerClient {
  return createJsonWorkerClient(
    new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' }),
  );
}
