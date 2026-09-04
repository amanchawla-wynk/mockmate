import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';

import { createDeliveryCauseTracker } from './delivery-cause';
import { ObservedResponseTarget } from './observed-response-target';

class ResponseDouble extends EventEmitter {
  headersSent = false;
  writableFinished = false;
  destroyed = false;
  shouldKeepAlive = true;
  statusCode = 200;
  writeResult = true;
  writeCallbacks: Array<(error?: Error | null) => void> = [];

  setHeader(): void {}

  writeHead(): void {
    this.headersSent = true;
  }

  write(_chunk: Buffer, callback: (error?: Error | null) => void): boolean {
    this.writeCallbacks.push(callback);
    return this.writeResult;
  }

  end(callback: () => void): void {
    this.writableFinished = true;
    callback();
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function targetFor(response: ResponseDouble) {
  const cause = createDeliveryCauseTracker();
  const target = new ObservedResponseTarget(response as unknown as http.ServerResponse, cause);
  target.on('error', () => {});
  return { cause, target };
}

function write(target: ObservedResponseTarget, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.write(Buffer.from(value), error => error ? reject(error) : resolve());
  });
}

describe('ObservedResponseTarget', () => {
  it('classifies a response error before the write callback as failure', async () => {
    const response = new ResponseDouble();
    const { cause, target } = targetFor(response);
    const pending = write(target, 'first');

    response.emit('error', new Error('destination failed'));

    await expect(pending).rejects.toThrow('destination failed');
    expect(cause.cause).toBe('failure');
    expect(target.responseBytes).toBe(0);
  });

  it('classifies a response error after write completion while awaiting drain as failure', async () => {
    const response = new ResponseDouble();
    response.writeResult = false;
    const { cause, target } = targetFor(response);
    let settled = false;
    const pending = write(target, 'blocked').finally(() => { settled = true; });
    response.writeCallbacks[0]?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);

    response.emit('error', new Error('failed during backpressure'));

    await expect(pending).rejects.toThrow('failed during backpressure');
    expect(cause.cause).toBe('failure');
    expect(target.responseBytes).toBe(0);
  });

  it('retains only successfully completed bytes after a later response error', async () => {
    const response = new ResponseDouble();
    const { cause, target } = targetFor(response);
    const first = write(target, 'four');
    response.writeCallbacks[0]?.();
    await first;
    const second = write(target, 'lost');

    response.emit('error', new Error('later destination failure'));

    await expect(second).rejects.toThrow('later destination failure');
    expect(cause.cause).toBe('failure');
    expect(target.responseBytes).toBe(4);
  });

  it('keeps a genuine destination close classified as cancellation', async () => {
    const response = new ResponseDouble();
    const { cause, target } = targetFor(response);
    const pending = write(target, 'cancelled');

    response.emit('close');

    await expect(pending).rejects.toThrow('Response destination closed');
    expect(cause.cause).toBe('cancelled');
    expect(target.responseBytes).toBe(0);
  });
});
