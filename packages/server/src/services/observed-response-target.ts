import * as http from 'node:http';
import { Writable } from 'node:stream';

import type { DeliveryCauseTracker } from './delivery-cause';
import type { ResponseWriterTarget } from './response-writer';

function destinationClosed(): Error {
  return new Error('Response destination closed before write completion');
}

export class ObservedResponseTarget extends Writable implements ResponseWriterTarget {
  private statusCode = 200;
  private forceClose: boolean;
  responseBytes = 0;

  constructor(
    private readonly response: http.ServerResponse,
    private readonly deliveryCause: DeliveryCauseTracker,
    options: {
      forceClose?: boolean;
      onHead?(status: number): void;
      onChunk?(chunk: Buffer): void;
    } = {},
  ) {
    super();
    this.forceClose = options.forceClose ?? false;
    this.onHead = options.onHead;
    this.onChunk = options.onChunk;
    response.on('error', this.onResponseError);
    response.on('close', this.onResponseClose);
    this.once('finish', this.cleanupResponseListeners);
    this.once('close', this.cleanupResponseListeners);
  }

  private readonly onHead: ((status: number) => void) | undefined;
  private readonly onChunk: ((chunk: Buffer) => void) | undefined;

  private readonly cleanupResponseListeners = () => {
    this.response.off('error', this.onResponseError);
    this.response.off('close', this.onResponseClose);
  };

  private readonly onResponseError = (error: Error) => {
    this.deliveryCause.markFailure();
    if (!this.destroyed) this.destroy(error);
  };

  private readonly onResponseClose = () => {
    if (this.response.writableFinished) return;
    this.deliveryCause.markCancelled();
    if (!this.destroyed) this.destroy();
  };

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.response.setHeader(name, Array.isArray(value) ? [...value] : value);
    if (name.toLowerCase() === 'connection') {
      const values = Array.isArray(value) ? value : [value];
      if (values.some(item => String(item).split(',').some(token => token.trim().toLowerCase() === 'close'))) {
        this.forceClose = true;
      }
    }
    return this;
  }

  private sendHead(): void {
    if (this.response.headersSent) return;
    if (this.forceClose) {
      this.response.shouldKeepAlive = false;
      this.response.setHeader('Connection', 'close');
    }
    this.response.statusCode = this.statusCode;
    this.onHead?.(this.statusCode);
    this.response.writeHead(this.statusCode);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.sendHead();
    let settled = false;
    let writeReturned = false;
    let writeComplete = false;
    let drainComplete = true;
    const cleanup = () => {
      this.response.off('error', failed);
      this.response.off('close', closed);
      this.response.off('drain', drained);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        this.deliveryCause.markFailure();
        callback(error);
        return;
      }
      this.responseBytes += chunk.length;
      this.onChunk?.(chunk);
      callback();
    };
    const maybeSucceed = () => {
      if (writeReturned && writeComplete && drainComplete) settle();
    };
    const failed = (error: Error) => settle(error);
    const closed = () => settle(destinationClosed());
    const drained = () => {
      drainComplete = true;
      maybeSucceed();
    };
    this.response.once('error', failed);
    this.response.once('close', closed);
    try {
      const accepted = this.response.write(chunk, error => {
        if (error) {
          settle(error);
          return;
        }
        writeComplete = true;
        maybeSucceed();
      });
      drainComplete = accepted;
      if (!accepted) this.response.once('drain', drained);
      writeReturned = true;
      maybeSucceed();
    } catch (error) {
      settle(error instanceof Error ? error : new Error('Response write failed'));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.sendHead();
    let settled = false;
    const cleanup = () => {
      this.response.off('error', failed);
      this.response.off('close', closed);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) this.deliveryCause.markFailure();
      callback(error);
    };
    const failed = (error: Error) => settle(error);
    const closed = () => settle(destinationClosed());
    this.response.once('error', failed);
    this.response.once('close', closed);
    try {
      this.response.end((error: Error | null | undefined) => settle(error ?? undefined));
    } catch (error) {
      settle(error instanceof Error ? error : new Error('Response end failed'));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.cleanupResponseListeners();
    if (error) this.deliveryCause.markFailure();
    if (error && !this.response.destroyed) this.response.destroy(error);
    callback(error);
  }
}
