import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeAuthority } from '../domain/http-origin';
import { generateCA } from './certs';
import { CertCache } from './cert-cache';
import type { RequestAuthority } from './request-authority';
import {
  createNodeBlindTunnelConnector,
  createNodeUpstreamTransport,
  type HeaderTuple,
} from './upstream-transport';

const lookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
}) as net.LookupFunction;

function authority(scheme: 'http' | 'https', hostname: string, port: number): RequestAuthority {
  return {
    origin: normalizeAuthority(scheme, `${hostname}:${port}`),
    rawAuthority: `${hostname}:${port}`,
  };
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return address.port;
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function consume(body: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('Node upstream transport', () => {
  it('streams decoded content-length entities to the incoming authority and exact raw path', async () => {
    let observed!: (value: { url: string; rawHeaders: string[]; chunks: string[] }) => void;
    const requestObserved = new Promise<{ url: string; rawHeaders: string[]; chunks: string[] }>(
      resolve => { observed = resolve; },
    );
    const upstream = http.createServer(async (request, response) => {
      const chunks: string[] = [];
      for await (const chunk of request) chunks.push(chunk.toString());
      observed({ url: request.url!, rawHeaders: [...request.rawHeaders], chunks });
      response.end('accepted');
    });
    const port = await listen(upstream);

    try {
      const response = await createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'api.example.test', port),
        rawRequestTarget: `http://api.example.test:${port}/raw/%2f?q=%2B&z=last&q=first`,
        method: 'POST',
        headers: [
          ['Host', `api.example.test:${port}`],
          ['Content-Length', '11'],
          ['X-Repeat', 'one'],
          ['x-repeat', 'two'],
          ['Connection', 'X-Remove'],
          ['X-Remove', 'private'],
          ['Proxy-Connection', 'keep-alive'],
        ],
        body: Readable.from(['hello ', 'world']),
        signal: new AbortController().signal,
      });

      await expect(requestObserved).resolves.toEqual({
        url: '/raw/%2f?q=%2B&z=last&q=first',
        rawHeaders: expect.arrayContaining([
          'X-Repeat', 'one',
          'x-repeat', 'two',
          'Content-Length', '11',
        ]),
        chunks: ['hello world'],
      });
      const observedHeaders = (await requestObserved).rawHeaders.map(value => value.toLowerCase());
      expect(observedHeaders).not.toContain('x-remove');
      expect(observedHeaders).not.toContain('proxy-connection');
      await expect(consume(response.body)).resolves.toEqual(Buffer.from('accepted'));
    } finally {
      await close(upstream);
    }
  });

  it('reframes unknown-length entity chunks without exposing chunk framing', async () => {
    let observed!: (value: { transferEncoding: string | undefined; chunks: string[] }) => void;
    const requestObserved = new Promise<{ transferEncoding: string | undefined; chunks: string[] }>(
      resolve => { observed = resolve; },
    );
    const upstream = http.createServer(async (request, response) => {
      const chunks: string[] = [];
      for await (const chunk of request) chunks.push(chunk.toString());
      observed({ transferEncoding: request.headers['transfer-encoding'], chunks });
      response.end();
    });
    const port = await listen(upstream);

    try {
      const response = await createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'chunked.example.test', port),
        rawRequestTarget: '/upload',
        method: 'POST',
        headers: [['Transfer-Encoding', 'chunked']],
        body: Readable.from(['first', 'second']),
        signal: new AbortController().signal,
      });
      const observedRequest = await requestObserved;
      expect(observedRequest.transferEncoding).toBe('chunked');
      expect(observedRequest.chunks.join('')).toBe('firstsecond');
      await consume(response.body);
    } finally {
      await close(upstream);
    }
  });

  it('returns response headers and first bytes before the upstream finishes', async () => {
    let releaseLast!: () => void;
    const lastAllowed = new Promise<void>(resolve => { releaseLast = resolve; });
    let firstWritten!: () => void;
    const firstProduced = new Promise<void>(resolve => { firstWritten = resolve; });
    const upstream = http.createServer(async (_request, response) => {
      response.setHeader('Set-Cookie', ['session=one; Path=/', 'theme=dark; Path=/']);
      response.write('first');
      firstWritten();
      await lastAllowed;
      response.end('last');
    });
    const port = await listen(upstream);

    try {
      const responsePromise = createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'stream.example.test', port),
        rawRequestTarget: '/stream',
        method: 'GET',
        headers: [],
        signal: new AbortController().signal,
      });
      await firstProduced;
      const response = await responsePromise;
      expect(response.headers.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
        ['Set-Cookie', 'session=one; Path=/'],
        ['Set-Cookie', 'theme=dark; Path=/'],
      ]);
      const iterator = response.body[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ value: Buffer.from('first'), done: false });
      releaseLast();
      await expect(iterator.next()).resolves.toMatchObject({ value: Buffer.from('last'), done: false });
    } finally {
      releaseLast();
      await close(upstream);
    }
  });

  it('marks close-delimited upstream responses and streams them through slow writable backpressure', async () => {
    const upstream = http.createServer((_request, response) => {
      response.shouldKeepAlive = false;
      response.writeHead(200, { Connection: 'close' });
      response.write('one');
      response.end('two');
    });
    const port = await listen(upstream);

    try {
      const response = await createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'close.example.test', port),
        rawRequestTarget: '/',
        method: 'GET',
        headers: [],
        signal: new AbortController().signal,
      });
      const chunks: Buffer[] = [];
      await pipeline(response.body, new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          setTimeout(callback, 2);
        },
      }));
      expect(response.closeConnection).toBe(true);
      expect(Buffer.concat(chunks).toString()).toBe('onetwo');
    } finally {
      await close(upstream);
    }
  });

  it('aborts the upstream request and source body when the client signal aborts', async () => {
    const upstream = http.createServer(() => {});
    const port = await listen(upstream);
    const controller = new AbortController();
    let destroyed = false;
    const body = new Readable({
      read() { this.push(Buffer.alloc(1024)); },
      destroy(error, callback) { destroyed = true; callback(error); },
    });

    try {
      const forwarding = createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'abort.example.test', port),
        rawRequestTarget: '/upload',
        method: 'POST',
        headers: [],
        body,
        signal: controller.signal,
      });
      controller.abort();
      await expect(forwarding).rejects.toMatchObject({ name: 'AbortError' });
      expect(destroyed).toBe(true);
    } finally {
      body.destroy();
      await close(upstream);
    }
  });

  it('preserves the primary upstream failure when source cleanup throws synchronously', async () => {
    const primary = Object.assign(new Error('primary connect failure'), { code: 'EAI_AGAIN' });
    const failingLookup = ((_hostname: string, _options: unknown, callback: (error: Error) => void) => {
      callback(primary);
    }) as net.LookupFunction;
    const body = new Readable({ read() {} });
    let destroyCalls = 0;
    body.destroy = () => {
      destroyCalls += 1;
      throw new Error('secondary cleanup failure');
    };

    const forwarding = createNodeUpstreamTransport({ lookup: failingLookup }).forward({
      authority: authority('http', 'cleanup.example.test', 80),
      rawRequestTarget: '/upload',
      method: 'POST',
      headers: [],
      body,
      signal: new AbortController().signal,
    });

    await expect(forwarding).rejects.toBe(primary);
    expect(destroyCalls).toBe(1);
    expect(body.listenerCount('error')).toBe(0);
    expect(body.listenerCount('close')).toBe(0);
  });

  it.each(['error', 'silent close'] as const)(
    'keeps an early response primary while owning a later request-body %s',
    async sourceFailure => {
      let releaseResponse!: () => void;
      const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
      const upstream = http.createServer(async (_request, response) => {
        response.writeHead(413, { 'Content-Length': '9', Connection: 'close' });
        response.write('too');
        await responseReleased;
        response.end(' large');
      });
      const port = await listen(upstream);
      let sentFirstChunk = false;
      const body = new Readable({
        read() {
          if (!sentFirstChunk) {
            sentFirstChunk = true;
            this.push('x');
          }
        },
      });
      let destroyCalls = 0;
      const originalDestroy = body.destroy.bind(body);
      body.destroy = error => {
        destroyCalls += 1;
        return originalDestroy(error);
      };
      let outgoing: (NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }) | undefined;
      const originalUnpipe = body.unpipe.bind(body);
      body.unpipe = destination => {
        outgoing = destination;
        return originalUnpipe(destination);
      };
      let unownedError: unknown;
      const controller = new AbortController();

      try {
        const response = await createNodeUpstreamTransport({ lookup }).forward({
          authority: authority('http', 'early-response.example.test', port),
          rawRequestTarget: '/upload',
          method: 'POST',
          headers: [['Content-Length', '1024']],
          body,
          signal: controller.signal,
        });
        const responseBody = consume(response.body);

        if (sourceFailure === 'error') {
          try {
            body.emit('error', new Error('late incoming body failure'));
          } catch (error) {
            unownedError = error;
          }
        } else {
          body.destroy();
        }
        await new Promise(resolve => setImmediate(resolve));

        expect(unownedError).toBeUndefined();
        expect(body.destroyed).toBe(true);
        expect(destroyCalls).toBe(1);
        expect(outgoing).toBeDefined();
        expect(outgoing?.writableEnded || outgoing?.destroyed).toBe(true);
        expect(body.listenerCount('error')).toBe(0);
        expect(body.listenerCount('close')).toBe(0);
        releaseResponse();
        expect(response.statusCode).toBe(413);
        await expect(responseBody).resolves.toEqual(Buffer.from('too large'));
      } finally {
        releaseResponse();
        controller.abort();
        body.destroy();
        await close(upstream);
      }
    },
  );

  it('owns an asynchronous secondary destroy error after an early response and primary source error', async () => {
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
    const upstream = http.createServer(async (_request, response) => {
      response.writeHead(413, { 'Content-Length': '9', Connection: 'close' });
      response.write('too');
      await responseReleased;
      response.end(' large');
    });
    const port = await listen(upstream);
    const primary = new Error('primary incoming body failure');
    const secondary = new Error('secondary asynchronous cleanup failure');
    let completeDestroy!: () => void;
    let destroyStarted!: () => void;
    const destroying = new Promise<void>(resolve => { destroyStarted = resolve; });
    let sentFirstChunk = false;
    let destroyCalls = 0;
    const body = new Readable({
      read() {
        if (!sentFirstChunk) {
          sentFirstChunk = true;
          this.push('x');
        }
      },
      destroy(_error, callback) {
        destroyCalls += 1;
        completeDestroy = () => callback(secondary);
        destroyStarted();
      },
    });
    let outgoing: (NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }) | undefined;
    const originalUnpipe = body.unpipe.bind(body);
    body.unpipe = destination => {
      outgoing = destination;
      return originalUnpipe(destination);
    };
    let sourceClosed = false;
    body.once('close', () => { sourceClosed = true; });
    const controller = new AbortController();

    try {
      const response = await createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'async-cleanup.example.test', port),
        rawRequestTarget: '/upload',
        method: 'POST',
        headers: [['Content-Length', '1024']],
        body,
        signal: controller.signal,
      });
      const responseBody = consume(response.body);

      expect(() => body.emit('error', primary)).not.toThrow();
      await destroying;
      expect(destroyCalls).toBe(1);
      expect(body.destroyed).toBe(true);
      expect(outgoing).toBeDefined();
      expect(outgoing?.writableEnded || outgoing?.destroyed).toBe(true);

      completeDestroy();
      await new Promise(resolve => setImmediate(resolve));
      expect(sourceClosed).toBe(true);
      expect(body.listenerCount('error')).toBe(0);
      expect(body.listenerCount('close')).toBe(0);

      releaseResponse();
      expect(response.statusCode).toBe(413);
      await expect(responseBody).resolves.toEqual(Buffer.from('too large'));
    } finally {
      releaseResponse();
      controller.abort();
      body.destroy();
      await close(upstream);
    }
  });

  it('settles asynchronous destroy ownership when the source does not emit close', async () => {
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
    const upstream = http.createServer(async (_request, response) => {
      response.writeHead(413, { 'Content-Length': '9', Connection: 'close' });
      response.write('too');
      await responseReleased;
      response.end(' large');
    });
    const port = await listen(upstream);
    const primary = new Error('primary no-close body failure');
    const secondary = new Error('secondary no-close cleanup failure');
    let completeDestroy!: () => void;
    let destroyStarted!: () => void;
    const destroying = new Promise<void>(resolve => { destroyStarted = resolve; });
    let sentFirstChunk = false;
    let destroyCalls = 0;
    const body = new Readable({
      emitClose: false,
      read() {
        if (!sentFirstChunk) {
          sentFirstChunk = true;
          this.push('x');
        }
      },
      destroy(_error, callback) {
        destroyCalls += 1;
        completeDestroy = () => callback(secondary);
        destroyStarted();
      },
    });
    let outgoing: (NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }) | undefined;
    const originalUnpipe = body.unpipe.bind(body);
    body.unpipe = destination => {
      outgoing = destination;
      return originalUnpipe(destination);
    };
    let closeEvents = 0;
    const observeClose = () => { closeEvents += 1; };
    body.on('close', observeClose);
    const controller = new AbortController();

    try {
      const response = await createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'no-close-cleanup.example.test', port),
        rawRequestTarget: '/upload',
        method: 'POST',
        headers: [['Content-Length', '1024']],
        body,
        signal: controller.signal,
      });
      const responseBody = consume(response.body);

      expect(() => body.emit('error', primary)).not.toThrow();
      await destroying;
      expect(destroyCalls).toBe(1);
      expect(body.destroyed).toBe(true);
      expect(outgoing).toBeDefined();
      expect(outgoing?.writableEnded || outgoing?.destroyed).toBe(true);

      completeDestroy();
      await new Promise(resolve => setImmediate(resolve));
      body.off('close', observeClose);
      expect(closeEvents).toBe(0);
      expect(body.listenerCount('error')).toBe(0);
      expect(body.listenerCount('close')).toBe(0);

      releaseResponse();
      expect(response.statusCode).toBe(413);
      await expect(responseBody).resolves.toEqual(Buffer.from('too large'));
    } finally {
      body.off('close', observeClose);
      releaseResponse();
      controller.abort();
      body.destroy();
      await close(upstream);
    }
  });

  it('stops pulling a slow incoming body while the upstream request is backpressured', async () => {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let upstreamReady!: () => void;
    const upstreamReceived = new Promise<void>(resolve => { upstreamReady = resolve; });
    const upstream = http.createServer(async (request, response) => {
      request.pause();
      upstreamReady();
      await released;
      const drained = new Promise<void>(resolve => request.once('end', resolve));
      request.resume();
      await drained;
      response.end('accepted');
    });
    const port = await listen(upstream);
    const chunk = Buffer.alloc(64 * 1024);
    const chunkCount = 256;
    let emitted = 0;
    const body = new Readable({
      highWaterMark: chunk.length,
      read() {
        if (emitted >= chunkCount) this.push(null);
        else {
          emitted += 1;
          this.push(chunk);
        }
      },
    });

    try {
      const forwarding = createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'slow-upload.example.test', port),
        rawRequestTarget: '/upload',
        method: 'POST',
        headers: [['Content-Length', String(chunk.length * chunkCount)]],
        body,
        signal: new AbortController().signal,
      });
      await upstreamReceived;
      await new Promise(resolve => setImmediate(resolve));
      expect(emitted).toBeLessThan(chunkCount);
      release();
      const response = await forwarding;
      await expect(consume(response.body)).resolves.toEqual(Buffer.from('accepted'));
    } finally {
      release();
      body.destroy();
      await close(upstream);
    }
  });

  it('surfaces an upstream abort on the streaming response body', async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '10' });
      response.flushHeaders();
      response.write('part');
      setImmediate(() => response.socket!.destroy());
    });
    const port = await listen(upstream);

    try {
      const response = await createNodeUpstreamTransport({ lookup }).forward({
        authority: authority('http', 'abort.example.test', port),
        rawRequestTarget: '/',
        method: 'GET',
        headers: [],
        signal: new AbortController().signal,
      });
      await expect(consume(response.body)).rejects.toBeTruthy();
    } finally {
      await close(upstream);
    }
  });

  it('verifies HTTPS with an injected test CA and never disables verification', async () => {
    const ca = generateCA();
    const leaf = new CertCache({ maxSize: 1, caCert: ca.cert, caKey: ca.privateKey })
      .getCert('secure.example.test');
    const upstream = https.createServer({ key: leaf.privateKey, cert: leaf.cert }, (_request, response) => {
      response.end('secure');
    });
    const port = await listen(upstream);
    const request = {
      authority: authority('https', 'secure.example.test', port),
      rawRequestTarget: '/',
      method: 'GET',
      headers: [] as HeaderTuple[],
      signal: new AbortController().signal,
    };

    try {
      await expect(createNodeUpstreamTransport({ lookup }).forward(request)).rejects.toBeTruthy();
      const response = await createNodeUpstreamTransport({ lookup, ca: ca.cert }).forward(request);
      await expect(consume(response.body)).resolves.toEqual(Buffer.from('secure'));
    } finally {
      await close(upstream);
    }
  });

  it('uses the injected DNS owner for blind tunnels and honors abort', async () => {
    const upstream = net.createServer(socket => socket.end('connected'));
    const port = await listen(upstream);

    try {
      const connector = createNodeBlindTunnelConnector({ lookup });
      let socket: net.Socket | undefined;
      await connector.connect(
        authority('https', 'blind.example.test', port),
        new AbortController().signal,
        connected => {
          socket = connected;
          connected.once('error', () => {});
        },
      );
      if (!socket) throw new Error('Blind connector did not claim its socket');
      await expect(consume(socket)).resolves.toEqual(Buffer.from('connected'));

      const controller = new AbortController();
      controller.abort();
      await expect(connector.connect(
        authority('https', 'blind.example.test', port),
        controller.signal,
        connected => connected.destroy(),
      ))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await close(upstream);
    }
  });

  it('does not contain whole-body buffering APIs', async () => {
    const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), 'upstream-transport.ts');
    const source = await fs.promises.readFile(filename, 'utf8');

    expect(source).not.toContain('arrayBuffer(');
    expect(source).not.toContain('Buffer.concat(');
  });
});
