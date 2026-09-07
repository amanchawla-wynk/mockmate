import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepository } from '../repository/project-repository';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
  type TrafficService,
} from '../runtime/create-runtime';
import { generateCA } from './certs';
import { CertCache } from './cert-cache';
import { createProxyServer } from './proxy-server';
import type { BlindTunnelConnector, UpstreamTransport } from './upstream-transport';
import {
  requestConnectProxy,
  connectProxySocket,
  openTlsProxyConnection,
  openTlsProxyConnectionWithConnectHead,
  requestPlainProxy,
  readProxyResponse,
  requestTlsProxy,
} from '../test-support/proxy-test-client';

describe('proxy server canonical failure boundaries', () => {
  let root: string;
  let runtime: RuntimeContext;
  let repository: ProjectRepository;
  let ca: ReturnType<typeof generateCA>;
  const closes: Array<() => Promise<void>> = [];

  beforeAll(() => {
    ca = generateCA();
  });

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-proxy-server-'));
    runtime = await createRuntime({
      rootDirectory: root,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    repository = runtime.repository;
  });

  afterEach(async () => {
    await Promise.all(closes.splice(0).map(close => close()));
    await runtime.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  afterAll(() => {
    ca = undefined as never;
  });

  const lookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }) as net.LookupFunction;

  async function startProxy(
    candidate: ProjectRepository = repository,
    options: Pick<Parameters<typeof createProxyServer>[0], 'upstream' | 'upstreamTransport' | 'blindTunnel'> & {
      traffic?: TrafficService;
    } = {},
  ): Promise<number> {
    const proxy = await createProxyServer({
      port: 0,
      caCert: ca.cert,
      caKey: ca.privateKey,
      repository: candidate,
      traffic: options.traffic ?? runtime.traffic,
      ...options,
    });
    closes.push(proxy.close);
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP port');
    return address.port;
  }

  async function setInterceptHosts(
    projectId: string,
    interceptHosts: string[],
    captureRawTraffic?: boolean,
  ): Promise<void> {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts,
      captureRawTraffic: captureRawTraffic ?? settings.captureRawTraffic,
      debugProvenanceHeaders: settings.debugProvenanceHeaders,
      expectedRevision: settings.revision,
    });
  }

  it('fails plain HTTP closed without an active Project before contacting upstream', async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamRequests += 1;
      res.end('unexpected');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');

    const response = await requestPlainProxy(await startProxy(), {
      host: `127.0.0.1:${address.port}`,
      path: '/must-not-forward',
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      code: 'NO_ACTIVE_PROJECT',
      message: 'No active Project is selected',
      requestId: response.headers['x-request-id'],
    });
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(upstreamRequests).toBe(0);
  });

  it('forwards mockmate.test to its incoming authority without a control-origin override', async () => {
    const project = await repository.createProject({ name: 'Authority-owned control hostname' });
    await repository.setActiveProject(project.id, 0);
    const upstream = http.createServer((request, response) => {
      response.setHeader('Set-Cookie', ['session=one; Path=/', 'theme=dark; Path=/']);
      response.end(`authority:${request.url}`);
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');

    const result = await requestPlainProxy(await startProxy(repository, { upstream: { lookup } }), {
      host: `mockmate.test:${address.port}`, path: '/api/control',
    });

    expect(result.body.toString()).toBe('authority:/api/control');
    expect(result.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['Set-Cookie', 'session=one; Path=/'],
      ['Set-Cookie', 'theme=dark; Path=/'],
    ]);
  });

  it('preserves repeated cookies through transparent plain HTTP forwarding', async () => {
    const project = await repository.createProject({ name: 'Transparent forwarding cookies' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['transparent.example.test']);
    const upstream = http.createServer((_request, response) => {
      response.setHeader('Set-Cookie', ['session=one; Path=/', 'theme=dark; Path=/']);
      response.end('transparent');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');

    const result = await requestPlainProxy(await startProxy(repository, { upstream: { lookup } }), {
      host: `transparent.example.test:${address.port}`, path: '/forwarded',
    });

    expect(result.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['Set-Cookie', 'session=one; Path=/'],
      ['Set-Cookie', 'theme=dark; Path=/'],
    ]);
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const captured = runtime.traffic.get(project.id, trafficId)?.response.headers;
    expect(captured).toEqual(result.rawHeaders.map(([name, value]) => [
      name.toLowerCase(),
      name.toLowerCase() === 'set-cookie' ? '[REDACTED]' : value,
    ]));
  });

  it.each(['clear', 'dispose'] as const)(
    'keeps an active passthrough response intact when Traffic %s cancels capture',
    async lifecycle => {
      const project = await repository.createProject({ name: `Active response ${lifecycle}` });
      const settings = repository.getRuntimeSettings(project.id);
      await repository.updateRuntimeSettings(project.id, {
        expectedRevision: settings.revision,
        interceptHosts: ['active-response.example.test'],
        captureRawTraffic: true,
        debugProvenanceHeaders: false,
      });
      await repository.setActiveProject(project.id, 0);
      const first = Buffer.from('first-response-chunk');
      const second = Buffer.from('second-response-chunk');
      let releaseResponse!: () => void;
      const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
      const upstream = http.createServer(async (_request, response) => {
        response.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': first.length + second.length,
          'X-Upstream': 'complete',
        });
        response.write(first);
        await responseReleased;
        response.end(second);
      });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Upstream did not bind');
      let observed!: () => void;
      const firstObserved = new Promise<void>(resolve => { observed = resolve; });
      const traffic = Object.create(runtime.traffic) as TrafficService;
      traffic.begin = input => {
        const exchange = runtime.traffic.begin(input);
        return {
          ...exchange,
          observeResponse(bytes) {
            exchange.observeResponse(bytes);
            observed();
          },
        };
      };
      const proxyPort = await startProxy(repository, { upstream: { lookup }, traffic });
      const responsePromise = requestPlainProxy(proxyPort, {
        host: `active-response.example.test:${upstreamAddress.port}`,
        path: '/active-response',
      });

      await firstObserved;
      if (lifecycle === 'clear') await runtime.traffic.clear(project.id);
      else await runtime.traffic.dispose();
      releaseResponse();
      const response = await responsePromise;

      expect(response.statusCode).toBe(206);
      expect(response.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-length': String(first.length + second.length),
        'x-upstream': 'complete',
      });
      expect(response.body).toEqual(Buffer.concat([first, second]));
      await new Promise<void>(resolve => setImmediate(resolve));
      if (lifecycle === 'clear') {
        expect(runtime.traffic.list(project.id).entries).toEqual([]);
      } else {
        expect(runtime.traffic.list(project.id).entries).toHaveLength(1);
        const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
        expect(runtime.traffic.get(project.id, trafficId)).toMatchObject({
          status: 499,
          captureState: 'complete',
          request: { body: { state: 'unavailable', reason: 'stream_cancelled' } },
          response: { body: { state: 'unavailable', reason: 'stream_cancelled' } },
          promotion: { state: 'blocked', reason: 'request_cancelled' },
        });
      }
    },
  );

  it('cancels upstream work when the proxy client disconnects before response headers', async () => {
    const project = await repository.createProject({ name: 'Pre-header proxy cancellation' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['cancel.example.test'], true);
    let reached!: () => void;
    const upstreamReached = new Promise<void>(resolve => { reached = resolve; });
    const upstream = http.createServer(request => {
      reached();
      request.resume();
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
    const received: Buffer[] = [];
    socket.on('data', chunk => received.push(Buffer.from(chunk)));
    socket.write([
      `GET http://cancel.example.test:${address.port}/pending HTTP/1.1`,
      `Host: cancel.example.test:${address.port}`,
      '',
      '',
    ].join('\r\n'));
    await upstreamReached;
    socket.destroy();

    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const detail = runtime.traffic.get(project.id, trafficId);
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_cancelled' });
    expect(detail?.upstream?.failure).toBeUndefined();
    expect(Buffer.concat(received)).toEqual(Buffer.alloc(0));
  });

  it('emits exact mock-only provenance headers and strips authored reserved values', async () => {
    const project = await repository.createProject({ name: 'Proxy debug provenance' });
    const endpoint = await repository.createEndpoint(project.id, {
      name: 'Proxy debug',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/debug' },
      mode: 'mock',
      variants: [{
        name: 'Debug response',
        status: 204,
        responseHeaders: { 'X-MockMate-Endpoint': 'spoofed' },
      }],
      defaultVariantIndex: 0,
    });
    const settings = repository.getRuntimeSettings(project.id);
    await repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: true,
    });
    await repository.setActiveProject(project.id, 0);

    const result = await requestPlainProxy(await startProxy(), {
      host: 'api.example.test',
      path: '/debug',
    });

    expect(result.statusCode).toBe(204);
    expect(result.headers['x-mockmate-project']).toBe(project.id);
    expect(result.headers['x-mockmate-endpoint']).toBe(endpoint.id);
    expect(result.headers['x-mockmate-variant']).toBe(endpoint.variants[0]!.id);
    expect(result.headers['x-mockmate-request-id']).toBe(result.headers['x-request-id']);
  });

  it('does not open protocol-bodyless mock assets through the plain proxy', async () => {
    const project = await repository.createProject({ name: 'Proxy bodyless assets' });
    const body = await repository.putBody(
      project.id,
      Readable.from('hidden-proxy-body'),
      { mediaType: 'application/octet-stream' },
      { maxBytes: 32 },
    );
    const empty = await repository.putBody(
      project.id,
      Readable.from([]),
      { mediaType: 'application/vnd.mockmate.empty' },
      { maxBytes: 32 },
    );
    const bodylessCases = [
      { method: 'GET', path: '/proxy-204', status: 204 },
      { method: 'GET', path: '/proxy-205', status: 205 },
      { method: 'GET', path: '/proxy-304', status: 304 },
      { method: 'HEAD', path: '/proxy-head', status: 200 },
    ] as const;
    const cases = [
      ...bodylessCases.map(candidate => ({ ...candidate, bodyAssetId: body.id })),
      { method: 'GET', path: '/proxy-normal', status: 200, bodyAssetId: body.id },
      { method: 'GET', path: '/proxy-empty', status: 200, bodyAssetId: empty.id },
    ] as const;
    for (const candidate of cases) {
      await repository.createEndpoint(project.id, {
        name: candidate.path,
        baseUrl: 'http://api.example.test',
        matcher: { method: candidate.method, path: candidate.path },
        mode: 'mock',
        variants: [{
          name: 'Default',
          status: candidate.status,
          responseHeaders: {
            'X-Case': candidate.path,
            'Transfer-Encoding': 'chunked',
            'X-Repeat': [`${candidate.path}-one`, `${candidate.path}-two`],
          },
          bodyAssetId: candidate.bodyAssetId,
        }],
        defaultVariantIndex: 0,
      });
    }
    await setInterceptHosts(project.id, ['api.example.test'], true);
    await repository.setActiveProject(project.id, 0);
    const openBody = vi.spyOn(repository, 'openBody');
    const proxyPort = await startProxy();
    const send = (method: string, requestPath: string) => new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const outgoing = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: `http://api.example.test${requestPath}`,
        headers: { Host: 'api.example.test', Connection: 'close' },
      }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.once('end', () => resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks),
        }));
      });
      outgoing.once('error', reject);
      outgoing.end();
    });

    const responses = [];
    for (const candidate of cases) responses.push(await send(candidate.method, candidate.path));

    expect(responses.map(response => response.status)).toEqual([204, 205, 304, 200, 200, 200]);
    expect(responses.map(response => response.body.length)).toEqual([0, 0, 0, 0, body.size, 0]);
    expect(responses.map(response => response.headers['content-type'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'application/octet-stream',
      'application/vnd.mockmate.empty',
    ]);
    expect(responses.map(response => response.headers['transfer-encoding']))
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(responses.map(response => response.headers['content-length']))
      .toEqual([undefined, '0', undefined, undefined, String(body.size), '0']);
    expect(openBody.mock.calls.filter(([, bodyId]) => bodyId === body.id)).toHaveLength(1);
    expect(openBody.mock.calls.filter(([, bodyId]) => bodyId === empty.id)).toHaveLength(1);
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(cases.length));
    const details = runtime.traffic.list(project.id).entries
      .map(entry => runtime.traffic.get(project.id, entry.id)!);
    for (const [index, candidate] of cases.entries()) {
      const detail = details.find(entry => entry.path === candidate.path)!;
      const capturedFraming = detail.response.headers.filter(([name]) => (
        name === 'content-length' || name === 'transfer-encoding'
      ));
      expect(capturedFraming).toEqual(responses[index]!.headers['content-length'] === undefined
        ? []
        : [['content-length', responses[index]!.headers['content-length']]]);
      expect(detail.response.headers.filter(([name]) => name === 'x-repeat')).toEqual([
        ['x-repeat', `${candidate.path}-one`],
        ['x-repeat', `${candidate.path}-two`],
      ]);
      if (detail.promotion.state === 'eligible') {
        expect(detail.promotion.review.response.headers).toEqual(detail.response.headers);
        expect(detail.promotion.review.response.headers.some(([name]) => name === 'transfer-encoding'))
          .toBe(false);
      }
    }
    for (const detail of details.filter(candidate => bodylessCases.some(({ path }) => (
      path === candidate.path
    )))) {
      expect(detail).toMatchObject({
        responseBytes: 0,
        response: { body: { state: 'available', observedSize: 0, retainedSize: 0 } },
        promotion: {
          state: 'eligible',
          review: {
            response: { byteCount: 0 },
            variant: { action: 'create' },
          },
        },
      });
    }
    expect(details.find(detail => detail.path === '/proxy-normal')?.promotion).toMatchObject({
      state: 'eligible', review: { variant: { action: 'reuse' } },
    });
    expect(details.find(detail => detail.path === '/proxy-empty')).toMatchObject({
      responseBytes: 0,
      response: {
        body: {
          state: 'available',
          mediaType: 'application/vnd.mockmate.empty',
          observedSize: 0,
          retainedSize: 0,
        },
      },
      promotion: {
        state: 'eligible',
        review: {
          response: { mediaType: 'application/vnd.mockmate.empty', byteCount: 0 },
          variant: { action: 'reuse' },
          warnings: [],
        },
      },
    });
  });

  it('fails an injected informational proxy mock closed without opening its Body Asset', async () => {
    const project = await repository.createProject({ name: 'Proxy informational guard' });
    const body = await repository.putBody(
      project.id,
      Readable.from('proxy-final-body'),
      { mediaType: 'text/plain' },
      { maxBytes: 32 },
    );
    for (const requestPath of ['/proxy-legacy-informational', '/proxy-final-control']) {
      await repository.createEndpoint(project.id, {
        name: requestPath,
        baseUrl: 'http://api.example.test',
        matcher: { method: 'GET', path: requestPath },
        mode: 'mock',
        variants: [{ name: 'Final', status: 200, responseHeaders: {}, bodyAssetId: body.id }],
        defaultVariantIndex: 0,
      });
    }
    await setInterceptHosts(project.id, ['api.example.test'], true);
    await repository.setActiveProject(project.id, 0);
    const resolve = repository.resolve.bind(repository);
    vi.spyOn(repository, 'resolve').mockImplementation((candidateProjectId, matchRequest) => {
      const decision = resolve(candidateProjectId, matchRequest);
      return matchRequest.path === '/proxy-legacy-informational' && decision?.kind === 'mock'
        ? { ...decision, resolved: { ...decision.resolved, status: 103 } }
        : decision;
    });
    const openBody = vi.spyOn(repository, 'openBody');
    const proxyPort = await startProxy();

    const failed = await requestPlainProxy(proxyPort, {
      host: 'api.example.test',
      path: '/proxy-legacy-informational',
    });

    expect(failed.statusCode).toBe(500);
    expect(JSON.parse(failed.body.toString())).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: failed.headers['x-request-id'],
    });
    expect(openBody).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const failedDetail = runtime.traffic.get(
      project.id,
      runtime.traffic.list(project.id).entries[0]!.id,
    );
    expect(failedDetail).toMatchObject({
      path: '/proxy-legacy-informational',
      status: 500,
      decision: 'mock',
      promotion: { state: 'blocked', reason: 'request_failed' },
    });

    const control = await requestPlainProxy(proxyPort, {
      host: 'api.example.test',
      path: '/proxy-final-control',
    });
    expect(control.statusCode).toBe(200);
    expect(control.body.toString()).toBe('proxy-final-body');
    expect(openBody).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(2));
    const controlEntry = runtime.traffic.list(project.id).entries
      .find(entry => entry.path === '/proxy-final-control');
    expect(controlEntry).toMatchObject({ status: 200, responseBytes: body.size });
  });

  it('rejects absolute-form and Host disagreement before upstream I/O', async () => {
    const project = await repository.createProject({ name: 'Authority rejection' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['api.example.test'], true);
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
    const response = readProxyResponse(socket);

    socket.end([
      `GET http://api.example.test:${address.port}/blocked HTTP/1.1`,
      `Host: other.example.test:${address.port}`,
      'Authorization: Bearer authority-private-secret',
      '__proto__: first',
      'Constructor: built',
      'toString: rendered',
      '__PROTO__: second',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));

    const rejected = await response;
    expect(JSON.parse(rejected.body.toString())).toMatchObject({
      code: 'PROXY_HOST_AUTHORITY_MISMATCH',
    });
    expect(upstreamRequests).toBe(0);
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const [entry] = runtime.traffic.list(project.id).entries;
    expect(entry).toMatchObject({
      requestId: rejected.headers['x-request-id'],
      allowlistPattern: 'api.example.test',
      decision: 'failure',
      status: 400,
    });
    const detail = runtime.traffic.get(project.id, entry.id);
    expect(detail?.upstream?.failure).toMatchObject({ code: 'PROXY_HOST_AUTHORITY_MISMATCH' });
    expect(detail?.response.body).toMatchObject({ state: 'available', observedSize: rejected.body.length });
    expect(detail?.request.headers).toContainEqual(['authorization', '[REDACTED]']);
    expect(detail?.request.headers.filter(([name]) => (
      name === '__proto__' || name === 'constructor' || name === 'tostring'
    ))).toEqual([
      ['__proto__', 'first'],
      ['constructor', 'built'],
      ['tostring', 'rendered'],
      ['__proto__', 'second'],
    ]);
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_failed' });
    expect(JSON.stringify(detail)).not.toContain('authority-private-secret');
  });

  it('records an allowlisted malformed authority as one sanitized failure', async () => {
    const project = await repository.createProject({ name: 'Malformed authority rejection' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['api.example.test'], true);
    const socket = await connectProxySocket(await startProxy());
    const response = readProxyResponse(socket);

    socket.end([
      'GET http://api.example.test/blocked HTTP/1.1',
      'Host: api.example.test',
      'Host: api.example.test',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));

    const rejected = await response;
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body.toString())).toMatchObject({ code: 'PROXY_AUTHORITY_INVALID' });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const [entry] = runtime.traffic.list(project.id).entries;
    expect(entry).toMatchObject({
      requestId: rejected.headers['x-request-id'],
      allowlistPattern: 'api.example.test',
      decision: 'failure',
      status: 400,
    });
    expect(runtime.traffic.get(project.id, entry.id)).toMatchObject({
      upstream: { failure: { code: 'PROXY_AUTHORITY_INVALID' } },
      response: { body: { state: 'available', observedSize: rejected.body.length } },
      promotion: { state: 'blocked', reason: 'request_failed' },
    });
  });

  it('records one sanitized failure for an allowlisted CONNECT and inner Host mismatch', async () => {
    const project = await repository.createProject({ name: 'CONNECT authority rejection' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['api.example.test'], true);
    const secure = await openTlsProxyConnection(await startProxy(), 'api.example.test', ca.cert);
    const pending = readProxyResponse(secure);

    secure.end([
      'GET /blocked HTTP/1.1',
      'Host: other.example.test',
      'Authorization: Bearer connect-private-secret',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));

    const rejected = await pending;
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body.toString())).toMatchObject({
      code: 'PROXY_CONNECT_AUTHORITY_MISMATCH',
    });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const [entry] = runtime.traffic.list(project.id).entries;
    expect(entry).toMatchObject({
      requestId: rejected.headers['x-request-id'],
      allowlistPattern: 'api.example.test',
      decision: 'failure',
      status: 400,
    });
    expect(runtime.traffic.get(project.id, entry.id)?.upstream?.failure)
      .toMatchObject({ code: 'PROXY_CONNECT_AUTHORITY_MISMATCH' });
    const detail = runtime.traffic.get(project.id, entry.id);
    expect(detail?.response.body).toMatchObject({ state: 'available', observedSize: rejected.body.length });
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_failed' });
    expect(JSON.stringify(detail)).not.toContain('connect-private-secret');
  });

  it('records one sanitized failure for invalid tunneled authority context', async () => {
    const project = await repository.createProject({ name: 'Invalid CONNECT context' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['api.example.test'], true);
    const secure = await openTlsProxyConnection(await startProxy(), 'api.example.test', ca.cert);
    const pending = readProxyResponse(secure);

    secure.end([
      'GET /blocked HTTP/1.1',
      'Host: invalid authority',
      'Cookie: session=connect-context-private-secret',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));

    const rejected = await pending;
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body.toString())).toMatchObject({ code: 'PROXY_AUTHORITY_INVALID' });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const [entry] = runtime.traffic.list(project.id).entries;
    expect(entry).toMatchObject({
      requestId: rejected.headers['x-request-id'],
      allowlistPattern: 'api.example.test',
      decision: 'failure',
      status: 400,
    });
    const detail = runtime.traffic.get(project.id, entry.id);
    expect(detail).toMatchObject({
      upstream: { failure: { code: 'PROXY_AUTHORITY_INVALID' } },
      response: { body: { state: 'available', observedSize: rejected.body.length } },
      promotion: { state: 'blocked', reason: 'request_failed' },
    });
    expect(JSON.stringify(detail)).not.toContain('connect-context-private-secret');
  });

  it('maps an upstream connection failure to a sanitized 502', async () => {
    const project = await repository.createProject({ name: 'Upstream failure' });
    await repository.setActiveProject(project.id, 0);
    const unavailable = http.createServer();
    await new Promise<void>(resolve => unavailable.listen(0, '127.0.0.1', resolve));
    const address = unavailable.address();
    if (!address || typeof address === 'string') throw new Error('Unavailable server did not bind');
    await new Promise<void>(resolve => unavailable.close(() => resolve()));

    const response = await requestPlainProxy(
      await startProxy(repository, { upstream: { lookup } }),
      { host: `unavailable.example.test:${address.port}`, path: '/failure' },
    );

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body.toString())).toMatchObject({
      code: 'UPSTREAM_FAILURE',
      message: 'Upstream request failed',
    });
  });

  it('uses Node framing ownership for chunked entities and rejects conflicting framing', async () => {
    const project = await repository.createProject({ name: 'Framing ownership' });
    await repository.setActiveProject(project.id, 0);
    const bodies: string[] = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString());
      response.end('accepted');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const proxyPort = await startProxy(repository, { upstream: { lookup } });

    const valid = await connectProxySocket(proxyPort);
    const validResponse = readProxyResponse(valid);
    valid.write([
      `POST http://chunked.example.test:${address.port}/upload HTTP/1.1`,
      `Host: chunked.example.test:${address.port}`,
      'Transfer-Encoding: chunked',
      '',
      '5',
      'hello',
      '6',
      ' world',
      '0',
      '',
      '',
    ].join('\r\n'));
    expect((await validResponse).body.toString()).toBe('accepted');
    expect(bodies).toEqual(['hello world']);
    valid.destroy();

    const invalid = await connectProxySocket(proxyPort);
    const invalidResponse = readProxyResponse(invalid);
    invalid.end([
      `POST http://chunked.example.test:${address.port}/blocked HTTP/1.1`,
      `Host: chunked.example.test:${address.port}`,
      'Content-Length: 4',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '0',
      '',
      '',
    ].join('\r\n'));
    expect((await invalidResponse).statusCode).toBe(400);
    expect(bodies).toEqual(['hello world']);
  });

  it('cleans per-request listeners across sequential proxy keep-alive requests', async () => {
    const project = await repository.createProject({ name: 'Keep-alive listener cleanup' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['keepalive.example.test']);
    const upstream = http.createServer((request, response) => response.end(request.url));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const warnings: Error[] = [];
    const captureWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', captureWarning);
    const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
    try {
      for (let index = 0; index < 25; index += 1) {
        const response = readProxyResponse(socket);
        socket.write([
          `GET http://keepalive.example.test:${address.port}/request-${index} HTTP/1.1`,
          `Host: keepalive.example.test:${address.port}`,
          '',
          '',
        ].join('\r\n'));
        await expect(response).resolves.toMatchObject({
          statusCode: 200,
          body: Buffer.from(`/request-${index}`),
        });
      }
      await vi.waitFor(
        () => expect(runtime.traffic.list(project.id).entries).toHaveLength(25),
        { timeout: 3_000 },
      );
      expect(warnings.filter(warning => warning.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', captureWarning);
      socket.destroy();
    }
  });

  it('delivers an early upstream response before finalizing the exact client request entity', async () => {
    const project = await repository.createProject({ name: 'Early response upload ownership' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['early.example.test'], true);
    let firstObserved!: () => void;
    const upstreamObservedFirst = new Promise<void>(resolve => { firstObserved = resolve; });
    const upstream = http.createServer((request, response) => {
      request.once('data', () => {
        firstObserved();
        response.writeHead(413, { 'Content-Length': '2' });
        response.end('no');
      });
      request.resume();
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
    const response = readProxyResponse(socket);
    const first = Buffer.from('first-');
    const second = Buffer.from('second');
    socket.write(Buffer.concat([
      Buffer.from([
        `POST http://early.example.test:${address.port}/upload HTTP/1.1`,
        `Host: early.example.test:${address.port}`,
        `Content-Length: ${first.length + second.length}`,
        '',
        '',
      ].join('\r\n')),
      first,
    ]));

    await upstreamObservedFirst;
    await expect(response).resolves.toMatchObject({ statusCode: 413, body: Buffer.from('no') });
    expect(runtime.traffic.list(project.id).entries).toEqual([]);

    socket.write(second);
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const detail = runtime.traffic.get(project.id, trafficId);
    expect(detail?.request.body).toMatchObject({
      state: 'available', observedSize: first.length + second.length,
    });
    const opened = await runtime.traffic.openBody(project.id, trafficId, 'request');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.lease.openStream()) chunks.push(Buffer.from(chunk));
    await opened.lease.release();
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([first, second]));
    expect(runtime.traffic.list(project.id).entries).toHaveLength(1);
    socket.destroy();
  });

  it('never publishes an available request prefix when an early upstream response closes upload', async () => {
    const project = await repository.createProject({ name: 'Early upload close' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['early-close.example.test'], true);
    const upstream = http.createServer((request, response) => {
      request.once('data', () => {
        response.writeHead(413, { 'Content-Length': '2', Connection: 'close' });
        response.end('no');
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
    const first = Buffer.from('prefix');
    const response = readProxyResponse(socket);
    socket.write(Buffer.concat([
      Buffer.from([
        `POST http://early-close.example.test:${address.port}/upload HTTP/1.1`,
        `Host: early-close.example.test:${address.port}`,
        'Content-Length: 1024',
        '',
        '',
      ].join('\r\n')),
      first,
    ]));

    await expect(response).resolves.toMatchObject({ statusCode: 413, body: Buffer.from('no') });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const detail = runtime.traffic.get(project.id, trafficId);
    expect(detail?.request.body).toMatchObject({
      state: 'unavailable', reason: 'stream_cancelled', observedSize: first.length,
    });
    expect(detail?.request.body).not.toHaveProperty('sha256');
    expect(runtime.traffic.list(project.id).entries).toHaveLength(1);
    socket.destroy();
  });

  it('captures a complete unknown-length request after its upstream response arrives', async () => {
    const project = await repository.createProject({ name: 'Unknown-length early response' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['chunked-early.example.test'], true);
    const upstream = http.createServer((request, response) => {
      request.once('data', () => response.end('ok'));
      request.resume();
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
    const response = readProxyResponse(socket);
    socket.write([
      `POST http://chunked-early.example.test:${address.port}/upload HTTP/1.1`,
      `Host: chunked-early.example.test:${address.port}`,
      'Transfer-Encoding: chunked',
      '',
      '5',
      'first',
      '',
    ].join('\r\n'));

    await expect(response).resolves.toMatchObject({ statusCode: 200, body: Buffer.from('ok') });
    expect(runtime.traffic.list(project.id).entries).toEqual([]);
    socket.write(['6', 'second', '0', '', ''].join('\r\n'));
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    expect(runtime.traffic.get(project.id, trafficId)?.request.body).toMatchObject({
      state: 'available', observedSize: 11,
    });
    const opened = await runtime.traffic.openBody(project.id, trafficId, 'request');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.lease.openStream()) chunks.push(Buffer.from(chunk));
    await opened.lease.release();
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('firstsecond'));
    socket.destroy();
  });

  it('delivers an upstream failure before an incomplete client upload settles', async () => {
    const project = await repository.createProject({ name: 'Early upstream upload failure' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['upstream-failure.example.test'], true);
    const upstreamTransport: UpstreamTransport = {
      forward: vi.fn(request => new Promise((_resolve, reject) => {
        request.body?.once('data', () => reject(new Error('/private/upstream-prefix')));
      })),
    };
    const socket = await connectProxySocket(await startProxy(repository, { upstreamTransport }));
    const response = readProxyResponse(socket);
    const prefix = Buffer.from('partial-upload');
    socket.write(Buffer.concat([
      Buffer.from([
        'POST http://upstream-failure.example.test/upload HTTP/1.1',
        'Host: upstream-failure.example.test',
        'Content-Length: 1024',
        '',
        '',
      ].join('\r\n')),
      prefix,
    ]));

    const delivered = await Promise.race([
      response,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('Proxy error response waited for upload completion')),
        250,
      )),
    ]);
    expect(delivered).toMatchObject({ statusCode: 502 });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const detail = runtime.traffic.get(project.id, trafficId);
    expect(detail).toMatchObject({
      request: {
        body: { state: 'unavailable', reason: 'body_unobservable', observedSize: prefix.length },
      },
      responseBytes: delivered.body.length,
      response: { body: { state: 'available', observedSize: delivered.body.length } },
      promotion: { state: 'blocked', reason: 'request_failed' },
      upstream: { failure: { code: 'UPSTREAM_FAILURE', message: 'Upstream request failed' } },
    });
    expect(detail?.request.body).not.toHaveProperty('sha256');
    expect(runtime.traffic.list(project.id).entries).toHaveLength(1);
    socket.destroy();
  });

  it('does not claim a canonical proxy error body when its write callback fails', async () => {
    const project = await repository.createProject({ name: 'Proxy error destination failure' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['proxy-error.example.test'], true);
    const upstreamTransport: UpstreamTransport = {
      forward: vi.fn(async () => { throw new Error('/private/upstream-failure'); }),
    };
    const requestTarget = 'http://proxy-error.example.test/failure';
    const destinationFailure = new Error('/private/proxy-error-destination');
    const originalWrite = http.ServerResponse.prototype.write;
    const write = vi.spyOn(http.ServerResponse.prototype, 'write').mockImplementation(function (
      this: http.ServerResponse,
      chunk: unknown,
      ...arguments_: unknown[]
    ) {
      if (this.req.url !== requestTarget) {
        return Reflect.apply(originalWrite, this, [chunk, ...arguments_]) as boolean;
      }
      const callback = arguments_.find(value => typeof value === 'function') as
        | ((error?: Error) => void)
        | undefined;
      setImmediate(() => callback?.(destinationFailure));
      return true;
    });
    try {
      const socket = await connectProxySocket(await startProxy(repository, { upstreamTransport }));
      const response = readProxyResponse(socket);
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: proxy-error.example.test\r\n\r\n`);
      await expect(response).rejects.toThrow('Proxy closed before a complete response');
      await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
      const detail = runtime.traffic.get(project.id, runtime.traffic.list(project.id).entries[0]!.id);
      expect(detail).toMatchObject({
        responseBytes: 0,
        response: { body: { state: 'unavailable', observedSize: 0 } },
        promotion: { state: 'blocked', reason: 'request_failed' },
        upstream: { failure: { code: 'UPSTREAM_FAILURE', message: 'Upstream request failed' } },
      });
      expect(JSON.stringify(detail)).not.toContain('/private/');
      socket.destroy();
    } finally {
      write.mockRestore();
    }
  });

  it('delivers an upstream timeout before an incomplete client upload settles', async () => {
    const project = await repository.createProject({ name: 'Early upstream upload timeout' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['upstream-timeout.example.test'], true);
    const upstreamTransport: UpstreamTransport = {
      forward: vi.fn(request => new Promise((_resolve, reject) => {
        request.body?.once('data', () => reject(Object.assign(
          new Error('/private/upstream-timeout'),
          { code: 'UPSTREAM_TIMEOUT' },
        )));
      })),
    };
    const socket = await connectProxySocket(await startProxy(repository, { upstreamTransport }));
    const response = readProxyResponse(socket);
    socket.write([
      'POST http://upstream-timeout.example.test/upload HTTP/1.1',
      'Host: upstream-timeout.example.test',
      'Content-Length: 1024',
      '',
      'prefix',
    ].join('\r\n'));

    const delivered = await Promise.race([
      response,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('Proxy timeout response waited for upload completion')),
        250,
      )),
    ]);
    expect(delivered.statusCode).toBe(504);
    expect(JSON.parse(delivered.body.toString())).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const detail = runtime.traffic.get(project.id, runtime.traffic.list(project.id).entries[0]!.id);
    expect(detail).toMatchObject({
      request: { body: { state: 'unavailable', reason: 'body_unobservable' } },
      promotion: { state: 'blocked', reason: 'request_failed' },
      upstream: { failure: { code: 'UPSTREAM_TIMEOUT', message: 'Upstream request timed out' } },
    });
    socket.destroy();
  });

  it('fails CONNECT closed without an active Project before opening an upstream tunnel', async () => {
    let upstreamConnections = 0;
    const upstream = http.createServer();
    upstream.on('connection', () => { upstreamConnections += 1; });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');

    const response = await requestConnectProxy(await startProxy(), `127.0.0.1:${address.port}`);

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({
      code: 'NO_ACTIVE_PROJECT', requestId: response.headers['x-request-id'],
    });
    expect(upstreamConnections).toBe(0);
  });

  it('maps a blind pre-connect failure to sanitized 502 before CONNECT establishment', async () => {
    const project = await repository.createProject({ name: 'Blind connect failure' });
    await repository.setActiveProject(project.id, 0);
    const primary = Object.assign(new Error('/secret/connect-owner'), { code: 'ECONNREFUSED' });
    const connector: BlindTunnelConnector = { connect: vi.fn(() => { throw primary; }) };
    let clearCalls = 0;
    const timers = {
      setTimeout: () => Symbol('tunnel-timeout'),
      clearTimeout: () => { clearCalls += 1; },
    };
    const failingLookup = ((_hostname: string, _options: unknown, callback: (error: Error) => void) => {
      callback(primary);
    }) as net.LookupFunction;

    const response = await requestConnectProxy(
      await startProxy(repository, {
        blindTunnel: { lookup: failingLookup, connector, timers },
      }),
      'blind-failure.example.test:443',
    );

    expect(response.statusCode).toBe(502);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(JSON.parse(response.body.toString())).toEqual({
      code: 'UPSTREAM_FAILURE',
      message: 'Upstream request failed',
      requestId: response.headers['x-request-id'],
    });
    expect(response.body.toString()).not.toContain('/secret/connect-owner');
    expect(clearCalls).toBe(1);
  });

  it('times out a pending blind connection after the fixed production deadline', async () => {
    const project = await repository.createProject({ name: 'Blind connect timeout' });
    await repository.setActiveProject(project.id, 0);
    const connector: BlindTunnelConnector = { connect: () => new Promise<void>(() => {}) };
    let timeoutCallback: (() => void) | undefined;
    let timeoutMilliseconds: number | undefined;
    let clearCalls = 0;
    let timerRegistered!: () => void;
    const registered = new Promise<void>(resolve => { timerRegistered = resolve; });
    const timers = {
      setTimeout(callback: () => void, milliseconds: number) {
        timeoutCallback = callback;
        timeoutMilliseconds = milliseconds;
        timerRegistered();
        return Symbol('tunnel-timeout');
      },
      clearTimeout() { clearCalls += 1; },
    };
    const socket = await connectProxySocket(await startProxy(repository, {
      blindTunnel: { connector, timers },
    }));
    const response = readProxyResponse(socket);

    try {
      socket.write('CONNECT blind-timeout.example.test:443 HTTP/1.1\r\nHost: blind-timeout.example.test:443\r\n\r\n');
      await registered;
      expect(timeoutMilliseconds).toBe(30_000);
      expect(timeoutCallback).toBeTypeOf('function');
      timeoutCallback!();
      const result = await response;
      expect(result.statusCode).toBe(504);
      expect(JSON.parse(result.body.toString())).toEqual({
        code: 'UPSTREAM_TIMEOUT',
        message: 'Upstream request timed out',
        requestId: result.headers['x-request-id'],
      });
      expect(clearCalls).toBe(1);
    } finally {
      socket.destroy();
    }
  });

  it('owns post-connect blind socket errors and tears down both sides without another response', async () => {
    const project = await repository.createProject({ name: 'Blind established failure' });
    await repository.setActiveProject(project.id, 0);
    const target = net.createServer();
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => target.close(() => resolve())));
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('Blind target did not bind');
    const upstream = new PassThrough() as unknown as net.Socket;
    const connector: BlindTunnelConnector = {
      connect: vi.fn((_authority, _signal, claim) => {
        claim(upstream);
        return Promise.resolve();
      }),
    };
    const socket = await connectProxySocket(await startProxy(repository, {
      blindTunnel: { lookup, connector },
    }));
    const established = readProxyResponse(socket);
    const afterEstablished: Buffer[] = [];

    try {
      const authority = `blind-error.example.test:${address.port}`;
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      expect((await established).statusCode).toBe(200);
      socket.on('data', chunk => afterEstablished.push(Buffer.from(chunk)));
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      expect(() => upstream.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
        .not.toThrow();
      await closed;
      expect(upstream.destroyed).toBe(true);
      expect(Buffer.concat(afterEstablished).toString()).not.toContain('HTTP/1.1');
    } finally {
      socket.destroy();
      upstream.destroy();
    }
  });

  it('installs blind socket ownership synchronously during connector handoff', async () => {
    const project = await repository.createProject({ name: 'Blind handoff ownership' });
    await repository.setActiveProject(project.id, 0);
    const upstream = new PassThrough() as unknown as net.Socket;
    const gapError = Object.assign(new Error('/secret/handoff-gap'), { code: 'ECONNRESET' });
    const connector: BlindTunnelConnector = {
      connect(
        _authority,
        _signal: AbortSignal,
        claim: (socket: net.Socket) => void,
      ): Promise<void> {
        claim(upstream);
        queueMicrotask(() => upstream.emit('error', gapError));
        return Promise.resolve();
      },
    };

    const response = await requestConnectProxy(
      await startProxy(repository, { blindTunnel: { connector } }),
      'blind-handoff.example.test:443',
    );

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body.toString())).toEqual({
      code: 'UPSTREAM_FAILURE',
      message: 'Upstream request failed',
      requestId: response.headers['x-request-id'],
    });
    expect(response.body.toString()).not.toContain('/secret/handoff-gap');
    expect(upstream.destroyed).toBe(true);
  });

  it('accepts a bracketed IPv6 CONNECT authority without crashing', async () => {
    const project = await repository.createProject({ name: 'IPv6 CONNECT' });
    await setInterceptHosts(project.id, ['2001:db8::1']);
    await repository.setActiveProject(project.id, 0);

    const response = await requestConnectProxy(await startProxy(), '[2001:db8::1]:443');

    expect(response.statusCode).toBe(200);
  });

  it('rejects an out-of-range CONNECT port without crashing', async () => {
    const project = await repository.createProject({ name: 'Invalid CONNECT port' });
    await repository.setActiveProject(project.id, 0);

    const response = await requestConnectProxy(await startProxy(), 'example.test:65536');

    expect(response.statusCode).toBe(400);
  });

  it('writes CONNECT head bytes to blind upstream before later client bytes', async () => {
    const project = await repository.createProject({ name: 'Blind CONNECT head' });
    await repository.setActiveProject(project.id, 0);
    let observed!: (bytes: Buffer) => void;
    const firstUpstreamBytes = new Promise<Buffer>(resolve => { observed = resolve; });
    const upstream = net.createServer(socket => socket.once('data', chunk => observed(Buffer.from(chunk))));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const socket = await connectProxySocket(await startProxy(repository, { blindTunnel: { lookup } }));
    const established = readProxyResponse(socket);

    try {
      const authority = `blind.example.test:${address.port}`;
      socket.write(Buffer.concat([
        Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
        Buffer.from('head-bytes'),
      ]));
      expect((await established).statusCode).toBe(200);
      expect(await firstUpstreamBytes).toEqual(Buffer.from('head-bytes'));
    } finally {
      socket.destroy();
    }
  });

  it('feeds coalesced CONNECT head bytes into selected MITM TLS parsing', async () => {
    const project = await repository.createProject({ name: 'Selected CONNECT head' });
    await setInterceptHosts(project.id, ['head.example.test']);
    await repository.createEndpoint(project.id, {
      name: 'Head selected',
      baseUrl: 'https://head.example.test',
      matcher: { method: 'GET', path: '/head' },
      mode: 'mock',
      variants: [{ name: 'Default', status: 204, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    await repository.setActiveProject(project.id, 0);
    const socket = await openTlsProxyConnectionWithConnectHead(
      await startProxy(),
      'head.example.test',
      ca.cert,
    );

    try {
      const response = readProxyResponse(socket);
      socket.end('GET /head HTTP/1.1\r\nHost: head.example.test\r\nConnection: close\r\n\r\n');
      expect((await response).statusCode).toBe(204);
    } finally {
      socket.destroy();
    }
  });

  it('sanitizes intercepted TLS failures and includes the same request ID in header and body', async () => {
    const project = await repository.createProject({ name: 'TLS errors' });
    await setInterceptHosts(project.id, ['api.example.test']);
    const body = await repository.putBody(
      project.id,
      Readable.from('safe'),
      { mediaType: 'text/plain' },
      { maxBytes: 16 },
    );
    await repository.createEndpoint(project.id, {
      name: 'Failure', baseUrl: 'https://api.example.test', mode: 'mock',
      matcher: { method: 'GET', path: '/failure' },
      variants: [{
        name: 'Default',
        status: 200,
        responseHeaders: { 'X-Authored': 'must-not-leak' },
        bodyAssetId: body.id,
      }],
      defaultVariantIndex: 0,
    });
    const settings = repository.getRuntimeSettings(project.id);
    await repository.updateRuntimeSettings(project.id, {
      ...settings,
      expectedRevision: settings.revision,
      debugProvenanceHeaders: true,
    });
    await repository.setActiveProject(project.id, 0);
    const failing = Object.create(repository) as ProjectRepository;
    failing.openBody = () => { throw new Error('/Users/secret/body-path'); };

    const response = await requestTlsProxy(await startProxy(failing), {
      host: 'api.example.test', ca: ca.cert, path: '/failure',
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers).not.toHaveProperty('x-authored');
    expect(response.headers).not.toHaveProperty('x-mockmate-endpoint');
    expect(response.body.toString('utf8')).not.toContain('/Users/secret');
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: response.headers['x-request-id'],
    });
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const detail = runtime.traffic.get(project.id, trafficId);
    expect(detail).toMatchObject({
      status: 500,
      response: {
        headers: expect.arrayContaining([
          ['content-type', 'application/json'],
          ['content-length', String(response.body.length)],
        ]),
      },
    });
    expect(detail?.response.headers).toEqual([
      ['content-type', 'application/json'],
      ['content-length', String(response.body.length)],
      ['x-request-id', response.headers['x-request-id']],
      ['connection', 'close'],
    ]);
  });

  it.each(['plain', 'tls'] as const)('preserves repeated response headers over %s interception and traffic logging', async transport => {
    const project = await repository.createProject({ name: 'Repeated response headers' });
    await setInterceptHosts(project.id, ['cookies.example.test']);
    await repository.createEndpoint(project.id, {
      name: 'Cookies', baseUrl: `${transport === 'tls' ? 'https' : 'http'}://cookies.example.test`, mode: 'mock',
      matcher: { method: 'GET', path: '/cookies' },
      variants: [{
        name: 'Default', status: 204,
        responseHeaders: {
          'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
        },
      }],
      defaultVariantIndex: 0,
    });
    await repository.setActiveProject(project.id, 0);

    const port = await startProxy();
    const result = transport === 'tls'
      ? await requestTlsProxy(port, { host: 'cookies.example.test', ca: ca.cert, path: '/cookies' })
      : await requestPlainProxy(port, { host: 'cookies.example.test', path: '/cookies' });

    expect(result.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['set-cookie', 'session=one; Path=/'],
      ['set-cookie', 'theme=dark; Path=/'],
    ]);
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    expect(runtime.traffic.get(project.id, trafficId)?.response.headers
      .filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['set-cookie', '[REDACTED]'],
      ['set-cookie', '[REDACTED]'],
    ]);
  });

  async function streamingRepository(scheme: 'http' | 'https' = 'https') {
    const project = await repository.createProject({ name: 'Streaming proxy' });
    await setInterceptHosts(project.id, ['stream.example.test']);
    const body = await repository.putBody(
      project.id,
      Readable.from('seed'),
      { mediaType: 'application/octet-stream' },
      { maxBytes: 16 },
    );
    const endpoint = await repository.createEndpoint(project.id, {
      name: 'Large stream', baseUrl: `${scheme}://stream.example.test`, mode: 'mock',
      matcher: { method: 'GET', path: '/large' },
      variants: [{
        name: 'Default', status: 206,
         responseHeaders: {
           connection: 'keep-alive',
           'x-stream': 'owned',
         },
        bodyAssetId: body.id,
      }],
      defaultVariantIndex: 0,
    });
    await repository.setActiveProject(project.id, 0);
    return { project, endpoint, body };
  }

  it.each(['plain', 'tls'] as const)('streams exact intercepted bytes with backpressure over %s proxy', async transport => {
    const { body, project } = await streamingRepository(transport === 'tls' ? 'https' : 'http');
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const chunkCount = 64;
    let emitted = 0;
    let opened!: () => void;
    const sourceOpened = new Promise<void>(resolve => { opened = resolve; });
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: chunk.length * chunkCount });
    streaming.openBody = () => new Readable({
      highWaterMark: chunk.length,
      read() {
        if (emitted === 0) opened();
        if (emitted === chunkCount) this.push(null);
        else {
          emitted += 1;
          this.push(chunk);
        }
      },
    });
    const port = await startProxy(streaming);
    const socket = transport === 'tls'
      ? await openTlsProxyConnection(port, 'stream.example.test', ca.cert)
      : await connectProxySocket(port);
    socket.pause();
    const responsePromise = readProxyResponse(socket);
    const target = transport === 'tls' ? '/large' : 'http://stream.example.test/large';
    socket.write(`GET ${target} HTTP/1.1\r\nHost: stream.example.test\r\n\r\n`);
    try {
      await sourceOpened;
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(emitted).toBeLessThan(chunkCount);
      socket.resume();
      const response = await responsePromise;
      expect(response.statusCode).toBe(206);
      expect(response.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length * chunkCount),
        'x-stream': 'owned',
      });
      expect(response.body).toEqual(Buffer.alloc(chunk.length * chunkCount, 0x5a));
      await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
      const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
      expect(runtime.traffic.get(project.id, trafficId)?.response.headers).toEqual(
        expect.arrayContaining([
          ['content-type', 'application/octet-stream'],
          ['content-length', String(chunk.length * chunkCount)],
        ]),
      );
    } finally {
      socket.destroy();
    }
  }, 20_000);

  it('keeps a proxy mock write callback failure primary and counts the completed prefix', async () => {
    const { body, project } = await streamingRepository('http');
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 8 });
    streaming.openBody = () => Readable.from([Buffer.from('good'), Buffer.from('fail')]);
    const destinationFailure = new Error('/Users/secret/proxy-mock-destination.bin');
    const originalWrite = http.ServerResponse.prototype.write;
    let writes = 0;
    const write = vi.spyOn(http.ServerResponse.prototype, 'write').mockImplementation(function (
      this: http.ServerResponse,
      chunk: unknown,
      ...arguments_: unknown[]
    ) {
      if (!this.req.url?.startsWith('http://stream.example.test/large')) {
        return Reflect.apply(originalWrite, this, [chunk, ...arguments_]) as boolean;
      }
      writes += 1;
      const callback = arguments_.find(value => typeof value === 'function') as
        | ((error?: Error) => void)
        | undefined;
      if (writes === 1) {
        Reflect.apply(originalWrite, this, [chunk]);
        setImmediate(() => callback?.());
      } else {
        setImmediate(() => callback?.(destinationFailure));
      }
      return true;
    });
    try {
      const socket = await connectProxySocket(await startProxy(streaming));
      const response = readProxyResponse(socket);
      socket.write('GET http://stream.example.test/large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');
      await expect(response).rejects.toThrow('Proxy closed before a complete response');
      await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
      const detail = runtime.traffic.get(project.id, runtime.traffic.list(project.id).entries[0]!.id);
      expect(detail).toMatchObject({
        responseBytes: 4,
        response: { body: { state: 'unavailable', observedSize: 4 } },
        promotion: { state: 'blocked', reason: 'request_failed' },
        upstream: { failure: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      });
      expect(JSON.stringify(detail)).not.toContain('/Users/secret');
      socket.destroy();
    } finally {
      write.mockRestore();
    }
  });

  it('keeps a passthrough write callback failure primary and counts the completed prefix', async () => {
    const project = await repository.createProject({ name: 'Passthrough destination failure' });
    await repository.setActiveProject(project.id, 0);
    await setInterceptHosts(project.id, ['write.example.test'], true);
    let releaseSecond!: () => void;
    const secondAllowed = new Promise<void>(resolve => { releaseSecond = resolve; });
    const upstream = http.createServer(async (_request, response) => {
      response.writeHead(200, { 'Content-Length': '8' });
      response.write('good');
      await secondAllowed;
      response.end('fail');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    const destinationFailure = new Error('/Users/secret/proxy-upstream-destination.bin');
    const requestTarget = `http://write.example.test:${address.port}/partial`;
    const originalWrite = http.ServerResponse.prototype.write;
    let writes = 0;
    const write = vi.spyOn(http.ServerResponse.prototype, 'write').mockImplementation(function (
      this: http.ServerResponse,
      chunk: unknown,
      ...arguments_: unknown[]
    ) {
      if (this.req.url !== requestTarget) {
        return Reflect.apply(originalWrite, this, [chunk, ...arguments_]) as boolean;
      }
      writes += 1;
      const callback = arguments_.find(value => typeof value === 'function') as
        | ((error?: Error) => void)
        | undefined;
      if (writes === 1) {
        Reflect.apply(originalWrite, this, [chunk]);
        setImmediate(() => {
          callback?.();
          releaseSecond();
        });
      } else {
        setImmediate(() => callback?.(destinationFailure));
      }
      return true;
    });
    try {
      const socket = await connectProxySocket(await startProxy(repository, { upstream: { lookup } }));
      const response = readProxyResponse(socket);
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: write.example.test:${address.port}\r\n\r\n`);
      await expect(response).rejects.toThrow('Proxy closed before a complete response');
      await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
      const detail = runtime.traffic.get(project.id, runtime.traffic.list(project.id).entries[0]!.id);
      expect(detail).toMatchObject({
        responseBytes: 4,
        response: { body: { state: 'unavailable', observedSize: 4 } },
        promotion: { state: 'blocked', reason: 'request_failed' },
        upstream: { failure: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      });
      expect(JSON.stringify(detail)).not.toContain('/Users/secret');
      socket.destroy();
    } finally {
      write.mockRestore();
    }
  });

  it('destroys an intercepted Body Asset source when the TLS client cancels', async () => {
    const { project } = await streamingRepository();
    const settings = repository.getRuntimeSettings(project.id);
    await repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: settings.interceptHosts,
      captureRawTraffic: true,
      debugProvenanceHeaders: settings.debugProvenanceHeaders,
    });
    let destroyCalls = 0;
    let emitted = 0;
    let source!: Readable;
    let opened!: () => void;
    const sourceOpened = new Promise<void>(resolve => { opened = resolve; });
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.openBody = () => {
      source = new Readable({
      read() {
        if (emitted === 0) opened();
        setImmediate(() => {
          if (this.destroyed) return;
          emitted += 1;
          this.push(emitted >= 200 ? null : Buffer.alloc(64 * 1024));
        });
      },
      destroy(error, callback) {
        destroyCalls += 1;
        callback(error);
      },
      });
      return source;
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');
    await sourceOpened;
    socket.destroy();
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(destroyCalls).toBe(1);
      expect(emitted).toBeLessThan(200);
      await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
      const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
      expect(runtime.traffic.get(project.id, trafficId)).toMatchObject({
        request: { body: { state: 'unavailable', reason: 'stream_cancelled' } },
        response: { body: { state: 'unavailable', reason: 'stream_cancelled' } },
        promotion: { state: 'blocked', reason: 'request_cancelled' },
      });
    } finally {
      source.destroy();
    }
  });

  it('consumes intercepted source teardown errors when a TLS client cancels', async () => {
    await streamingRepository();
    let destroyCalls = 0;
    let source!: Readable;
    let opened!: () => void;
    const sourceOpened = new Promise<void>(resolve => { opened = resolve; });
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.openBody = () => {
      source = new Readable({
        read() {
          opened();
          this.push(Buffer.alloc(64 * 1024));
        },
        destroy(_error, callback) {
          destroyCalls += 1;
          callback(new Error('/Users/secret/teardown.bin'));
        },
      });
      return source;
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');
    await sourceOpened;
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(destroyCalls).toBe(1);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });

  it('destroys an intercepted source once and closes TLS without exposing source errors', async () => {
    const { project, body } = await streamingRepository();
    let destroyCalls = 0;
    const sourceFailure = new Error('/Users/secret/source-body.bin');
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 8 });
    streaming.openBody = () => new Readable({
      read() {
        this.push(Buffer.from('part'));
        setImmediate(() => this.destroy(sourceFailure));
      },
      destroy(error, callback) {
        destroyCalls += 1;
        callback(error);
      },
    });
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy did not close after source failure')), 5_000);
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\nConnection: close\r\n\r\n');

    await closed;
    expect(destroyCalls).toBe(1);
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('/Users/secret/source-body.bin');
    await vi.waitFor(() => expect(runtime.traffic.list(project.id).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(project.id).entries[0]!.id;
    const detail = runtime.traffic.get(project.id, trafficId);
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_failed' });
    expect(detail?.upstream?.failure).toEqual({
      code: 'INTERNAL_ERROR', message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(detail)).not.toContain('/Users/secret/source-body.bin');
  });

  it('terminates intercepted TLS when a Body Asset source closes silently before completion', async () => {
    const { body } = await streamingRepository();
    let destroyCalls = 0;
    let sent = false;
    let source!: Readable;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 8 });
    streaming.openBody = () => {
      source = new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(Buffer.from('part'));
          queueMicrotask(() => this.destroy());
        },
        destroy(error, callback) {
          destroyCalls += 1;
          callback(error);
        },
      });
      return source;
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    let closeCalls = 0;
    const closed = new Promise<void>(resolve => socket.once('close', () => {
      closeCalls += 1;
      resolve();
    }));
    const response = readProxyResponse(socket);
    socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');

    await expect(response).rejects.toThrow('Proxy closed before a complete response');
    await closed;
    expect(destroyCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(source.readableEnded).toBe(false);
    expect(source.listenerCount('error')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
    expect(source.listenerCount('close')).toBe(0);
  });

  it('discards a pipelined request after a fatal intercepted response', async () => {
    const { body } = await streamingRepository();
    let bodyOpens = 0;
    let sent = false;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 8 });
    streaming.openBody = () => {
      bodyOpens += 1;
      if (bodyOpens > 1) return Readable.from('complete');
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(Buffer.from('part'));
          queueMicrotask(() => this.destroy());
        },
      });
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    socket.resume();
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy did not close after fatal response')), 5_000);
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    socket.write([
      'GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n',
      'GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n',
    ].join(''));

    await closed;
    await new Promise(resolve => setImmediate(resolve));
    expect(bodyOpens).toBe(1);
  });

  it('delivers a pipelined second response while first Traffic finalization is stalled', async () => {
    const project = await repository.createProject({ name: 'Non-blocking Traffic finalization' });
    await setInterceptHosts(project.id, ['pipeline.example.test']);
    await repository.createEndpoint(project.id, {
      name: 'Pipeline',
      baseUrl: 'http://pipeline.example.test',
      matcher: { method: 'GET', path: '*' },
      mode: 'mock',
      variants: [{ name: 'Default', status: 204, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    await repository.setActiveProject(project.id, 0);
    let exchanges = 0;
    const traffic = Object.create(runtime.traffic) as TrafficService;
    traffic.begin = input => {
      const exchange = runtime.traffic.begin(input);
      exchanges += 1;
      return exchanges === 1
        ? { ...exchange, finalize: () => new Promise(() => undefined) }
        : exchange;
    };
    const socket = await connectProxySocket(await startProxy(repository, { traffic }));

    try {
      const first = readProxyResponse(socket);
      socket.write('GET http://pipeline.example.test/first HTTP/1.1\r\nHost: pipeline.example.test\r\n\r\n');
      expect((await first).statusCode).toBe(204);
      const pendingSecond = readProxyResponse(socket);
      socket.write('GET http://pipeline.example.test/second HTTP/1.1\r\nHost: pipeline.example.test\r\nConnection: close\r\n\r\n');
      const second = await Promise.race([
        pendingSecond,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Second response waited for Traffic persistence')), 500);
        }),
      ]);
      expect(second.statusCode).toBe(204);
      expect(exchanges).toBe(2);
    } finally {
      socket.destroy();
    }
  });

  it('closes after a configured response-owned Connection header without draining a pipeline', async () => {
    const { project, endpoint, body } = await streamingRepository();
    const variant = endpoint.variants[0]!;
    await repository.updateVariant(project.id, endpoint.id, variant.id, variant.revision, {
      responseHeaders: { Connection: ' x-hop,\t ClOsE ' },
    });
    let bodyOpens = 0;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 4 });
    streaming.openBody = () => {
      bodyOpens += 1;
      return Readable.from('body');
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    const closed = new Promise<boolean>(resolve => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    const response = readProxyResponse(socket);

    socket.write([
      'GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n',
      'GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n',
    ].join(''));

    expect((await response).headers.connection).toBe('close');
    expect(await closed).toBe(true);
    expect(bodyOpens).toBe(1);
    socket.destroy();
  });

  it('closes for an exact request Connection token', async () => {
    const { body } = await streamingRepository();
    let bodyOpens = 0;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 4 });
    streaming.openBody = () => {
      bodyOpens += 1;
      return Readable.from('body');
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    let closeCalls = 0;
    const closed = new Promise<boolean>(resolve => {
      socket.once('close', () => {
        closeCalls += 1;
        resolve(true);
      });
      setTimeout(() => resolve(false), 500);
    });
    const response = readProxyResponse(socket);

    socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\nConnection:\t x-hop ,\t ClOsE \t\r\n\r\n');

    expect((await response).headers.connection).toBe('close');
    expect(await closed).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(closeCalls).toBe(1);
    expect(bodyOpens).toBe(1);
    socket.destroy();
  });

  it('does not treat a Connection token substring as close', async () => {
    const { project, endpoint, body } = await streamingRepository();
    const variant = endpoint.variants[0]!;
    await repository.updateVariant(project.id, endpoint.id, variant.id, variant.revision, {
      responseHeaders: { Connection: 'disclose' },
    });
    let bodyOpens = 0;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 4 });
    streaming.openBody = () => {
      bodyOpens += 1;
      return Readable.from('body');
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);

    try {
      const firstResponse = readProxyResponse(socket);
      socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\nConnection: disclose\r\n\r\n');
      expect((await firstResponse).headers.connection).toBe('disclose');

      const secondResponse = readProxyResponse(socket);
      socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\nConnection: close\r\n\r\n');
      expect((await secondResponse).headers.connection).toBe('close');
      expect(bodyOpens).toBe(2);
    } finally {
      socket.destroy();
    }
  });

  it('closes for a forwarded upstream Connection token without a second upstream request', async () => {
    const project = await repository.createProject({ name: 'Forwarded close' });
    await setInterceptHosts(project.id, ['forward.example.test']);
    const leaf = new CertCache({ maxSize: 1, caCert: ca.cert, caKey: ca.privateKey })
      .getCert('forward.example.test');
    let upstreamRequests = 0;
    const upstream = https.createServer({ key: leaf.privateKey, cert: leaf.cert }, (_request, response) => {
      upstreamRequests += 1;
      response.setHeader('Connection', 'close');
      response.end('forwarded');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    await repository.createEndpoint(project.id, {
      name: 'Forward missing',
      baseUrl: `https://forward.example.test:${address.port}`,
      matcher: { method: 'GET', path: '/missing' },
      mode: 'passthrough',
    });
    await repository.setActiveProject(project.id, 0);
    const proxyPort = await startProxy(repository, { upstream: { lookup, ca: ca.cert } });
    const socket = await openTlsProxyConnection(proxyPort, 'forward.example.test', ca.cert, address.port);
    let closeCalls = 0;
    const closed = new Promise<boolean>(resolve => {
      socket.once('close', () => {
        closeCalls += 1;
        resolve(true);
      });
      setTimeout(() => resolve(false), 500);
    });
    const response = readProxyResponse(socket);

    try {
      socket.write([
        `GET /missing HTTP/1.1\r\nHost: forward.example.test:${address.port}\r\n\r\n`,
        `GET /missing HTTP/1.1\r\nHost: forward.example.test:${address.port}\r\n\r\n`,
      ].join(''));

      expect((await response).body.toString('utf8')).toBe('forwarded');
      expect(await closed).toBe(true);
      await new Promise(resolve => setImmediate(resolve));
      expect(closeCalls).toBe(1);
      expect(upstreamRequests).toBe(1);
    } finally {
      socket.destroy();
    }
  });

  it('preserves repeated cookies from an intercepted passthrough response', async () => {
    const project = await repository.createProject({ name: 'Forwarded cookies' });
    await setInterceptHosts(project.id, ['forward.example.test']);
    const leaf = new CertCache({ maxSize: 1, caCert: ca.cert, caKey: ca.privateKey })
      .getCert('forward.example.test');
    const upstream = https.createServer({ key: leaf.privateKey, cert: leaf.cert }, (_request, response) => {
      response.setHeader('Set-Cookie', ['session=one; Path=/', 'theme=dark; Path=/']);
      response.end('forwarded');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    closes.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Upstream did not bind');
    await repository.createEndpoint(project.id, {
      name: 'Forward missing',
      baseUrl: `https://forward.example.test:${address.port}`,
      matcher: { method: 'GET', path: '/missing' },
      mode: 'passthrough',
    });
    await repository.setActiveProject(project.id, 0);

    const result = await requestTlsProxy(
      await startProxy(repository, { upstream: { lookup, ca: ca.cert } }),
      {
        host: 'forward.example.test',
        ca: ca.cert,
        targetPort: address.port,
        path: '/missing',
      },
    );
    expect(result.statusCode).toBe(200);
    expect(result.body.toString()).toBe('forwarded');
    expect(result.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['Set-Cookie', 'session=one; Path=/'],
      ['Set-Cookie', 'theme=dark; Path=/'],
    ]);
  });

  it('closes an HTTP/1.0 intercepted response by default', async () => {
    const { body } = await streamingRepository();
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 4 });
    streaming.openBody = () => Readable.from('body');
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    const closed = new Promise<boolean>(resolve => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    const response = readProxyResponse(socket);

    socket.write('GET /large HTTP/1.0\r\nHost: stream.example.test\r\n\r\n');

    expect((await response).headers.connection).toBe('close');
    expect(await closed).toBe(true);
    socket.destroy();
  });

  it('gives an HTTP/1.0 close token precedence over keep-alive', async () => {
    const { body } = await streamingRepository();
    let bodyOpens = 0;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: 4 });
    streaming.openBody = () => {
      bodyOpens += 1;
      return Readable.from('body');
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    const closed = new Promise<boolean>(resolve => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    const response = readProxyResponse(socket);

    socket.write([
      'GET /large HTTP/1.0\r\nHost: stream.example.test\r\nConnection: keep-alive, Close\r\n\r\n',
      'GET /large HTTP/1.0\r\nHost: stream.example.test\r\n\r\n',
    ].join(''));

    expect((await response).headers.connection).toBe('close');
    expect(await closed).toBe(true);
    expect(bodyOpens).toBe(1);
    socket.destroy();
  });

  it('serves sequential intercepted responses over one TLS keep-alive connection', async () => {
    const { body } = await streamingRepository();
    const responseBytes = Buffer.from('keep-alive response');
    const sources: Readable[] = [];
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: responseBytes.length });
    streaming.openBody = () => {
      const source = Readable.from(responseBytes);
      sources.push(source);
      return source;
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));

    try {
      const firstResponse = readProxyResponse(socket);
      socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');
      const first = await firstResponse;
      expect(first.statusCode).toBe(206);
      expect(first.headers.connection).toBe('keep-alive');
      expect(first.body).toEqual(responseBytes);

      const secondResponse = readProxyResponse(socket);
      socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\nConnection: close\r\n\r\n');
      const second = await secondResponse;
      expect(second.statusCode).toBe(206);
      expect(second.headers.connection).toBe('close');
      expect(second.body).toEqual(responseBytes);
      await closed;
      expect(socket.destroyed).toBe(true);
      expect(sources).toHaveLength(2);
      for (const source of sources) {
        expect(source.listenerCount('error')).toBe(0);
        expect(source.listenerCount('end')).toBe(0);
        expect(source.listenerCount('close')).toBe(0);
      }
    } finally {
      if (!socket.destroyed) socket.destroy();
    }
  });

  it('rechecks active Project selection before each request on an established TLS connection', async () => {
    const { body } = await streamingRepository();
    const responseBytes = Buffer.from('selected response');
    let bodyOpens = 0;
    const streaming = Object.create(repository) as ProjectRepository;
    streaming.getBody = async () => ({ ...body, size: responseBytes.length });
    streaming.openBody = () => {
      bodyOpens += 1;
      return Readable.from(responseBytes);
    };
    const socket = await openTlsProxyConnection(await startProxy(streaming), 'stream.example.test', ca.cert);

    try {
      const firstResponse = readProxyResponse(socket);
      socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');
      expect((await firstResponse).statusCode).toBe(206);
      expect(bodyOpens).toBe(1);

      await repository.setActiveProject(null, repository.getWorkspaceState().revision);
      const secondResponse = readProxyResponse(socket);
      socket.write('GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n');
      const second = await secondResponse;
      expect(second.statusCode).toBe(503);
      expect(JSON.parse(second.body.toString('utf8'))).toEqual({
        code: 'NO_ACTIVE_PROJECT',
        message: 'No active Project is selected',
        requestId: second.headers['x-request-id'],
      });
      expect(second.headers['x-request-id']).toBeTruthy();
      expect(bodyOpens).toBe(1);
    } finally {
      socket.destroy();
    }
  });
});
