import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { HttpError } from './api-errors';
import { writeCanonicalErrorResponse } from './canonical-error-response';

class ResponseDouble extends EventEmitter {
  headersSent = false;
  writableFinished = false;
  destroyed = false;
  shouldKeepAlive = true;
  statusCode = 200;
  writeResult = true;
  readonly headers = new Map<string, string | number | readonly string[]>();
  readonly writeCallbacks: Array<(error?: Error | null) => void> = [];
  readonly endCallbacks: Array<(error?: Error | null) => void> = [];

  getHeaderNames(): string[] {
    return [...this.headers.keys()];
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name.toLowerCase(), value);
  }

  writeHead(status: number): void {
    this.statusCode = status;
    this.headersSent = true;
  }

  write(_chunk: Buffer, callback: (error?: Error | null) => void): boolean {
    this.writeCallbacks.push(callback);
    return this.writeResult;
  }

  end(callback: (error?: Error | null) => void): void {
    this.endCallbacks.push(callback);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function write(response: ResponseDouble) {
  return writeCanonicalErrorResponse(
    response as unknown as http.ServerResponse,
    new HttpError(502, 'UPSTREAM_FAILURE', 'Upstream request failed'),
    'request-1',
    { closeConnection: true },
  );
}

describe('writeCanonicalErrorResponse', () => {
  it('publishes exact bytes only after write and end callbacks complete', async () => {
    const response = new ResponseDouble();
    const pending = write(response);
    await vi.waitFor(() => expect(response.writeCallbacks).toHaveLength(1));
    response.writeCallbacks[0]?.();
    await vi.waitFor(() => expect(response.endCallbacks).toHaveLength(1));
    response.writableFinished = true;
    response.endCallbacks[0]?.();

    const result = await pending;
    expect(result).toMatchObject({
      status: 502,
      code: 'UPSTREAM_FAILURE',
      responseBytes: Number(response.headers.get('content-length')),
      bodyComplete: true,
      deliveryCause: undefined,
    });
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('returns cancellation and zero bytes when close wins before the write callback', async () => {
    const response = new ResponseDouble();
    const pending = write(response);
    await vi.waitFor(() => expect(response.writeCallbacks).toHaveLength(1));

    response.emit('close');

    await expect(pending).resolves.toMatchObject({
      responseBytes: 0,
      bodyComplete: false,
      deliveryCause: 'cancelled',
    });
    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('returns failure and zero bytes when the write callback fails', async () => {
    const response = new ResponseDouble();
    const pending = write(response);
    await vi.waitFor(() => expect(response.writeCallbacks).toHaveLength(1));

    response.writeCallbacks[0]?.(new Error('write failed'));

    await expect(pending).resolves.toMatchObject({
      responseBytes: 0,
      bodyComplete: false,
      deliveryCause: 'failure',
    });
  });

  it('retains written bytes but stays incomplete when the end callback fails', async () => {
    const response = new ResponseDouble();
    const pending = write(response);
    await vi.waitFor(() => expect(response.writeCallbacks).toHaveLength(1));
    response.writeCallbacks[0]?.();
    await vi.waitFor(() => expect(response.endCallbacks).toHaveLength(1));

    response.endCallbacks[0]?.(new Error('end failed'));

    await expect(pending).resolves.toMatchObject({
      responseBytes: Number(response.headers.get('content-length')),
      bodyComplete: false,
      deliveryCause: 'failure',
    });
  });

  it('retains written bytes but returns cancellation when close wins before the end callback', async () => {
    const response = new ResponseDouble();
    const pending = write(response);
    await vi.waitFor(() => expect(response.writeCallbacks).toHaveLength(1));
    response.writeCallbacks[0]?.();
    await vi.waitFor(() => expect(response.endCallbacks).toHaveLength(1));

    response.emit('close');

    await expect(pending).resolves.toMatchObject({
      responseBytes: Number(response.headers.get('content-length')),
      bodyComplete: false,
      deliveryCause: 'cancelled',
    });
  });

  it('settles a response error while waiting for backpressure drain', async () => {
    const response = new ResponseDouble();
    response.writeResult = false;
    const pending = write(response);
    await vi.waitFor(() => expect(response.writeCallbacks).toHaveLength(1));
    response.writeCallbacks[0]?.();

    response.emit('error', new Error('destination failed during drain'));

    await expect(pending).resolves.toMatchObject({
      responseBytes: 0,
      bodyComplete: false,
      deliveryCause: 'failure',
    });
  });
});
