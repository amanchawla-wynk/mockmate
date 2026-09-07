import { createHash } from 'node:crypto';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIntegrationHarness,
  hashTree,
  type IntegrationHarness,
} from './integration-harness';
import { generateCA, generateServerCert } from '../services/certs/generator';
import { requestPlainProxy, requestTlsProxy } from '../test-support/proxy-test-client';

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

describe('traffic capture integration harness', () => {
  let harness: IntegrationHarness | undefined;
  const servers = new Set<net.Server>();

  afterEach(async () => {
    await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    servers.clear();
    if (harness) await harness.dispose();
    harness = undefined;
  });

  it('owns controllable HTTP and trusted HTTPS upstreams', async () => {
    harness = await createIntegrationHarness();
    const httpUpstream = await harness.upstream(
      { scheme: 'http', hostname: 'events.example.test' },
      (_request, response) => response.end('http-ok'),
    );
    const httpsUpstream = await harness.upstream(
      { scheme: 'https', hostname: 'api.example.test' },
      (request, response) => request.once('end', () => response.end('https-ok')),
    );

    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const outgoing = https.request({
        hostname: '127.0.0.1',
        port: httpsUpstream.port,
        servername: httpsUpstream.hostname,
        method: 'POST',
        ca: [...harness!.tlsTrustBundle],
        headers: [
          'Host', `${httpsUpstream.hostname}:${httpsUpstream.port}`,
          'X-Repeat', 'one', 'X-Repeat', 'two',
          'Content-Length', '7',
        ],
      }, response => {
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('end', () => resolve(Buffer.concat(chunks)));
      });
      outgoing.once('error', reject);
      outgoing.end('payload');
    });

    expect(body.toString()).toBe('https-ok');
    expect(httpsUpstream.requests).toMatchObject([{
      method: 'POST',
      url: '/',
      headers: expect.arrayContaining([['X-Repeat', 'one'], ['X-Repeat', 'two']]),
      body: Buffer.from('payload'),
    }]);
    await expect(new Promise<void>((resolve, reject) => {
      https.get({
        hostname: '127.0.0.1',
        port: httpsUpstream.port,
        servername: httpsUpstream.hostname,
        ca: generateCA().cert,
      }, response => {
        response.resume();
        resolve();
      }).once('error', reject);
    })).rejects.toBeTruthy();

    await httpUpstream.close();
    await httpsUpstream.close();
    const report = await harness.dispose();
    harness = undefined;
    expect(report.closedListeners).toEqual(expect.arrayContaining([
      expect.stringMatching(/^upstream:http:events\.example\.test:/),
      expect.stringMatching(/^upstream:https:api\.example\.test:/),
    ]));
    expect(report.manifest.roots).toContainEqual({
      owner: 'upstream',
      relativePath: 'upstreams',
      afterOwnerClose: 'contained-until-parent-removal',
    });
  });

  it('writes exact plain proxy inputs and decodes chunked responses', async () => {
    let observed = '';
    const server = net.createServer(socket => {
      socket.on('data', chunk => {
        observed += chunk.toString('latin1');
        if (!observed.endsWith('firstsecond')) return;
        socket.write('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nTransfer-Encoding: chunked\r\n\r\n');
        socket.write('5\r\nhello\r\n');
        socket.end('6\r\n world\r\n0\r\n\r\n');
      });
    });
    servers.add(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');

    const response = await requestPlainProxy(address.port, {
      requestTarget: 'http://target.example.test/upload?part=1',
      method: 'POST',
      headers: [['Host', 'first.example.test'], ['Host', 'second.example.test'], ['X-Order', 'last']],
      bodyChunks: [Buffer.from('first'), Buffer.from('second')],
    });

    expect(observed).toBe(
      'POST http://target.example.test/upload?part=1 HTTP/1.1\r\n'
      + 'Host: first.example.test\r\nHost: second.example.test\r\nX-Order: last\r\n\r\nfirstsecond',
    );
    expect(response.rawHeaders).toEqual([
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['Transfer-Encoding', 'chunked'],
    ]);
    expect(response.body.toString()).toBe('hello world');
    expect(response.firstByteAt).toBeLessThanOrEqual(response.completedAt);
  });

  it('sends streamed TLS inputs through a coalesced CONNECT head', async () => {
    harness = await createIntegrationHarness();
    const upstream = await harness.upstream(
      { scheme: 'https', hostname: 'upload.example.test' },
      (request, response) => request.once('end', () => {
        response.setHeader('Set-Cookie', ['one=1', 'two=2']);
        response.end('accepted');
      }),
    );
    const project = (await harness.request.post('/api/admin/projects')
      .send({ name: 'Harness TLS' }).expect(201)).body as { id: string };
    await harness.request.put(`/api/admin/projects/${project.id}/runtime-settings`).send({
      expectedRevision: 0,
      interceptHosts: [upstream.hostname],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
    }).expect(200);
    const workspace = (await harness.request.get('/api/admin/workspace').expect(200)).body as {
      revision: number;
    };
    await harness.request.put('/api/admin/workspace').send({
      expectedRevision: workspace.revision,
      activeProjectId: project.id,
    }).expect(200);

    const authority = `${upstream.hostname}:${upstream.port}`;
    const proxy = await harness.proxy();
    const response = await proxy.requestTls({
      connectAuthority: authority,
      connectHeaders: [['Host', authority], ['X-Connect-Order', 'last']],
      servername: upstream.hostname,
      path: '/streamed',
      method: 'POST',
      innerHeaders: [
        ['Host', authority],
        ['X-Repeat', 'one'],
        ['X-Repeat', 'two'],
        ['Content-Length', '6'],
      ],
      bodyChunks: [Buffer.from('abc'), Buffer.from('def')],
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.toString()).toBe('accepted');
    expect(response.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie'))
      .toEqual([['Set-Cookie', 'one=1'], ['Set-Cookie', 'two=2']]);
    expect(upstream.requests).toMatchObject([{
      method: 'POST',
      url: '/streamed',
      headers: expect.arrayContaining([['X-Repeat', 'one'], ['X-Repeat', 'two']]),
      body: Buffer.from('abcdef'),
    }]);
    expect(response.firstByteAt).toBeLessThanOrEqual(response.completedAt);
  });

  it('captures, explains, promotes, replays, clears, and restarts multi-origin traffic', async () => {
    const encodedPlain = Buffer.from('encoded entity bytes');
    const encodedBytes = gzipSync(encodedPlain);
    const observedLookups: string[] = [];
    let completeChunkedResponse: (() => void) | undefined;
    harness = await createIntegrationHarness({
      fixtureHostnameAliases: {
        'mismatch.example.test': 'certificate.example.test',
      },
      lookupAddresses: {
        'untrusted.example.test': '127.0.0.1',
      },
      lookupFailures: ['dns-failure.example.test'],
      onLookup: hostname => observedLookups.push(hostname),
    });
    const httpsUpstream = await harness.upstream(
      { scheme: 'https', hostname: 'api.example.test' },
      (request, response) => request.once('end', () => {
        if (request.url?.startsWith('/promote?')) {
          response.setHeader('Content-Type', 'text/plain');
          response.setHeader('Set-Cookie', [
            'session=exact-response-secret; Path=/',
            'theme=dark; Path=/',
          ]);
          response.end('promoted-body');
          return;
        }
        if (request.url === '/truncated') {
          response.setHeader('Content-Type', 'application/octet-stream');
          response.end(Buffer.alloc(64 * 1_024 + 1, 0x61));
          return;
        }
        if (request.url === '/encoded') {
          response.setHeader('Content-Type', 'text/plain');
          response.setHeader('Content-Encoding', 'gzip');
          response.setHeader('Content-Length', String(encodedBytes.length));
          response.end(encodedBytes);
          return;
        }
        if (request.url === '/uncaptured') {
          response.setHeader('Content-Type', 'text/plain');
          response.end('uncaptured-body');
          return;
        }
        if (request.url === '/chunked') {
          response.setHeader('Set-Cookie', ['session=one; Path=/', 'theme=dark; Path=/']);
          response.write('first');
          completeChunkedResponse = () => response.end('-last');
          return;
        }
        if (request.url === '/close') {
          response.shouldKeepAlive = false;
          response.useChunkedEncodingByDefault = false;
          response.setHeader('Connection', 'close');
          response.end('close-delimited');
          return;
        }
        response.statusCode = 202;
        response.end(`api:${request.url}`);
      }),
    );
    const httpUpstream = await harness.upstream(
      { scheme: 'http', hostname: 'events.example.test' },
      (request, response) => request.once('end', () => {
        response.statusCode = 203;
        response.end(`events:${request.url}`);
      }),
    );
    const publicHttpUpstream = await harness.upstream(
      { scheme: 'http', hostname: 'public.example.test' },
      (request, response) => request.once('end', () => response.end(`public:${request.url}`)),
    );
    const wildcardUpstream = await harness.upstream(
      { scheme: 'https', hostname: 'upload.wild.example.test' },
      (request, response) => request.once('end', () => response.end(`upload:${request.url}`)),
    );
    const apexUpstream = await harness.upstream(
      { scheme: 'https', hostname: 'wild.example.test' },
      (request, response) => request.once('end', () => response.end(`apex:${request.url}`)),
    );
    const mismatchUpstream = await harness.upstream(
      { scheme: 'https', hostname: 'certificate.example.test' },
      (request, response) => request.once('end', () => response.end('certificate-name-only')),
    );
    let untrustedObservations = 0;
    const untrustedCA = generateCA();
    const untrustedCertificate = generateServerCert(untrustedCA, ['untrusted.example.test']);
    const untrustedServer = https.createServer({
      cert: untrustedCertificate.cert,
      key: untrustedCertificate.privateKey,
    }, (request, response) => {
      untrustedObservations += 1;
      request.resume();
      response.end('must-not-be-observed');
    });
    servers.add(untrustedServer);
    await new Promise<void>(resolve => untrustedServer.listen(0, '127.0.0.1', resolve));
    const untrustedAddress = untrustedServer.address();
    if (!untrustedAddress || typeof untrustedAddress === 'string') {
      throw new Error('Expected untrusted fixture TCP address');
    }
    const project = (await harness.request.post('/api/admin/projects')
      .send({ name: 'Acceptance' }).expect(201)).body as { id: string };
    expect(project).not.toHaveProperty('baseUrl');
    const settings = (await harness.request
      .get(`/api/admin/projects/${project.id}/runtime-settings`).expect(200)).body as {
      revision: number;
    };
    await harness.request.put(`/api/admin/projects/${project.id}/runtime-settings`).send({
      interceptHosts: [
        'api.example.test',
        'events.example.test',
        '*.wild.example.test',
        'mismatch.example.test',
        'dns-failure.example.test',
        'untrusted.example.test',
      ],
      captureRawTraffic: true,
      debugProvenanceHeaders: true,
      expectedRevision: settings.revision,
    }).expect(200);
    const workspace = (await harness.request.get('/api/admin/workspace').expect(200)).body as {
      revision: number;
    };
    await harness.request.put('/api/admin/workspace').send({
      expectedRevision: workspace.revision,
      activeProjectId: project.id,
    }).expect(200);

    const pageOneEndpoint = (await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Page one',
      baseUrl: httpsUpstream.origin,
      mode: 'mock',
      matcher: { method: 'GET', path: '/items', query: {
        page: [{ operator: 'equals', value: '1' }],
      } },
      variants: [{ name: 'Default', status: 200, responseHeaders: {}, delayMs: 0 }],
      defaultVariantIndex: 0,
    }).expect(201)).body as { id: string; variants: Array<{ id: string }> };
    await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Page two',
      baseUrl: httpsUpstream.origin,
      mode: 'passthrough',
      matcher: { method: 'GET', path: '/items', query: {
        page: [{ operator: 'equals', value: '2' }],
      } },
    }).expect(201);
    await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Events',
      baseUrl: httpUpstream.origin,
      mode: 'passthrough',
      matcher: { method: 'POST', path: '/events', query: {} },
    }).expect(201);
    await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Untrusted upstream',
      baseUrl: `https://untrusted.example.test:${untrustedAddress.port}`,
      mode: 'passthrough',
      matcher: { method: 'GET', path: '/untrusted', query: {} },
    }).expect(201);
    await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'Hostname mismatch',
      baseUrl: `https://mismatch.example.test:${mismatchUpstream.port}`,
      mode: 'passthrough',
      matcher: { method: 'GET', path: '/hostname-mismatch', query: {} },
    }).expect(201);
    await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
      name: 'DNS failure',
      baseUrl: 'https://dns-failure.example.test:443',
      mode: 'passthrough',
      matcher: { method: 'GET', path: '/dns-failure', query: {} },
    }).expect(201);
    const acceptanceState = (await harness.request
      .post(`/api/admin/projects/${project.id}/states`)
      .send({
        name: 'Acceptance state',
        tags: [],
        // Only bound Endpoints are mocked while an App State is active.
        bindings: { [pageOneEndpoint.id]: pageOneEndpoint.variants[0].id },
      })
      .expect(201)).body as { id: string };
    const currentProject = (await harness.request
      .get(`/api/admin/projects/${project.id}`).expect(200)).body as { revision: number };
    await harness.request.put(`/api/admin/projects/${project.id}/state-selection`).send({
      expectedRevision: currentProject.revision,
      activeStateId: acceptanceState.id,
    }).expect(200);

    const proxy = await harness.proxy();
    const tlsRequest = (path: string, onFirstByte?: (at: number) => void) => proxy.requestTls({
      connectAuthority: `${httpsUpstream.hostname}:${httpsUpstream.port}`,
      servername: httpsUpstream.hostname,
      path,
      innerHeaders: [['Host', `${httpsUpstream.hostname}:${httpsUpstream.port}`]],
      ...(onFirstByte === undefined ? {} : { onFirstByte }),
    });
    const pageOne = await tlsRequest('/items?page=1');
    const pageTwo = await tlsRequest('/items?page=2');
    const events = await proxy.requestPlain({
      requestTarget: `${httpUpstream.origin}/events`,
      method: 'POST',
      headers: [
        ['Host', `${httpUpstream.hostname}:${httpUpstream.port}`],
        ['Content-Length', '5'],
      ],
      bodyChunks: [Buffer.from('event')],
    });

    expect(pageOne.statusCode).toBe(200);
    expect(pageOne.headers['x-mockmate-endpoint']).toEqual(expect.any(String));
    expect(pageTwo.statusCode).toBe(202);
    expect(pageTwo.headers).not.toHaveProperty('x-mockmate-endpoint');
    expect(pageTwo.body.toString()).toBe('api:/items?page=2');
    expect(events.statusCode).toBe(203);
    expect(events.body.toString()).toBe('events:/events');
    expect(httpsUpstream.requests.map(request => request.url)).toEqual(['/items?page=2']);
    expect(httpUpstream.requests).toMatchObject([{
      method: 'POST',
      url: '/events',
      body: Buffer.from('event'),
    }]);

    const wildcardAuthority = `${wildcardUpstream.hostname}:${wildcardUpstream.port}`;
    const wildcard = await proxy.requestTls({
      connectAuthority: wildcardAuthority,
      servername: wildcardUpstream.hostname,
      path: '/upload',
      innerHeaders: [['Host', wildcardAuthority]],
    });
    const apexAuthority = `${apexUpstream.hostname}:${apexUpstream.port}`;
    const apex = await proxy.requestTls({
      connectAuthority: apexAuthority,
      servername: apexUpstream.hostname,
      path: '/apex',
      innerHeaders: [['Host', apexAuthority]],
    });
    const publicHttp = await proxy.requestPlain({
      requestTarget: `${publicHttpUpstream.origin}/public`,
      headers: [['Host', `${publicHttpUpstream.hostname}:${publicHttpUpstream.port}`]],
    });
    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.body.toString()).toBe('upload:/upload');
    expect(apex.statusCode).toBe(200);
    expect(apex.body.toString()).toBe('apex:/apex');
    expect(publicHttp.statusCode).toBe(200);
    expect(publicHttp.body.toString()).toBe('public:/public');
    expect(wildcardUpstream.requests).toHaveLength(1);
    expect(apexUpstream.requests).toHaveLength(1);
    expect(publicHttpUpstream.requests).toHaveLength(1);

    let entries!: Array<{
      id: string;
      path: string;
      allowlistPattern: string;
      decision: string;
      origin: string;
      endpoint?: { name: string; specificity: number; mode: string };
    }>;
    await vi.waitFor(async () => {
      entries = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body.entries;
      expect(entries).toHaveLength(4);
    });
    const rowsBeforeMalformedDirect = entries.length;
    await harness.request.get('/invalid-direct-authority')
      .set('Host', 'invalid authority')
      .expect(400)
      .expect(response => expect(response.body).toMatchObject({ code: 'DIRECT_ORIGIN_INVALID' }));
    expect((await harness.request
      .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body.entries)
      .toHaveLength(rowsBeforeMalformedDirect);
    const wildcardTraffic = entries.find(entry => entry.path === '/upload');
    expect(wildcardTraffic).toMatchObject({ allowlistPattern: '*.wild.example.test' });
    await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${wildcardTraffic!.id}`)
      .expect(200)
      .expect(response => {
        expect(response.body).toMatchObject({
          origin: wildcardUpstream.origin,
          path: '/upload',
          decision: 'no_match_passthrough',
        });
      });
    const pageOneTraffic = entries.find(entry => entry.path === '/items' && entry.decision === 'mock')!;
    const pageTwoTraffic = entries.find(entry => (
      entry.path === '/items' && entry.decision === 'endpoint_passthrough'
    ))!;
    expect(pageOneTraffic).toMatchObject({
      origin: httpsUpstream.origin,
      endpoint: { name: 'Page one', mode: 'mock', specificity: 6 },
    });
    expect(pageTwoTraffic).toMatchObject({
      origin: httpsUpstream.origin,
      endpoint: { name: 'Page two', mode: 'passthrough', specificity: 6 },
    });
    await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${pageOneTraffic.id}`)
      .expect(200)
      .expect(response => expect(response.body.appState).toMatchObject({
        mode: 'enabled',
        activeStateId: acceptanceState.id,
        selectedStateId: acceptanceState.id,
        resolutionSource: 'project_active_state',
        fallbackReasons: [],
      }));

    let observeFirstByte!: (at: number) => void;
    const firstByteObserved = new Promise<number>(resolve => { observeFirstByte = resolve; });
    let chunkedCompleted = false;
    const chunkedRequest = tlsRequest('/chunked', observeFirstByte)
      .then(response => {
        chunkedCompleted = true;
        return response;
      });
    const firstByteAt = await firstByteObserved;
    expect(chunkedCompleted).toBe(false);
    expect(completeChunkedResponse).toBeTypeOf('function');
    completeChunkedResponse!();
    const chunked = await chunkedRequest;
    const closeDelimited = await tlsRequest('/close');
    expect(chunked.body.toString()).toBe('first-last');
    expect(chunked.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie'))
      .toEqual([
        ['Set-Cookie', 'session=one; Path=/'],
        ['Set-Cookie', 'theme=dark; Path=/'],
      ]);
    expect(chunked.firstByteAt).toBe(firstByteAt);
    expect(chunked.firstByteAt).toBeLessThan(chunked.completedAt);
    expect(closeDelimited.body.toString()).toBe('close-delimited');
    expect(closeDelimited.headers['connection']).toBe('close');
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ path: string }>;
      };
      expect(traffic.entries.map(entry => entry.path))
        .toEqual(expect.arrayContaining(['/chunked', '/close']));
    });
    const encodedResponse = await tlsRequest('/encoded');
    expect(encodedResponse.body).toEqual(encodedBytes);
    let encodedEntry!: { id: string };
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ id: string; path: string }>;
      };
      encodedEntry = traffic.entries.find(entry => entry.path === '/encoded')!;
      expect(encodedEntry).toBeDefined();
    });
    const encodedDetail = (await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${encodedEntry.id}`)
      .expect(200)).body;
    expect(encodedDetail.response.body).toMatchObject({
      state: 'available',
      contentEncoding: 'gzip',
      observedSize: encodedBytes.length,
      retainedSize: encodedBytes.length,
      sha256: createHash('sha256').update(encodedBytes).digest('hex'),
    });
    expect(encodedDetail.response.preview).toMatchObject({
      encoding: 'utf8',
      value: 'encoded entity bytes',
      truncated: false,
    });
    const encodedDownload = await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${encodedEntry.id}/bodies/response?download=1`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(encodedDownload.body).toEqual(encodedBytes);
    expect(encodedDownload.headers).toMatchObject({
      'content-type': 'text/plain',
      'content-length': String(encodedBytes.length),
      'content-disposition': 'attachment',
      'x-mockmate-sha256': createHash('sha256').update(encodedBytes).digest('hex'),
    });
    const encodedDecoded = await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${encodedEntry.id}/bodies/response?view=decoded`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(encodedDecoded.body).toEqual(encodedPlain);
    expect(encodedDecoded.headers).toMatchObject({
      'content-type': 'text/plain',
      'content-length': String(encodedPlain.length),
      'x-mockmate-view': 'decoded',
      'x-mockmate-decoded-sha256': createHash('sha256').update(encodedPlain).digest('hex'),
      'x-mockmate-original-content-encoding': 'gzip',
    });
    expect(encodedDecoded.headers['x-mockmate-sha256']).toBeUndefined();

    const apiObservationsBeforeAuthorityFailures = httpsUpstream.requests.length;
    const eventsObservationsBeforeAuthorityFailures = httpUpstream.requests.length;
    const plainMismatch = await proxy.requestPlain({
      requestTarget: `http://${httpsUpstream.hostname}:${httpsUpstream.port}/plain-mismatch`,
      headers: [['Host', `${httpUpstream.hostname}:${httpUpstream.port}`]],
    });
    expect(plainMismatch.statusCode).toBe(400);
    expect(JSON.parse(plainMismatch.body.toString())).toMatchObject({
      code: 'PROXY_HOST_AUTHORITY_MISMATCH',
      requestId: plainMismatch.headers['x-request-id'],
    });
    const connectMismatch = await proxy.requestTls({
      connectAuthority: `${httpsUpstream.hostname}:${httpsUpstream.port}`,
      servername: httpsUpstream.hostname,
      path: '/connect-mismatch',
      innerHeaders: [['Host', `${httpUpstream.hostname}:${httpUpstream.port}`]],
    });
    expect(connectMismatch.statusCode).toBe(400);
    expect(JSON.parse(connectMismatch.body.toString())).toMatchObject({
      code: 'PROXY_CONNECT_AUTHORITY_MISMATCH',
      requestId: connectMismatch.headers['x-request-id'],
    });
    const duplicateHost = await proxy.requestPlain({
      requestTarget: `http://${httpUpstream.hostname}:${httpUpstream.port}/duplicate-host`,
      headers: [
        ['Host', `${httpUpstream.hostname}:${httpUpstream.port}`],
        ['host', `${httpUpstream.hostname}:${httpUpstream.port}`],
      ],
    });
    expect(duplicateHost.statusCode).toBe(400);
    expect(JSON.parse(duplicateHost.body.toString())).toMatchObject({ code: 'PROXY_AUTHORITY_INVALID' });
    expect(httpsUpstream.requests).toHaveLength(apiObservationsBeforeAuthorityFailures);
    expect(httpUpstream.requests).toHaveLength(eventsObservationsBeforeAuthorityFailures);
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ decision: string; requestId: string }>;
      };
      const failures = traffic.entries.filter(entry => entry.decision === 'failure');
      expect(failures).toHaveLength(3);
      expect(failures.map(entry => entry.requestId)).toEqual(expect.arrayContaining([
        plainMismatch.headers['x-request-id'],
        connectMismatch.headers['x-request-id'],
        duplicateHost.headers['x-request-id'],
      ]));
    });

    const selectedFailure = (
      hostname: string,
      port: number,
      path: string,
      secret: string,
    ) => proxy.requestTls({
      connectAuthority: `${hostname}:${port}`,
      servername: hostname,
      path,
      innerHeaders: [
        ['Host', `${hostname}:${port}`],
        ['Authorization', `Bearer ${secret}`],
      ],
    });
    const untrustedFailure = await selectedFailure(
      'untrusted.example.test', untrustedAddress.port, '/untrusted', 'untrusted-private-secret',
    );
    const hostnameFailure = await selectedFailure(
      'mismatch.example.test', mismatchUpstream.port,
      '/hostname-mismatch', 'hostname-private-secret',
    );
    const dnsFailure = await selectedFailure(
      'dns-failure.example.test', 443, '/dns-failure', 'dns-private-secret',
    );
    for (const failure of [untrustedFailure, hostnameFailure, dnsFailure]) {
      expect(failure.statusCode).toBe(502);
      expect(JSON.parse(failure.body.toString())).toEqual({
        code: 'UPSTREAM_FAILURE',
        message: 'Upstream request failed',
        requestId: failure.headers['x-request-id'],
      });
    }
    expect(untrustedObservations).toBe(0);
    expect(mismatchUpstream.requests).toHaveLength(0);
    expect(observedLookups).toEqual(expect.arrayContaining([
      'mismatch.example.test',
      'dns-failure.example.test',
    ]));
    const selectedFailureRequestIds = [untrustedFailure, hostnameFailure, dnsFailure]
      .map(response => response.headers['x-request-id']);
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ id: string; requestId: string }>;
      };
      const selectedFailures = traffic.entries
        .filter(entry => selectedFailureRequestIds.includes(entry.requestId));
      expect(selectedFailures).toHaveLength(3);
      for (const entry of selectedFailures) {
        const detail = (await harness!.request
          .get(`/api/admin/projects/${project.id}/traffic/${entry.id}`)
          .expect(200)).body;
        expect(detail).toMatchObject({
          decision: 'endpoint_passthrough',
          status: 502,
          upstream: {
            failure: { code: 'UPSTREAM_FAILURE', message: 'Upstream request failed' },
          },
          promotion: { state: 'blocked', reason: 'request_failed' },
        });
        expect(JSON.stringify(detail)).not.toMatch(
          /untrusted-private-secret|hostname-private-secret|dns-private-secret|certificate signature|Injected lookup/,
        );
      }
    });

    const truncatedResponse = await tlsRequest('/truncated');
    expect(truncatedResponse.statusCode).toBe(200);
    expect(truncatedResponse.body).toHaveLength(64 * 1_024 + 1);
    const captureSettings = (await harness.request
      .get(`/api/admin/projects/${project.id}/runtime-settings`).expect(200)).body as {
      revision: number;
      interceptHosts: string[];
      debugProvenanceHeaders: boolean;
    };
    const captureDisabled = (await harness.request
      .put(`/api/admin/projects/${project.id}/runtime-settings`).send({
        expectedRevision: captureSettings.revision,
        interceptHosts: captureSettings.interceptHosts,
        captureRawTraffic: false,
        debugProvenanceHeaders: captureSettings.debugProvenanceHeaders,
      }).expect(200)).body as { revision: number };
    const uncapturedResponse = await tlsRequest('/uncaptured');
    expect(uncapturedResponse.body.toString()).toBe('uncaptured-body');
    await harness.request.put(`/api/admin/projects/${project.id}/runtime-settings`).send({
      expectedRevision: captureDisabled.revision,
      interceptHosts: captureSettings.interceptHosts,
      captureRawTraffic: true,
      debugProvenanceHeaders: captureSettings.debugProvenanceHeaders,
    }).expect(200);
    let blockedBodies!: Array<{ id: string; path: string }>;
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ id: string; path: string }>;
      };
      blockedBodies = traffic.entries.filter(entry => (
        entry.path === '/truncated' || entry.path === '/uncaptured'
      ));
      expect(blockedBodies).toHaveLength(2);
    });
    for (const blocked of blockedBodies) {
      const detail = (await harness.request
        .get(`/api/admin/projects/${project.id}/traffic/${blocked.id}`)
        .expect(200)).body;
      if (blocked.path === '/truncated') {
        expect(detail.promotion).toEqual({ state: 'blocked', reason: 'body_truncated' });
        expect(detail.response.body).toMatchObject({
          state: 'truncated', reason: 'body_limit_exceeded', observedSize: 64 * 1_024 + 1,
        });
        await harness.request
          .post(`/api/admin/projects/${project.id}/traffic/${blocked.id}/mock`)
          .send({
            expectedTrafficGeneration: detail.generation,
            expectedResponseIdentity: '0'.repeat(64),
            endpoint: { action: 'create' },
            state: { action: 'unbound' },
          })
          .expect(409);
      } else {
        // captureRawTraffic=false must not disable exact retention.
        expect(detail.response.body.state).toBe('available');
        expect(detail.promotion.state).toBe('eligible');
      }
    }
    const endpointPaths = ((await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints`).expect(200)).body as
        Array<{ path: string }>).map(endpoint => endpoint.path);
    expect(endpointPaths).not.toContain('/truncated');
    expect(endpointPaths).not.toContain('/uncaptured');

    for (const operation of ['generationRename', 'bodyPromote', 'pointerPublish'] as const) {
      const failurePath = `/fail-${operation}`;
      const capturedFailure = await tlsRequest(failurePath);
      expect(capturedFailure.statusCode).toBe(202);
      let failureEntry!: { id: string };
      await vi.waitFor(async () => {
        const traffic = (await harness!.request
          .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
          entries: Array<{ id: string; path: string }>;
        };
        failureEntry = traffic.entries.find(entry => entry.path === failurePath)!;
        expect(failureEntry).toBeDefined();
      });
      const failureDetail = (await harness.request
        .get(`/api/admin/projects/${project.id}/traffic/${failureEntry.id}`)
        .expect(200)).body as {
          promotion: {
            state: string;
            review: {
              expectedTrafficGeneration: string;
              expectedResponseIdentity: string;
              endpoint: { action: 'create' } | {
                action: 'reuse'; endpointId: string; expectedRevision: number;
              };
              state: { action: 'unbound' } | {
                action: 'bind'; stateId: string; expectedRevision: number;
              };
            };
          };
        };
      expect(failureDetail.promotion.state).toBe('eligible');
      const failedReview = failureDetail.promotion.review;
      const projectRoot = path.join(harness.rootDirectory, 'projects', project.id);
      const trafficCacheRoot = path.join(harness.rootDirectory, 'traffic-cache');
      const canonicalBeforeFailure = await hashTree(projectRoot);
      const cacheBeforeFailure = await hashTree(trafficCacheRoot);
      harness.failNext(operation);
      const failedPromotion = await harness.request
        .post(`/api/admin/projects/${project.id}/traffic/${failureEntry.id}/mock`)
        .send({
          expectedTrafficGeneration: failedReview.expectedTrafficGeneration,
          expectedResponseIdentity: failedReview.expectedResponseIdentity,
          endpoint: failedReview.endpoint.action === 'create'
            ? { action: 'create' }
            : {
                action: 'reuse',
                endpointId: failedReview.endpoint.endpointId,
                expectedRevision: failedReview.endpoint.expectedRevision,
              },
          state: failedReview.state,
        })
        .expect(500);
      expect(failedPromotion.body).toMatchObject({
        code: 'INTERNAL_ERROR',
        requestId: expect.any(String),
      });
      expect(JSON.stringify(failedPromotion.body)).not.toContain(`Injected ${operation} failure`);
      expect(await hashTree(projectRoot)).toEqual(canonicalBeforeFailure);
      expect(await hashTree(trafficCacheRoot)).toEqual(cacheBeforeFailure);
      const failedEndpointPaths = ((await harness.request
        .get(`/api/admin/projects/${project.id}/endpoints`).expect(200)).body as
          Array<{ path: string }>).map(endpoint => endpoint.path);
      expect(failedEndpointPaths).not.toContain(failurePath);
    }

    const upstreamBeforePromotion = httpsUpstream.requests.length;
    const promotionCapture = await tlsRequest('/promote?access_token=exact-query-secret');
    expect(promotionCapture.statusCode).toBe(200);
    expect(promotionCapture.body.toString()).toBe('promoted-body');
    let promotionEntry!: { id: string };
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ id: string; path: string; queryNames: unknown }>;
      };
      promotionEntry = traffic.entries.find(entry => entry.path === '/promote')!;
      expect(promotionEntry).toBeDefined();
      expect(JSON.stringify(traffic)).not.toContain('exact-query-secret');
      expect(promotionEntry.queryNames).toEqual([{
        name: 'access_token', occurrenceCount: 1, sensitive: true,
      }]);
    });
    const promotionDetail = (await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${promotionEntry.id}`)
      .expect(200)).body as {
        generation: string;
        request: { query: Array<{ name: string; value: string }> };
        response: { headers: string[][] };
        promotion: {
          state: string;
          review: {
            expectedTrafficGeneration: string;
            expectedResponseIdentity: string;
            endpoint: { action: 'create' } | {
              action: 'reuse'; endpointId: string; expectedRevision: number;
            };
            state: { action: 'unbound' } | {
              action: 'bind'; stateId: string; expectedRevision: number;
            };
          };
        };
      };
    expect(JSON.stringify(promotionDetail)).not.toContain('exact-query-secret');
    expect(JSON.stringify(promotionDetail)).not.toContain('exact-response-secret');
    expect(promotionDetail.request.query).toContainEqual({
      name: 'access_token', value: '[REDACTED]',
    });
    expect(promotionDetail.response.headers).toContainEqual(['set-cookie', '[REDACTED]']);
    expect(promotionDetail.promotion).toMatchObject({
      state: 'eligible',
      review: {
        expectedTrafficGeneration: promotionDetail.generation,
        endpoint: { action: 'create' },
        state: { action: 'bind', stateId: acceptanceState.id },
      },
    });
    const review = promotionDetail.promotion.review;
    const promotionInput = {
      expectedTrafficGeneration: review.expectedTrafficGeneration,
      expectedResponseIdentity: review.expectedResponseIdentity,
      endpoint: review.endpoint.action === 'create'
        ? { action: 'create' as const }
        : {
            action: 'reuse' as const,
            endpointId: review.endpoint.endpointId,
            expectedRevision: review.endpoint.expectedRevision,
          },
      state: review.state,
    };
    expect(JSON.stringify(promotionInput)).not.toMatch(/exact-query-secret|exact-response-secret|REDACTED/);
    const successProjectRoot = path.join(harness.rootDirectory, 'projects', project.id);
    const treeBeforeSuccessfulPromotion = await hashTree(successProjectRoot);
    const generationsBeforeSuccessfulPromotion = Object.keys(treeBeforeSuccessfulPromotion)
      .filter(entry => /^generations\/gen_[^/]+\/$/.test(entry)).length;
    const bodyFilesBeforeSuccessfulPromotion = Object.entries(treeBeforeSuccessfulPromotion)
      .filter(([entry, value]) => entry.startsWith('bodies/sha256/') && value !== 'directory').length;
    const endpointsBeforeSuccessfulPromotion = ((await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints`).expect(200)).body as unknown[]).length;
    const promoted = (await harness.request
      .post(`/api/admin/projects/${project.id}/traffic/${promotionEntry.id}/mock`)
      .send(promotionInput).expect(200)).body as {
        endpointId: string;
        variantId: string;
      };
    const treeAfterSuccessfulPromotion = await hashTree(successProjectRoot);
    expect(Object.keys(treeAfterSuccessfulPromotion)
      .filter(entry => /^generations\/gen_[^/]+\/$/.test(entry))).toHaveLength(
      generationsBeforeSuccessfulPromotion + 1,
    );
    expect(Object.entries(treeAfterSuccessfulPromotion)
      .filter(([entry, value]) => entry.startsWith('bodies/sha256/') && value !== 'directory'))
      .toHaveLength(bodyFilesBeforeSuccessfulPromotion + 2);
    expect(((await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints`).expect(200)).body as unknown[]))
      .toHaveLength(endpointsBeforeSuccessfulPromotion + 1);
    const promotedEndpoint = (await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints/${promoted.endpointId}`)
      .expect(200)).body as {
        matcher: { query: Record<string, Array<{ value: string }>> };
        variants: Array<{
          id: string;
          revision: number;
          bodyAssetId?: string;
          responseHeaders: Record<string, string | string[]>;
          trafficProvenance: unknown[];
        }>;
      };
    expect(promotedEndpoint.matcher.query.access_token).toEqual([{
      operator: 'equals', value: 'exact-query-secret',
    }]);
    const promotedVariant = promotedEndpoint.variants.find(variant => variant.id === promoted.variantId)!;
    expect(promotedVariant).toEqual(expect.objectContaining({
      id: promoted.variantId,
      bodyAssetId: expect.stringMatching(/^[0-9a-f]{64}$/),
      responseHeaders: expect.objectContaining({
        'set-cookie': [
          'session=exact-response-secret; Path=/',
          'theme=dark; Path=/',
        ],
      }),
    }));
    expect(promotedVariant.trafficProvenance).toHaveLength(1);
    await harness.request
      .get(`/api/admin/projects/${project.id}/states/${acceptanceState.id}`)
      .expect(200)
      .expect(response => expect(response.body.bindings).toMatchObject({
        [promoted.endpointId]: promoted.variantId,
      }));
    const downloadedBody = await harness.request
      .get(`/api/admin/projects/${project.id}/bodies/${promotedVariant.bodyAssetId}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(downloadedBody.body).toEqual(Buffer.from('promoted-body'));
    const replay = await tlsRequest('/promote?access_token=exact-query-secret');
    expect(replay.statusCode).toBe(200);
    expect(replay.body.toString()).toBe('promoted-body');
    expect(replay.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie'))
      .toEqual([
        ['set-cookie', 'session=exact-response-secret; Path=/'],
        ['set-cookie', 'theme=dark; Path=/'],
      ]);
    expect(httpsUpstream.requests).toHaveLength(upstreamBeforePromotion + 1);

    const editedVariant = (await harness.request
      .put(`/api/admin/projects/${project.id}/endpoints/${promoted.endpointId}/variants/${promoted.variantId}`)
      .send({ expectedRevision: promotedVariant.revision, patch: { status: 201 } })
      .expect(200)).body as { trafficProvenance: unknown[] };
    expect(editedVariant.trafficProvenance).toEqual(promotedVariant.trafficProvenance);

    await harness.request.delete(`/api/admin/projects/${project.id}/traffic`).expect(204);
    const replayAfterClear = await tlsRequest('/promote?access_token=exact-query-secret');
    expect(replayAfterClear.statusCode).toBe(201);
    expect(replayAfterClear.body.toString()).toBe('promoted-body');
    expect(httpsUpstream.requests).toHaveLength(upstreamBeforePromotion + 1);
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ path: string }>;
      };
      expect(traffic.entries.some(entry => entry.path === '/promote')).toBe(true);
    });
    await harness.restart();
    expect((await harness.request
      .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body.entries).toEqual([]);
    const restartedProxy = await harness.proxy();
    const replayAfterRestart = await restartedProxy.requestTls({
      connectAuthority: `${httpsUpstream.hostname}:${httpsUpstream.port}`,
      servername: httpsUpstream.hostname,
      path: '/promote?access_token=exact-query-secret',
      innerHeaders: [['Host', `${httpsUpstream.hostname}:${httpsUpstream.port}`]],
    });
    expect(replayAfterRestart.statusCode).toBe(201);
    expect(replayAfterRestart.body.toString()).toBe('promoted-body');
    expect(httpsUpstream.requests).toHaveLength(upstreamBeforePromotion + 1);
    const restartedEndpoint = (await harness.request
      .get(`/api/admin/projects/${project.id}/endpoints/${promoted.endpointId}`)
      .expect(200)).body as { variants: Array<{ id: string; trafficProvenance: unknown[] }> };
    expect(restartedEndpoint.variants.find(variant => variant.id === promoted.variantId)?.trafficProvenance)
      .toEqual(promotedVariant.trafficProvenance);

    const rowsBeforeWrongBlindCA = (await harness.request
      .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body.entries.length as number;
    await expect(requestTlsProxy(restartedProxy.port, {
      connectAuthority: `${apexUpstream.hostname}:${apexUpstream.port}`,
      servername: apexUpstream.hostname,
      ca: generateCA().cert,
      path: '/wrong-client-ca',
    })).rejects.toBeTruthy();
    expect((await harness.request
      .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body.entries)
      .toHaveLength(rowsBeforeWrongBlindCA);

    const restartProject = (await harness.request
      .get(`/api/admin/projects/${project.id}`).expect(200)).body as { revision: number };
    await harness.request.put(`/api/admin/projects/${project.id}/app-state-mode`).send({
      appStateMode: 'disabled',
      expectedProjectRevision: restartProject.revision,
    }).expect(200);
    const disabledStateResponse = await restartedProxy.requestTls({
      connectAuthority: `${httpsUpstream.hostname}:${httpsUpstream.port}`,
      servername: httpsUpstream.hostname,
      path: '/items?page=1',
      innerHeaders: [['Host', `${httpsUpstream.hostname}:${httpsUpstream.port}`]],
    });
    expect(disabledStateResponse.statusCode).toBe(200);
    let disabledStateEntry!: { id: string };
    await vi.waitFor(async () => {
      const traffic = (await harness!.request
        .get(`/api/admin/projects/${project.id}/traffic`).expect(200)).body as {
        entries: Array<{ id: string; path: string }>;
      };
      disabledStateEntry = [...traffic.entries].reverse().find(entry => entry.path === '/items')!;
      expect(disabledStateEntry).toBeDefined();
    });
    await harness.request
      .get(`/api/admin/projects/${project.id}/traffic/${disabledStateEntry.id}`)
      .expect(200)
      .expect(response => expect(response.body.appState).toMatchObject({
        mode: 'disabled',
        activeStateId: acceptanceState.id,
        resolutionSource: 'endpoint_default',
        fallbackReasons: ['app_state_mode_disabled'],
      }));
  }, 120_000);
});
