import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';

import type { Application } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, createRequestAdmissionGate, startServers } from './app';
import type { ProjectRepository } from './repository/project-repository';
import { createSetupRouter } from './routes/setup';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
} from './runtime/create-runtime';
import { getLocalIPAddresses } from './services/network';
import { connectProxySocket, readProxyResponse } from './test-support/proxy-test-client';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port reservation did not bind');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

function listenerRequest(input: {
  port: number;
  secure: boolean;
  connected(): void;
}): Promise<{ status: number; body: Buffer }> {
  const transport = input.secure ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      host: '127.0.0.1',
      port: input.port,
      path: '/health',
      method: 'GET',
      headers: { Host: `127.0.0.1:${input.port}`, Connection: 'close' },
      ...(input.secure ? { rejectUnauthorized: false } : {}),
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }));
    });
    request.once('socket', socket => {
      const event = input.secure ? 'secureConnect' : 'connect';
      if (input.secure || socket.connecting) socket.once(event, input.connected);
      else input.connected();
    });
    request.once('error', reject);
    request.end();
  });
}

describe('canonical MockMate application', () => {
  let root: string;
  let repository: ProjectRepository;
  let runtime: RuntimeContext;
  let app: Application;
  let projectId: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-app-'));
    runtime = await createRuntime({
      rootDirectory: root,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    repository = runtime.repository;
    app = appForRepository(repository);
    const project = await repository.createProject({ name: 'App integration' });
    projectId = project.id;
    await repository.setActiveProject(projectId, repository.getWorkspaceState().revision);
  });

  afterEach(async () => {
    await runtime.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  function appForRepository(
    candidate: ProjectRepository,
    adminSecurity = runtime.adminSecurity,
  ): Application {
    const getPorts = () => ({ http: 3456, https: 3457, proxy: 8888 });
    return createApp({
      runtime: { ...runtime, repository: candidate, adminSecurity },
      setupRouter: createSetupRouter({
        certificateDirectory: path.join(root, 'certificates'),
        getPorts,
      }),
      getPorts,
    });
  }

  it('requires an initialized repository when constructing the app', () => {
    expect(() => createApp({
      runtime: undefined as never,
      setupRouter: undefined as never,
      getPorts: undefined as never,
    }))
      .toThrow('MockMate requires an initialized RuntimeContext');
  });

  it('disposes the runtime when startup fails before listener creation', async () => {
    const dispose = vi.spyOn(runtime, 'dispose');

    await expect(startServers({
      runtime,
      requestedPorts: { http: 0, https: 0, proxy: 0 },
      certificateDirectory: root,
    })).rejects.toThrow('Certificate directory must be a strict descendant');

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('marks admissions open before releasing held work and isolates dispatch failures', async () => {
    let heldCount = 0;
    const bothHeld = deferred();
    const dispatched: string[] = [];
    const candidate = ((incoming: http.IncomingMessage, response: http.ServerResponse) => {
      dispatched.push(incoming.url ?? '');
      if (incoming.url === '/throw') throw new Error('dispatch failed');
      response.end(incoming.url);
    }) as unknown as Application;
    const gate = createRequestAdmissionGate(candidate, () => {
      heldCount += 1;
      if (heldCount === 2) bothHeld.resolve();
    });
    const server = http.createServer(gate.handle);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Admission test server did not bind');
    const send = (requestPath: string) => new Promise<string>((resolve, reject) => {
      const outgoing = http.get({ host: '127.0.0.1', port: address.port, path: requestPath }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.once('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      outgoing.once('error', reject);
    });
    const throwing = send('/throw');
    const later = send('/later');
    void throwing.catch(() => undefined);
    await bothHeld.promise;

    gate.markOpen();
    await expect(send('/new')).resolves.toBe('/new');
    expect(dispatched).toEqual(['/new']);
    gate.releaseHeld();

    await expect(throwing).rejects.toThrow();
    await expect(later).resolves.toBe('/later');
    expect(dispatched).toEqual(['/new', '/throw', '/later']);
    await gate.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('holds fixed-port HTTP, HTTPS, and proxy admissions until every port is published', async () => {
    const ports = { http: await unusedPort(), https: await unusedPort(), proxy: await unusedPort() };
    const barrierEntered = deferred();
    const releaseBarrier = deferred();
    const held = { http: deferred(), https: deferred(), proxy: deferred() };
    const starting = startServers({
      runtime,
      requestedPorts: ports,
      certificateDirectory: path.join(root, 'certificates'),
      beforeOpenAdmissions: async assigned => {
        expect(assigned).toEqual(ports);
        barrierEntered.resolve();
        await releaseBarrier.promise;
      },
      onAdmissionHeld: listener => held[listener].resolve(),
    });
    const first = await Promise.race([
      barrierEntered.promise.then(() => 'barrier' as const),
      starting.then(() => 'opened' as const),
    ]);
    if (first === 'opened') {
      await (await starting).close();
      expect(first).toBe('barrier');
      return;
    }
    const httpResponse = listenerRequest({
      port: ports.http, secure: false, connected() {},
    });
    const httpsResponse = listenerRequest({
      port: ports.https, secure: true, connected() {},
    });
    const proxySocket = await connectProxySocket(ports.proxy);
    const proxyResponse = readProxyResponse(proxySocket);
    proxySocket.write([
      'GET http://127.0.0.1:1/startup HTTP/1.1',
      'Host: 127.0.0.1:1',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
    await Promise.all(Object.values(held).map(item => item.promise));

    expect(runtime.traffic.list(projectId).entries).toEqual([]);
    const settledWhileClosed = await Promise.race([
      Promise.all([httpResponse, httpsResponse, proxyResponse]).then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledWhileClosed).toBe(false);

    releaseBarrier.resolve();
    const owner = await starting;
    try {
      expect(owner.ports).toEqual(ports);
      await expect(httpResponse).resolves.toMatchObject({ status: 200 });
      await expect(httpsResponse).resolves.toMatchObject({ status: 200 });
      await expect(proxyResponse).resolves.toMatchObject({ statusCode: 502 });
      expect(runtime.traffic.list(projectId).entries).toEqual([]);
    } finally {
      proxySocket.destroy();
      await owner.close();
    }
  }, 20_000);

  it('settles held admissions and rolls back every listener when startup publication fails', async () => {
    const ports = { http: await unusedPort(), https: await unusedPort(), proxy: await unusedPort() };
    const barrierEntered = deferred();
    const failPublication = deferred();
    const held = { http: deferred(), https: deferred(), proxy: deferred() };
    const starting = startServers({
      runtime,
      requestedPorts: ports,
      certificateDirectory: path.join(root, 'certificates'),
      beforeOpenAdmissions: async () => {
        barrierEntered.resolve();
        await failPublication.promise;
        throw new Error('startup-private-secret');
      },
      onAdmissionHeld: listener => held[listener].resolve(),
    });
    const first = await Promise.race([
      barrierEntered.promise.then(() => 'barrier' as const),
      starting.then(() => 'opened' as const),
    ]);
    if (first === 'opened') {
      await (await starting).close();
      expect(first).toBe('barrier');
      return;
    }
    const httpResponse = listenerRequest({
      port: ports.http, secure: false, connected() {},
    });
    const httpsResponse = listenerRequest({
      port: ports.https, secure: true, connected() {},
    });
    const proxySocket = net.createConnection({
      host: '127.0.0.1',
      port: ports.proxy,
      allowHalfOpen: true,
    });
    await new Promise<void>((resolve, reject) => {
      proxySocket.once('connect', resolve);
      proxySocket.once('error', reject);
    });
    const proxyResponse = readProxyResponse(proxySocket);
    void httpResponse.catch(() => undefined);
    void httpsResponse.catch(() => undefined);
    void proxyResponse.catch(() => undefined);
    proxySocket.write('CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\n\r\n');
    await Promise.all(Object.values(held).map(item => item.promise));
    expect(runtime.traffic.list(projectId).entries).toEqual([]);

    failPublication.resolve();
    const rollbackSettled = await Promise.race([
      starting.then(
        () => true,
        () => true,
      ),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
    ]);
    if (!rollbackSettled) proxySocket.destroy();
    expect(rollbackSettled).toBe(true);
    await expect(starting).rejects.toThrow('startup-private-secret');
    const responses = await Promise.all([httpResponse, httpsResponse, proxyResponse]);
    for (const response of responses) {
      const status = 'statusCode' in response ? response.statusCode : response.status;
      const body = JSON.parse(response.body.toString());
      expect(status).toBe(503);
      expect(body).toMatchObject({ code: 'SERVER_STARTUP_FAILED', requestId: expect.any(String) });
      expect(JSON.stringify(body)).not.toContain('startup-private-secret');
    }
    expect(runtime.traffic.list(projectId).entries).toEqual([]);
    proxySocket.destroy();
    await expect(Promise.all(Object.values(ports).map(port => new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => reject(new Error(`Listener ${port} remained open`)));
      socket.once('error', () => resolve());
    })))).resolves.toBeDefined();
  }, 20_000);

  it('keeps health and device-facing CORS public', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', timestamp: expect.any(String) });
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('keeps admin ACL, exact CORS, request IDs, and remote routes independent', async () => {
    const secured = appForRepository(repository, {
      dashboardOrigins: ['http://localhost:5173'],
      isAdminRequestLocal: () => false,
    });
    const denied = await request(secured)
      .get('/api/admin/projects')
      .set('Origin', 'http://localhost:5173');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'ADMIN_LOCAL_ONLY', requestId: expect.any(String) });
    expect(denied.headers['x-request-id']).toBe(denied.body.requestId);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await request(secured).get('/health').expect(200);
  });

  it('reflects only an explicitly configured dashboard origin', async () => {
    const corsApp = appForRepository(repository, {
      dashboardOrigins: ['http://localhost:5173'],
      isAdminRequestLocal: () => true,
    });
    const allowed = await request(corsApp).get('/api/admin/projects').set('Origin', 'http://localhost:5173');
    const denied = await request(corsApp).get('/api/admin/projects').set('Origin', 'https://attacker.test');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves exact binary static bytes through the active stable Project', async () => {
    const bytes = Buffer.from([0, 255, 123, 34, 97, 34, 58, 49, 125]);
    const upload = await request(app)
      .post(`/api/admin/projects/${projectId}/static-files`)
      .query({ path: 'data/blob.bin' })
      .set('Content-Type', 'application/octet-stream')
      .serialize(value => value as unknown as string)
      .send(bytes);
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({ file: { size: bytes.length, mediaType: 'application/octet-stream' } });
    const listed = await request(app).get(`/api/admin/projects/${projectId}/static-files`);
    expect(listed.body.baseUrl).toBe(`https://${getLocalIPAddresses()[0] ?? 'localhost'}:3457`);
    const served = await request(app).get('/static_files/data/blob.bin').buffer(true);
    expect(Buffer.from(served.body)).toEqual(bytes);
    expect(createHash('sha256').update(served.body).digest('hex'))
      .toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('destroys and detaches a static repository stream when the client cancels', async () => {
    await repository.putStaticFile(
      projectId,
      'cancel.bin',
      Readable.from(Buffer.from('metadata')),
      { mediaType: 'application/octet-stream', maxBytes: 64 },
    );
    let tracked!: Readable;
    let destroyCalls = 0;
    const candidate = Object.create(repository) as ProjectRepository;
    candidate.listStaticFiles = () => [{
      path: 'cancel.bin',
      mediaType: 'application/octet-stream',
      size: 64 * 1024 * 1024,
    }];
    candidate.openStaticFile = () => {
      tracked = new Readable({
        read() {
          setImmediate(() => {
            if (!this.destroyed) this.push(Buffer.alloc(64 * 1024));
          });
        },
        destroy(error, callback) {
          destroyCalls += 1;
          callback(error);
        },
      });
      return tracked;
    };
    const server = http.createServer(appForRepository(candidate));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    const client = http.get({ host: '127.0.0.1', port: address.port, path: '/static_files/cancel.bin' });
    await new Promise<void>((resolve, reject) => {
      client.once('response', response => {
        response.once('data', () => {
          response.destroy();
          client.destroy();
          resolve();
        });
      });
      client.once('error', error => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
        else reject(error);
      });
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    try {
      expect(destroyCalls).toBe(1);
      expect(tracked.listenerCount('error')).toBe(0);
    } finally {
      tracked.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('resolves and captures canonical Endpoint provenance', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const body = await repository.putBody(
      projectId,
      Readable.from(Buffer.from('{"allowed":true}')),
      { mediaType: 'application/json' },
      { maxBytes: 1024 },
    );
    const endpoint = await repository.createEndpoint(projectId, {
      name: 'Authorization',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/authorization' },
      mode: 'mock',
      variants: [{ name: 'Allowed', status: 200, responseHeaders: {}, bodyAssetId: body.id }],
      defaultVariantIndex: 0,
    });
    const response = await request(app).get('/authorization').set('Host', 'api.example.test');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ allowed: true });
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    const traffic = runtime.traffic.list(projectId);
    expect(traffic.entries[0]).toMatchObject({
      projectId,
      endpoint: { id: endpoint.id },
      decision: 'mock',
    });
  });

  it('does not open protocol-bodyless assets and preserves explicit empty-asset identity', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const hidden = await repository.putBody(
      projectId,
      Readable.from('hidden-body'),
      { mediaType: 'application/octet-stream' },
      { maxBytes: 32 },
    );
    const empty = await repository.putBody(
      projectId,
      Readable.from([]),
      { mediaType: 'application/vnd.mockmate.empty' },
      { maxBytes: 32 },
    );
    const cases = [
      { method: 'GET', path: '/no-content', status: 204, bodyAssetId: hidden.id },
      { method: 'GET', path: '/reset-content', status: 205, bodyAssetId: hidden.id },
      { method: 'GET', path: '/not-modified', status: 304, bodyAssetId: hidden.id },
      { method: 'HEAD', path: '/head-only', status: 200, bodyAssetId: hidden.id },
      { method: 'GET', path: '/normal-body', status: 200, bodyAssetId: hidden.id },
      { method: 'GET', path: '/empty-body', status: 200, bodyAssetId: empty.id },
    ] as const;
    for (const candidate of cases) {
      await repository.createEndpoint(projectId, {
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
    const openBody = vi.spyOn(repository, 'openBody');
    const responses = [
      await request(app).get('/no-content').set('Host', 'api.example.test'),
      await request(app).get('/reset-content').set('Host', 'api.example.test'),
      await request(app).get('/not-modified').set('Host', 'api.example.test'),
      await request(app).head('/head-only').set('Host', 'api.example.test'),
      await request(app).get('/normal-body').set('Host', 'api.example.test'),
      await request(app).get('/empty-body').set('Host', 'api.example.test'),
    ];
    const responseSize = (response: (typeof responses)[number]) => Buffer.isBuffer(response.body)
      ? response.body.length
      : Buffer.byteLength(response.text ?? '');

    expect(responses.map(response => response.status)).toEqual([204, 205, 304, 200, 200, 200]);
    expect(responses.slice(0, 4).map(responseSize)).toEqual([0, 0, 0, 0]);
    expect(responses.slice(0, 4).map(response => response.headers['content-type']))
      .toEqual([undefined, undefined, undefined, undefined]);
    expect(responseSize(responses[4]!)).toBe(hidden.size);
    expect(responses[5]!.headers['content-type']).toBe('application/vnd.mockmate.empty');
    expect(responseSize(responses[5]!)).toBe(0);
    expect(responses.map(response => response.headers['transfer-encoding']))
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(responses.map(response => response.headers['content-length']))
      .toEqual([undefined, '0', undefined, undefined, String(hidden.size), '0']);
    expect(openBody.mock.calls.filter(([, bodyId]) => bodyId === hidden.id)).toHaveLength(1);
    expect(openBody.mock.calls.filter(([, bodyId]) => bodyId === empty.id)).toHaveLength(1);

    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(cases.length));
    const details = runtime.traffic.list(projectId).entries.map(entry => runtime.traffic.get(projectId, entry.id)!);
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
    for (const candidate of details.filter(detail => (
      detail.path === '/no-content'
        || detail.path === '/reset-content'
        || detail.path === '/not-modified'
        || detail.path === '/head-only'
    ))) {
      expect(candidate).toMatchObject({
        responseBytes: 0,
        response: { body: { state: 'available', observedSize: 0, retainedSize: 0 } },
        promotion: {
          state: 'eligible',
          review: {
            response: { byteCount: 0, sha256: createHash('sha256').digest('hex') },
            variant: { action: 'create' },
          },
        },
      });
      expect(candidate.response.body).not.toHaveProperty('mediaType');
    }
    const normalDetail = details.find(detail => detail.path === '/normal-body')!;
    expect(normalDetail).toMatchObject({
      responseBytes: hidden.size,
      response: {
        body: {
          state: 'available',
          mediaType: 'application/octet-stream',
          observedSize: hidden.size,
          retainedSize: hidden.size,
          sha256: hidden.id,
        },
      },
    });
    expect(normalDetail.promotion).toMatchObject({
      state: 'eligible',
      review: {
        endpoint: { action: 'reuse' },
        variant: { action: 'reuse' },
      },
    });
    const emptyDetail = details.find(detail => detail.path === '/empty-body')!;
    expect(emptyDetail).toMatchObject({
      responseBytes: 0,
      response: {
        body: {
          state: 'available',
          mediaType: 'application/vnd.mockmate.empty',
          observedSize: 0,
          retainedSize: 0,
          sha256: createHash('sha256').digest('hex'),
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
    const downloaded = await request(app)
      .get(`/api/admin/projects/${projectId}/traffic/${emptyDetail.id}/bodies/response?download=1`)
      .set('Host', 'localhost');
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toBe('application/vnd.mockmate.empty');
    expect(downloaded.headers['content-length']).toBe('0');
    expect(downloaded.headers['x-mockmate-sha256']).toBe(createHash('sha256').digest('hex'));
    expect(responseSize(downloaded)).toBe(0);
  });

  it('fails an injected informational direct mock closed without opening its Body Asset', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const body = await repository.putBody(
      projectId,
      Readable.from('final-body'),
      { mediaType: 'text/plain' },
      { maxBytes: 32 },
    );
    for (const requestPath of ['/legacy-informational', '/final-control']) {
      await repository.createEndpoint(projectId, {
        name: requestPath,
        baseUrl: 'http://api.example.test',
        matcher: { method: 'GET', path: requestPath },
        mode: 'mock',
        variants: [{ name: 'Final', status: 200, responseHeaders: {}, bodyAssetId: body.id }],
        defaultVariantIndex: 0,
      });
    }
    const resolve = repository.resolve.bind(repository);
    vi.spyOn(repository, 'resolve').mockImplementation((candidateProjectId, matchRequest) => {
      const decision = resolve(candidateProjectId, matchRequest);
      return matchRequest.path === '/legacy-informational' && decision?.kind === 'mock'
        ? { ...decision, resolved: { ...decision.resolved, status: 103 } }
        : decision;
    });
    const openBody = vi.spyOn(repository, 'openBody');

    const failed = await request(app)
      .get('/legacy-informational')
      .set('Host', 'api.example.test')
      .timeout({ deadline: 1_000 });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: failed.headers['x-request-id'],
    });
    expect(openBody).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    const failedDetail = runtime.traffic.get(
      projectId,
      runtime.traffic.list(projectId).entries[0]!.id,
    );
    expect(failedDetail).toMatchObject({
      path: '/legacy-informational',
      status: 500,
      decision: 'mock',
      promotion: { state: 'blocked', reason: 'request_failed' },
    });

    const control = await request(app).get('/final-control').set('Host', 'api.example.test');
    expect(control.status).toBe(200);
    expect(control.text).toBe('final-body');
    expect(openBody).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(2));
    const controlEntry = runtime.traffic.list(projectId).entries.find(entry => entry.path === '/final-control');
    expect(controlEntry).toMatchObject({ status: 200, responseBytes: body.size });
  });

  it('replaces authored reserved provenance headers on direct mocks', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: true,
      expectedRevision: settings.revision,
    });
    const endpoint = await repository.createEndpoint(projectId, {
      name: 'Debug provenance',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/debug-provenance' },
      mode: 'mock',
      variants: [{
        name: 'Debug response',
        status: 204,
        responseHeaders: {
          'X-MockMate-Endpoint': 'spoofed-endpoint',
          'X-MockMate-Request-Id': 'spoofed-request',
        },
      }],
      defaultVariantIndex: 0,
    });

    const response = await request(app).get('/debug-provenance').set('Host', 'api.example.test');

    expect(response.status).toBe(204);
    expect(response.headers['x-mockmate-project']).toBe(projectId);
    expect(response.headers['x-mockmate-endpoint']).toBe(endpoint.id);
    expect(response.headers['x-mockmate-variant']).toBe(endpoint.variants[0]!.id);
    expect(response.headers['x-mockmate-request-id']).toBe(response.headers['x-request-id']);
  });

  it('discards staged authored and debug headers when a Body Asset fails before headers', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: true,
      expectedRevision: settings.revision,
    });
    const body = await repository.putBody(
      projectId,
      Readable.from('safe'),
      { mediaType: 'text/plain' },
      { maxBytes: 16 },
    );
    await repository.createEndpoint(projectId, {
      name: 'Fail before headers',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/body-failure' },
      mode: 'mock',
      variants: [{
        name: 'Default',
        status: 200,
        responseHeaders: { 'X-Authored': 'must-not-leak' },
        bodyAssetId: body.id,
      }],
      defaultVariantIndex: 0,
    });
    repository.openBody = () => { throw new Error('/Users/secret/body-path'); };

    const response = await request(app).get('/body-failure').set('Host', 'api.example.test');

    expect(response.status).toBe(500);
    expect(response.headers).not.toHaveProperty('x-authored');
    expect(response.headers).not.toHaveProperty('x-mockmate-endpoint');
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(projectId).entries[0]!.id;
    expect(runtime.traffic.get(projectId, trafficId)?.response.headers).toEqual([
      ['x-request-id', response.headers['x-request-id']],
      ['content-type', 'application/json; charset=utf-8'],
      ['content-length', String(response.text.length)],
    ]);
  });

  it('records a direct Body Asset source failure after headers as failure', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const body = await repository.putBody(
      projectId,
      Readable.from('12345678'),
      { mediaType: 'text/plain' },
      { maxBytes: 16 },
    );
    await repository.createEndpoint(projectId, {
      name: 'Fail after headers',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/late-body-failure' },
      mode: 'mock',
      variants: [{ name: 'Default', status: 200, responseHeaders: {}, bodyAssetId: body.id }],
      defaultVariantIndex: 0,
    });
    let sent = false;
    repository.openBody = () => new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(Buffer.from('part'));
        setImmediate(() => this.destroy(new Error('/Users/secret/direct-source.bin')));
      },
    });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    try {
      await new Promise<void>(resolve => {
        const outgoing = http.get({
          host: '127.0.0.1', port: address.port, path: '/late-body-failure',
          headers: { Host: 'api.example.test' },
        }, incoming => {
          incoming.resume();
          incoming.once('aborted', resolve);
          incoming.once('end', resolve);
          incoming.once('error', resolve);
        });
        outgoing.once('error', resolve);
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(projectId).entries[0]!.id;
    const detail = runtime.traffic.get(projectId, trafficId);
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_failed' });
    expect(detail?.upstream?.failure).toEqual({
      code: 'INTERNAL_ERROR', message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(detail)).not.toContain('/Users/secret');
  });

  it('keeps a direct write callback failure primary and counts only the completed prefix', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const body = await repository.putBody(
      projectId,
      Readable.from('12345678'),
      { mediaType: 'application/octet-stream' },
      { maxBytes: 16 },
    );
    await repository.createEndpoint(projectId, {
      name: 'Write callback failure',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/write-callback-failure' },
      mode: 'mock',
      variants: [{ name: 'Default', status: 200, responseHeaders: {}, bodyAssetId: body.id }],
      defaultVariantIndex: 0,
    });
    repository.openBody = () => Readable.from([Buffer.from('good'), Buffer.from('fail')]);
    const destinationFailure = new Error('/Users/secret/direct-destination.bin');
    const server = http.createServer((incoming, outgoing) => {
      const write = outgoing.write.bind(outgoing);
      let writes = 0;
      outgoing.write = ((chunk: Uint8Array, ...arguments_: unknown[]) => {
        writes += 1;
        const callback = arguments_.find(value => typeof value === 'function') as
          | ((error?: Error) => void)
          | undefined;
        if (writes === 1) {
          write(chunk);
          setImmediate(() => callback?.());
        } else {
          setImmediate(() => {
            if (callback) callback(destinationFailure);
            else outgoing.destroy(destinationFailure);
          });
        }
        return true;
      }) as typeof outgoing.write;
      app(incoming, outgoing);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    try {
      await new Promise<void>(resolve => {
        const outgoing = http.get({
          host: '127.0.0.1', port: address.port, path: '/write-callback-failure',
          headers: { Host: 'api.example.test' },
        }, incoming => {
          incoming.resume();
          incoming.once('aborted', resolve);
          incoming.once('end', resolve);
          incoming.once('error', resolve);
        });
        outgoing.once('error', resolve);
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    const detail = runtime.traffic.get(projectId, runtime.traffic.list(projectId).entries[0]!.id);
    expect(detail).toMatchObject({
      responseBytes: 4,
      response: { body: { state: 'unavailable', observedSize: 4 } },
      promotion: { state: 'blocked', reason: 'request_failed' },
      upstream: { failure: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    });
    expect(JSON.stringify(detail)).not.toContain('/Users/secret');
  });

  it.each(['close', 'callback error'] as const)(
    'does not claim a canonical direct error body after destination %s',
    async deliveryFailure => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const server = http.createServer((incoming, outgoing) => {
      outgoing.write = ((_chunk: Uint8Array, ...arguments_: unknown[]) => {
        const callback = arguments_.find(value => typeof value === 'function') as
          | ((error?: Error) => void)
          | undefined;
        setImmediate(() => {
          if (deliveryFailure === 'close') outgoing.destroy();
          else callback?.(new Error('/private/direct-error-destination'));
        });
        return true;
      }) as typeof outgoing.write;
      app(incoming, outgoing);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    try {
      await new Promise<void>(resolve => {
        const outgoing = http.get({
          host: '127.0.0.1', port: address.port, path: '/missing-error-destination',
          headers: { Host: 'api.example.test' },
        }, incoming => {
          incoming.resume();
          incoming.once('aborted', resolve);
          incoming.once('end', resolve);
          incoming.once('error', resolve);
        });
        outgoing.once('error', resolve);
      });
      await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const detail = runtime.traffic.get(projectId, runtime.traffic.list(projectId).entries[0]!.id);
    expect(detail).toMatchObject({
      responseBytes: 0,
      response: { body: { state: 'unavailable', observedSize: 0 } },
      promotion: { state: 'blocked', reason: 'request_failed' },
      upstream: { failure: { code: 'ENDPOINT_NOT_FOUND' } },
    });
    },
  );

  it('records a direct request abort before headers as cancellation without an error response', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const begun = deferred();
    const begin = runtime.traffic.begin.bind(runtime.traffic);
    vi.spyOn(runtime.traffic, 'begin').mockImplementation(input => {
      const exchange = begin(input);
      begun.resolve();
      return exchange;
    });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    try {
      const outgoing = http.request({
        host: '127.0.0.1', port: address.port, path: '/cancelled-upload', method: 'POST',
        headers: { Host: 'api.example.test', 'Content-Length': '1024' },
      });
      outgoing.on('error', () => undefined);
      outgoing.write('partial');
      await begun.promise;
      outgoing.destroy();
      await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const trafficId = runtime.traffic.list(projectId).entries[0]!.id;
    const detail = runtime.traffic.get(projectId, trafficId);
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_cancelled' });
    expect(detail?.upstream?.failure).toBeUndefined();
    expect(detail?.response.body).toMatchObject({
      state: 'unavailable', reason: 'stream_cancelled', observedSize: 0,
    });
  });

  it('chooses backend authority before control paths and records direct misses', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });

    for (const controlPath of ['/health', '/setup', '/api/admin/projects', '/static_files/x']) {
      const response = await request(app).get(controlPath).set('Host', 'api.example.test');
      expect(response.status, controlPath).toBe(404);
      expect(response.body, controlPath).toMatchObject({ code: 'ENDPOINT_NOT_FOUND' });
    }
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(4));
    await request(app).get('/health').set('Host', 'localhost').expect(200);
  });

  it('routes and captures prototype-bearing repeated direct request headers safely', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    const socket = net.connect(address.port, '127.0.0.1');
    const response = readProxyResponse(socket);
    socket.end([
      'GET /prototype-headers HTTP/1.1',
      'Host: api.example.test',
      '__proto__: first',
      'Constructor: built',
      'toString: rendered',
      '__PROTO__: second',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
    try {
      await expect(response).resolves.toMatchObject({ statusCode: 404 });
      await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    } finally {
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const detail = runtime.traffic.get(projectId, runtime.traffic.list(projectId).entries[0]!.id);
    const prototypeHeaders = detail?.request.headers.filter(([name]) => (
      name === '__proto__' || name === 'constructor' || name === 'tostring'
    ));
    expect(prototypeHeaders).toEqual([
      ['__proto__', 'first'],
      ['constructor', 'built'],
      ['tostring', 'rendered'],
      ['__proto__', 'second'],
    ]);
    expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_failed' });
  });

  it('keeps selected direct request bodies as raw streams beyond the JSON parser limit', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    const first = Buffer.alloc(80 * 1024, 'a');
    const second = Buffer.alloc(80 * 1024, 'b');

    try {
      const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const outgoing = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/raw-upload',
          method: 'POST',
          headers: {
            Host: 'api.example.test',
            'Content-Type': 'application/json',
            'Content-Length': first.length + second.length,
          },
        }, incoming => {
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        outgoing.once('error', reject);
        outgoing.write(first);
        setTimeout(() => outgoing.end(second), 5);
      });

      expect(response.status).toBe(404);
      expect(JSON.parse(response.body.toString())).toMatchObject({ code: 'ENDPOINT_NOT_FOUND' });
      await vi.waitFor(
        () => expect(runtime.traffic.list(projectId).entries).toHaveLength(1),
        { timeout: 3_000 },
      );
      const summaries = runtime.traffic.list(projectId).entries;
      const [summary] = summaries;
      const detail = runtime.traffic.get(projectId, summary.id);
      expect(detail?.request.body).toMatchObject({ state: 'available', observedSize: first.length + second.length });
      expect(detail?.response.body).toMatchObject({ state: 'available', observedSize: response.body.length });
      expect(detail?.request.preview?.value).toContain('a');
      expect(detail?.promotion).toEqual({ state: 'blocked', reason: 'request_failed' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('downloads exact pre-decoding direct request bytes with canonical repeated encoding', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xce, 0xb2, 0x01]);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const responseEnded = new Promise<void>((resolve, reject) => {
        socket.once('end', resolve);
        socket.once('error', reject);
      });
      socket.end(Buffer.concat([
        Buffer.from([
          'POST /encoded-request HTTP/1.1',
          'Host: api.example.test',
          'Content-Type: application/octet-stream',
          'Content-Encoding: GZip, identity',
          'Content-Encoding: BR',
          `Content-Length: ${bytes.length}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n')),
        bytes,
      ]));
      socket.resume();
      await responseEnded;
    } finally {
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await vi.waitFor(() => expect(runtime.traffic.list(projectId).entries).toHaveLength(1));
    const trafficId = runtime.traffic.list(projectId).entries[0]!.id;
    expect(runtime.traffic.get(projectId, trafficId)?.request.body).toMatchObject({
      state: 'available',
      observedSize: bytes.length,
      retainedSize: bytes.length,
      contentEncoding: 'gzip, br',
    });
    const downloaded = await request(app)
      .get(`/api/admin/projects/${projectId}/traffic/${trafficId}/bodies/request`)
      .buffer(true)
      .parse((source, callback) => {
        const chunks: Buffer[] = [];
        source.on('data', chunk => chunks.push(Buffer.from(chunk)));
        source.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.from(downloaded.body)).toEqual(bytes);
    expect(downloaded.headers['x-mockmate-original-content-encoding']).toBe('gzip, br');
    expect(downloaded.headers).not.toHaveProperty('content-encoding');
  });

  it('keeps direct upload delivery intact when Traffic is cleared mid-request', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });
    let observed!: () => void;
    const firstObserved = new Promise<void>(resolve => { observed = resolve; });
    const begin = runtime.traffic.begin.bind(runtime.traffic);
    vi.spyOn(runtime.traffic, 'begin').mockImplementation(input => {
      const exchange = begin(input);
      return {
        ...exchange,
        observeRequest(bytes) {
          exchange.observeRequest(bytes);
          observed();
        },
      };
    });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    const first = Buffer.from('first-upload-chunk');
    const second = Buffer.from('second-upload-chunk');

    try {
      let finishUpload!: () => void;
      const uploadReleased = new Promise<void>(resolve => { finishUpload = resolve; });
      const responsePromise = new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const outgoing = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/clear-active-upload',
          method: 'POST',
          headers: {
            Host: 'api.example.test',
            'Content-Type': 'application/octet-stream',
            'Content-Length': first.length + second.length,
          },
        }, incoming => {
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) }));
        });
        outgoing.once('error', reject);
        outgoing.write(first);
        void uploadReleased.then(() => outgoing.end(second));
      });

      await firstObserved;
      await runtime.traffic.clear(projectId);
      finishUpload();
      const response = await responsePromise;

      expect(response.status).toBe(404);
      expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({
        code: 'ENDPOINT_NOT_FOUND',
        message: 'No Endpoint matched the direct request',
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtime.traffic.list(projectId).entries).toEqual([]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('records malformed direct query evidence as an endpoint-less blocked miss', async () => {
    const settings = repository.getRuntimeSettings(projectId);
    await repository.updateRuntimeSettings(projectId, {
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      expectedRevision: settings.revision,
    });

    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Application did not bind');
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/invalid-query?token=%',
          headers: { Host: 'api.example.test' },
        }, incoming => {
          incoming.resume();
          incoming.once('end', () => resolve(incoming.statusCode ?? 0));
        });
        outgoing.once('error', reject);
        outgoing.end();
      });
      expect(status).toBe(404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    let summaries = runtime.traffic.list(projectId).entries;
    for (let attempt = 0; summaries.length === 0 && attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      summaries = runtime.traffic.list(projectId).entries;
    }
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    const detail = runtime.traffic.get(projectId, summary.id);
    expect(detail).toMatchObject({
      decision: 'direct_miss',
      routingReason: 'query_parse_invalid',
      promotion: { state: 'blocked', reason: 'query_parse_invalid' },
    });
    expect(detail).not.toHaveProperty('endpoint');
  });

  it('returns structured errors for no active Project and unknown admin routes', async () => {
    await repository.setActiveProject(null, repository.getWorkspaceState().revision);
    const inactive = await request(app).get('/anything');
    expect(inactive.status).toBe(404);
    expect(inactive.body).toMatchObject({ code: 'ENDPOINT_NOT_FOUND', requestId: expect.any(String) });
    const missing = await request(app).get('/api/admin/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'ADMIN_ROUTE_NOT_FOUND', requestId: expect.any(String) });
  });

  it('sanitizes malformed admin JSON with the request ID contract', async () => {
    const response = await request(app)
      .post('/api/admin/projects')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'MALFORMED_JSON', requestId: expect.any(String) });
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });
});
