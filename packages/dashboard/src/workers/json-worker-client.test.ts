import { describe, expect, it, vi } from 'vitest';
import {
  createJsonWorkerClient,
  type JsonWorkerOperation,
  type JsonWorkerRequest,
  type JsonWorkerResponse,
} from './json-worker-client';
import { handleJsonWorkerRequest } from './json.worker';

type WorkerEventType = 'message' | 'error' | 'messageerror';
type WorkerListener = (event: MessageEvent<JsonWorkerResponse> | ErrorEvent | MessageEvent) => void;

class FakeWorker {
  messages: JsonWorkerRequest[] = [];
  terminate = vi.fn();
  postError?: Error;
  private listeners: Record<WorkerEventType, Set<WorkerListener>> = {
    message: new Set(),
    error: new Set(),
    messageerror: new Set(),
  };

  postMessage(message: JsonWorkerRequest) {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }

  addEventListener(type: WorkerEventType, listener: WorkerListener) {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: WorkerEventType, listener: WorkerListener) {
    this.listeners[type].delete(listener);
  }

  respond(response: { ok: true; formatted?: string } | { ok: false; message: string }) {
    const request = this.messages.at(-1);
    if (!request) throw new Error('No worker message');
    this.emit('message', {
      data: {
        id: request.id,
        documentIdentity: request.documentIdentity,
        documentGeneration: request.documentGeneration,
        operationGeneration: request.operationGeneration,
        ...response,
      },
    } as MessageEvent<JsonWorkerResponse>);
  }

  emit(type: WorkerEventType, event: ErrorEvent | MessageEvent = new MessageEvent(type)) {
    for (const listener of this.listeners[type]) listener(event);
  }

  listenerCount() {
    return Object.values(this.listeners).reduce((count, listeners) => count + listeners.size, 0);
  }

  lastId() {
    const message = this.messages.at(-1);
    if (!message) throw new Error('No worker message');
    return message.id;
  }
}

function operation(text: string, operationGeneration = 1): JsonWorkerOperation {
  return {
    documentIdentity: 'mock:prj_1:ep_1:var_1:3',
    documentGeneration: 4,
    operationGeneration,
    text,
  };
}

function request(id: number, workerOperation: 'validate' | 'format', text: string): JsonWorkerRequest {
  return { id, operation: workerOperation, ...operation(text, id) };
}

describe('JsonWorkerClient', () => {
  it('validates and formats through the worker protocol', async () => {
    const fakeWorker = new FakeWorker();
    const client = createJsonWorkerClient(fakeWorker as unknown as Worker);
    const validation = client.validate(operation('{"a":1}'));
    fakeWorker.respond({ ok: true });
    await expect(validation).resolves.toMatchObject({
      id: 1,
      documentIdentity: 'mock:prj_1:ep_1:var_1:3',
      documentGeneration: 4,
      operationGeneration: 1,
      ok: true,
    });

    const formatting = client.format(operation('{"a":1}', 2));
    fakeWorker.respond({ ok: true, formatted: '{\n  "a": 1\n}' });
    await expect(formatting).resolves.toMatchObject({
      id: 2,
      operationGeneration: 2,
      ok: true,
      formatted: '{\n  "a": 1\n}',
    });
    expect(fakeWorker.messages.map(message => message.operation)).toEqual(['validate', 'format']);
  });

  it('rejects all pending worker promises on dispose', async () => {
    const fakeWorker = new FakeWorker();
    const client = createJsonWorkerClient(fakeWorker as unknown as Worker);
    const pending = client.validate(operation('{}'));

    client.dispose();

    await expect(pending).rejects.toThrow('JSON worker disposed');
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
    expect(fakeWorker.listenerCount()).toBe(0);
  });

  it('settles pending requests even if worker termination throws', async () => {
    const fakeWorker = new FakeWorker();
    fakeWorker.terminate.mockImplementationOnce(() => {
      throw new Error('terminate failed');
    });
    const client = createJsonWorkerClient(fakeWorker as unknown as Worker);
    const pending = client.validate(operation('{}'));

    expect(() => client.dispose()).not.toThrow();

    await expect(pending).rejects.toThrow('JSON worker disposed');
    expect(fakeWorker.listenerCount()).toBe(0);
  });

  it.each([
    ['error', new ErrorEvent('error', { error: new Error('worker crashed') }), 'worker crashed'],
    ['messageerror', new MessageEvent('messageerror'), 'JSON worker message error'],
  ] as const)('rejects every pending request and cleans up after worker %s', async (type, event, message) => {
    const fakeWorker = new FakeWorker();
    const client = createJsonWorkerClient(fakeWorker as unknown as Worker);
    const first = client.validate(operation('{}'));
    const second = client.format(operation('{}', 2));
    const rejected: string[] = [];
    void first.catch(error => rejected.push(errorMessage(error)));
    void second.catch(error => rejected.push(errorMessage(error)));

    fakeWorker.emit(type, event);
    await Promise.resolve();
    const rejectedByEvent = [...rejected];
    client.dispose();
    await Promise.allSettled([first, second]);

    expect(rejectedByEvent).toEqual([message, message]);
    await expect(client.validate(operation('{}'))).rejects.toThrow(message);
    expect(fakeWorker.listenerCount()).toBe(0);
    expect(fakeWorker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects a synchronous postMessage failure without poisoning later requests', async () => {
    const fakeWorker = new FakeWorker();
    const client = createJsonWorkerClient(fakeWorker as unknown as Worker);
    fakeWorker.postError = new Error('clone failed');

    await expect(client.validate(operation('{}'))).rejects.toThrow('clone failed');

    fakeWorker.postError = undefined;
    const next = client.validate(operation('{}'));
    fakeWorker.respond({ ok: true });
    await expect(next).resolves.toMatchObject({ id: 2, ok: true });
    client.dispose();
  });
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('json.worker request handler', () => {
  it('validates and formats deterministically while preserving request IDs', () => {
    expect(handleJsonWorkerRequest(request(7, 'validate', '{"a":1}')))
      .toMatchObject({ id: 7, operationGeneration: 7, ok: true });
    expect(handleJsonWorkerRequest(request(8, 'format', '{"a":1}')))
      .toMatchObject({ id: 8, operationGeneration: 8, ok: true, formatted: '{\n  "a": 1\n}' });
  });

  it.each(['validate', 'format'] as const)(
    'returns one correlated failure for invalid JSON during %s',
    operation => {
      const response = handleJsonWorkerRequest(request(9, operation, '{bad'));
      expect(response).toMatchObject({ id: 9, ok: false });
      if (!response.ok) expect(response.message).toEqual(expect.any(String));
    },
  );
});
