import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeHttpOrigin } from '../domain/http-origin';
import { TRAFFIC_LIMITS } from '../domain/traffic';
import {
  createProcessTrafficContext,
  createRuntime,
  type TrafficService,
} from './create-runtime';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-runtime-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('createRuntime', () => {
  it('warns only when response media type normalization genuinely defaults', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Media warnings' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    const capture = async (mediaType: string | undefined, requestId: string) => {
      const exchange = runtime.traffic.begin({
        projectId: project.id,
        requestId,
        transport: 'direct',
        allowlistPattern: 'api.example.test',
        origin: normalizeHttpOrigin('http://api.example.test'),
        method: 'GET',
        path: `/${requestId}`,
        query: { ok: true, entries: [] },
        headers: [],
        appState: { mode: 'enabled', fallbackReasons: [] },
      });
      exchange.setDecision({
        decision: 'direct_miss',
        appState: { mode: 'enabled', fallbackReasons: [] },
      });
      exchange.setResponse(200, [
        ...(mediaType === undefined ? [] : [['Content-Type', mediaType] as const]),
        ['Set-Cookie', 'private=session'] as const,
      ]);
      await exchange.finalize({ kind: 'response', status: 200, responseBytes: 0 });
      return runtime.traffic.get(project.id, exchange.trafficId)!;
    };

    const normalized = await capture('  Application/Octet-Stream  ', 'normalized');
    const malformed = await capture('not a media type', 'malformed');
    const missing = await capture(undefined, 'missing');

    expect(normalized.promotion).toMatchObject({
      state: 'eligible',
      review: {
        response: { mediaType: 'application/octet-stream', byteCount: 0 },
        warnings: ['sensitive_response_headers_persisted'],
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('private=session');
    expect(malformed.promotion.state === 'eligible' && malformed.promotion.review.warnings)
      .toContain('media_type_defaulted');
    expect(missing.promotion.state === 'eligible' && missing.promotion.review.warnings)
      .toContain('media_type_defaulted');
    await runtime.dispose();
  });

  it('uses canonical repeated request and response encodings for exact retained entities', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Repeated encodings' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      ...settings,
      expectedRevision: settings.revision,
      captureRawTraffic: true,
    });
    const requestBytes = Buffer.from([0x1f, 0x8b, 0x01, 0x02]);
    const responseBytes = Buffer.from([0xce, 0xb2, 0x03, 0x04]);
    const exchange = runtime.traffic.begin({
      projectId: project.id,
      requestId: 'request_repeated_encoding',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('http://api.example.test'),
      method: 'POST',
      path: '/encoded',
      query: { ok: true, entries: [] },
      headers: [
        ['Content-Type', 'application/octet-stream'],
        ['Content-Encoding', 'GZip, identity'],
        ['content-encoding', 'BR'],
      ],
      appState: { mode: 'disabled', fallbackReasons: [] },
    });
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'disabled', fallbackReasons: [] },
    });
    exchange.observeRequest(requestBytes);
    exchange.setResponse(200, [
      ['Content-Type', 'application/octet-stream'],
      ['Content-Encoding', 'GZip'],
      ['content-encoding', 'identity, BR'],
    ]);
    exchange.observeResponse(responseBytes);
    await exchange.finalize({ kind: 'response', status: 200, responseBytes: responseBytes.length });

    const detail = runtime.traffic.get(project.id, exchange.trafficId);
    expect(detail?.request.headers.filter(([name]) => name === 'content-encoding')).toEqual([
      ['content-encoding', 'gzip, br'],
    ]);
    expect(detail?.response.headers.filter(([name]) => name === 'content-encoding')).toEqual([
      ['content-encoding', 'gzip, br'],
    ]);
    expect(detail?.request.body).toMatchObject({ contentEncoding: 'gzip, br' });
    expect(detail?.response.body).toMatchObject({ contentEncoding: 'gzip, br' });
    for (const [side, expected] of [
      ['request', requestBytes],
      ['response', responseBytes],
    ] as const) {
      const opened = await runtime.traffic.openBody(project.id, exchange.trafficId, side);
      const chunks: Buffer[] = [];
      for await (const chunk of opened.lease.openStream()) chunks.push(Buffer.from(chunk));
      await opened.lease.release();
      expect(Buffer.concat(chunks)).toEqual(expected);
      expect(opened.descriptor.contentEncoding).toBe('gzip, br');
    }
    await runtime.dispose();
  });

  it('publishes utf8 JSON previews from gzip content-encoded entity bytes', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Gzip JSON preview' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      ...settings,
      expectedRevision: settings.revision,
      captureRawTraffic: true,
    });
    const plain = Buffer.from('{"ok":true,"n":1}');
    const encoded = gzipSync(plain);
    const exchange = runtime.traffic.begin({
      projectId: project.id,
      requestId: 'request_gzip_json',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('https://api.example.test'),
      method: 'GET',
      path: '/json',
      query: { ok: true, entries: [] },
      headers: [],
      appState: { mode: 'disabled', fallbackReasons: [] },
    });
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'disabled', fallbackReasons: [] },
    });
    exchange.setResponse(200, [
      ['Content-Type', 'application/json'],
      ['Content-Encoding', 'gzip'],
    ]);
    exchange.observeResponse(encoded.subarray(0, 8));
    exchange.observeResponse(encoded.subarray(8));
    await exchange.finalize({ kind: 'response', status: 200, responseBytes: encoded.length });

    const detail = runtime.traffic.get(project.id, exchange.trafficId);
    expect(detail?.response.preview).toEqual({
      encoding: 'utf8',
      value: '{"ok":true,"n":1}',
      truncated: false,
    });
    expect(detail?.response.body).toMatchObject({
      state: 'available',
      contentEncoding: 'gzip',
      sha256: createHash('sha256').update(encoded).digest('hex'),
      retainedSize: encoded.length,
    });
    await runtime.dispose();
  });

  it('never republishes malformed encoding metadata through cache eviction', async () => {
    const unsafe = 'gzip; key=/Users/alice/private.pem';
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext({
        ...TRAFFIC_LIMITS,
        projectRetainedBytes: 4,
        processRetainedBytes: 16,
      }),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Malformed encoding eviction' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      ...settings,
      expectedRevision: settings.revision,
      captureRawTraffic: true,
    });
    const capture = async (requestId: string, bytes: Buffer, encoding?: string) => {
      const exchange = runtime.traffic.begin({
        projectId: project.id,
        requestId,
        transport: 'direct',
        allowlistPattern: 'api.example.test',
        origin: normalizeHttpOrigin('http://api.example.test'),
        method: 'POST',
        path: `/${requestId}`,
        query: { ok: true, entries: [] },
        headers: encoding === undefined ? [] : [['Content-Encoding', encoding]],
        appState: { mode: 'disabled', fallbackReasons: [] },
      });
      exchange.setDecision({
        decision: 'direct_miss',
        appState: { mode: 'disabled', fallbackReasons: [] },
      });
      exchange.observeRequest(bytes);
      exchange.setResponse(200, encoding === undefined ? [] : [['Content-Encoding', encoding]]);
      exchange.observeResponse(bytes);
      await exchange.finalize({ kind: 'response', status: 200, responseBytes: bytes.length });
      return exchange.trafficId;
    };
    const malformedId = await capture('malformed', Buffer.from('bad!'), unsafe);
    await capture('replacement', Buffer.from('next'));

    const malformed = runtime.traffic.get(project.id, malformedId);
    expect(malformed?.promotion).toEqual({ state: 'blocked', reason: 'invalid_content_encoding' });
    expect(malformed?.request.body).not.toHaveProperty('contentEncoding');
    expect(malformed?.response.body).not.toHaveProperty('contentEncoding');
    expect(JSON.stringify(runtime.traffic.list(project.id))).not.toContain(unsafe);
    expect(JSON.stringify(malformed)).not.toContain(unsafe);
    await runtime.dispose();
  });

  it('rejects Traffic limits that cannot produce coherent schema-safe evidence', () => {
    expect(() => createProcessTrafficContext({
      ...TRAFFIC_LIMITS,
      previewBytes: 2,
      bodyBytes: 1,
    })).toThrow(/previewBytes/);
    expect(() => createProcessTrafficContext({
      ...TRAFFIC_LIMITS,
      bodyBytes: Number.MAX_SAFE_INTEGER,
    })).toThrow(/bodyBytes/);
  });

  it('initializes a clean root as an empty schema-v4 workspace', async () => {
    const rootDirectory = await temporaryRoot();
    const runtime = await createRuntime({
      rootDirectory,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });

    expect(runtime.repository.getWorkspaceState()).toEqual({ schemaVersion: 4, revision: 0 });
    expect(runtime.repository.listProjects()).toEqual([]);
    expect(JSON.parse(await fs.promises.readFile(path.join(rootDirectory, 'workspace.json'), 'utf8')))
      .toEqual({ schemaVersion: 4, revision: 0 });
    expect((await fs.promises.stat(path.join(rootDirectory, 'projects'))).isDirectory()).toBe(true);
    expect((await fs.promises.stat(path.join(rootDirectory, 'trash'))).isDirectory()).toBe(true);
    expect(runtime).not.toHaveProperty('app');
    expect(runtime).not.toHaveProperty('logger');
    await runtime.dispose();
  });

  it('restarts the fresh workspace without manufacturing a Project', async () => {
    const rootDirectory = await temporaryRoot();
    const processTraffic = createProcessTrafficContext();
    const first = await createRuntime({
      rootDirectory,
      processTraffic,
      isAdminRequestLocal: () => true,
    });
    await first.dispose();
    const second = await createRuntime({
      rootDirectory,
      processTraffic,
      isAdminRequestLocal: () => true,
    });

    expect(second.repository.getWorkspaceState()).toEqual(first.repository.getWorkspaceState());
    expect(second.repository.listProjects()).toEqual([]);
    await second.dispose();
  });

  it('isolates runtime rows while sharing only the explicitly injected process budget', async () => {
    const processTraffic = createProcessTrafficContext();
    const first = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic,
      isAdminRequestLocal: () => true,
    });
    const second = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic,
      isAdminRequestLocal: () => true,
    });
    const project = await first.repository.createProject({ name: 'First runtime' });
    const exchange = first.traffic.begin({
      projectId: project.id,
      requestId: 'req_runtime_1',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('http://api.example.test'),
      method: 'GET',
      path: '/runtime',
      query: { ok: true, entries: [] },
      headers: [],
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.setResponse(404, []);
    await exchange.finalize({ kind: 'response', status: 404, responseBytes: 0 });

    expect(first.traffic.list(project.id).entries).toHaveLength(1);
    expect(second.traffic.list(project.id).entries).toEqual([]);
    expect(processTraffic.bodyBudgets.snapshot().runtimes).toEqual({});

    await first.dispose();
    await second.dispose();
  });

  it('publishes an eviction that races row finalization without losing the sibling body', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext({
        ...TRAFFIC_LIMITS,
        projectRetainedBytes: 4,
        processRetainedBytes: 4,
      }),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Retention ordering' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    const exchange = runtime.traffic.begin({
      projectId: project.id,
      requestId: 'req_retention_ordering',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('http://api.example.test'),
      method: 'POST',
      path: '/retention-ordering',
      query: { ok: true, entries: [] },
      headers: [['Content-Type', 'text/plain']],
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.observeRequest(Buffer.from('req!'));
    await exchange.completeRequest();
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.setResponse(200, [['Content-Type', 'text/plain']]);
    exchange.observeResponse(Buffer.from('resp'));
    await exchange.finalize({ kind: 'response', status: 200, responseBytes: 4 });

    expect(runtime.traffic.get(project.id, exchange.trafficId)).toMatchObject({
      request: { body: { state: 'evicted', reason: 'retention_evicted' } },
      response: { body: { state: 'available', retainedSize: 4 } },
    });
    const response = await runtime.traffic.openBody(project.id, exchange.trafficId, 'response');
    const chunks: Buffer[] = [];
    for await (const chunk of response.lease.openStream() as AsyncIterable<Buffer>) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('resp'));
    await response.lease.release();
    await runtime.dispose();
  });

  it('abandons both exact sidecars when an exchange is cancelled', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Cancellation' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    const exchange = runtime.traffic.begin({
      projectId: project.id,
      requestId: 'req_cancelled_exchange',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('http://api.example.test'),
      method: 'POST',
      path: '/cancelled',
      query: { ok: true, entries: [] },
      headers: [['Content-Type', 'text/plain']],
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.observeRequest(Buffer.from('partial request'));
    exchange.setDecision({
      decision: 'direct_miss',
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    await exchange.finalize({ kind: 'cancelled', status: 499, responseBytes: 0 });

    expect(runtime.traffic.get(project.id, exchange.trafficId)).toMatchObject({
      request: { body: { state: 'unavailable', reason: 'stream_cancelled' } },
      response: { body: { state: 'unavailable', reason: 'stream_cancelled' } },
      captureState: 'complete',
      promotion: { state: 'blocked', reason: 'request_cancelled' },
    });
    expect(runtime.traffic.list(project.id).entries).toHaveLength(1);
    expect(runtime.traffic.list(project.id).entries[0]).toMatchObject({
      requestBodyState: 'unavailable',
      responseBodyState: 'unavailable',
    });
    await runtime.dispose();
  });

  it('recomputes current Endpoint, Variant, and State promotion targets on every detail read', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Promotion review' });
    const responseBody = await runtime.repository.putBody(
      project.id,
      Readable.from('reviewed'),
      { mediaType: 'text/plain', encoding: 'gzip' },
      { maxBytes: 16 },
    );
    const endpoint = await runtime.repository.createEndpoint(project.id, {
      name: 'Reviewed',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/reviewed' },
      mode: 'mock',
      variants: [{
        name: 'Default',
        status: 200,
        responseHeaders: {
          'Content-Type': 'application/problem+json',
          'Content-Encoding': 'br',
          Date: 'Tue, 01 Sep 2026 00:00:00 GMT',
          'X-Repeat': ['one', 'two'],
        },
        bodyAssetId: responseBody.id,
      }],
      defaultVariantIndex: 0,
    });
    const state = await runtime.repository.createState(project.id, {
      name: 'Reviewed state',
      tags: [],
      bindings: { [endpoint.id]: endpoint.variants[0]!.id },
    });
    await runtime.repository.setStateSelection(
      project.id,
      runtime.repository.getProject(project.id).revision,
      { activeStateId: state.id, allowFallback: true },
    );
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    const exchange = runtime.traffic.begin({
      projectId: project.id,
      requestId: 'req_current_review',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('http://api.example.test'),
      method: 'GET',
      path: '/reviewed',
      query: { ok: true, entries: [] },
      headers: [],
      appState: {
        mode: 'enabled',
        selectedStateId: state.id,
        resolutionSource: 'project_active_state',
        fallbackReasons: [],
      },
    });
    exchange.setDecision({
      decision: 'mock',
      endpoint: {
        id: endpoint.id,
        name: endpoint.name,
        specificity: 1,
        mode: 'mock',
      },
      variantId: endpoint.variants[0]!.id,
      bodyAssetId: responseBody.id,
      appState: {
        mode: 'enabled',
        selectedStateId: state.id,
        resolutionSource: 'project_active_state',
        fallbackReasons: [],
      },
    });
    exchange.setResponse(200, [
      ['X-Repeat', 'one'],
      ['X-Repeat', 'two'],
      ['Content-Encoding', 'gzip'],
      ['Content-Type', 'application/problem+json'],
      ['Date', 'Tue, 01 Sep 2026 00:00:00 GMT'],
      ['X-Request-Id', 'runtime-request-id'],
      ['X-MockMate-Project', project.id],
      ['Connection', 'keep-alive'],
      ['Content-Length', '8'],
    ]);
    exchange.observeResponse(Buffer.from('reviewed'));
    await exchange.finalize({ kind: 'response', status: 200, responseBytes: 8 });

    const changedEndpoint = await runtime.repository.setEndpointMode(project.id, endpoint.id, {
      mode: 'passthrough',
      expectedRevision: endpoint.revision,
    });
    const changedState = await runtime.repository.updateState(project.id, state.id, state.revision, {
      name: 'Current reviewed state',
    });
    const reviewed = runtime.traffic.get(project.id, exchange.trafficId);
    const expectedResponseIdentity = createHash('sha256').update(JSON.stringify({
      status: 200,
      headers: [
        ['content-type', 'application/problem+json'],
        ['date', 'Tue, 01 Sep 2026 00:00:00 GMT'],
        ['x-repeat', 'one'],
        ['x-repeat', 'two'],
      ],
      delayMs: 0,
      body: {
        mediaType: 'application/problem+json',
        contentEncoding: 'gzip',
        sha256: responseBody.id,
        byteCount: responseBody.size,
      },
    })).digest('hex');
    expect(reviewed?.promotion).toMatchObject({
      state: 'eligible',
      review: {
        expectedResponseIdentity,
        response: {
          mediaType: 'application/problem+json',
          contentEncoding: 'gzip',
          byteCount: responseBody.size,
          sha256: responseBody.id,
        },
        endpoint: {
          action: 'reuse',
          endpointId: endpoint.id,
          expectedRevision: changedEndpoint.revision,
          currentMode: 'passthrough',
          targetMode: 'mock',
        },
        variant: { action: 'reuse', variantId: endpoint.variants[0]!.id },
        state: {
          action: 'bind',
          stateId: state.id,
          expectedRevision: changedState.revision,
        },
      },
    });
    expect(reviewed?.response.body).toMatchObject({
      state: 'available',
      mediaType: 'application/problem+json',
      contentEncoding: 'gzip',
      retainedSize: responseBody.size,
      sha256: responseBody.id,
    });
    expect(reviewed?.response.headers).toEqual([
      ['x-repeat', 'one'],
      ['x-repeat', 'two'],
      ['content-encoding', 'gzip'],
      ['content-type', 'application/problem+json'],
      ['date', 'Tue, 01 Sep 2026 00:00:00 GMT'],
      ['x-request-id', 'runtime-request-id'],
      ['x-mockmate-project', project.id],
      ['connection', 'keep-alive'],
      ['content-length', '8'],
    ]);
    expect(reviewed?.promotion.state === 'eligible'
      && reviewed.promotion.review.response.headers).toEqual(reviewed?.response.headers);
    expect(JSON.stringify(reviewed)).not.toContain('"br"');
    expect(reviewed?.promotion.state === 'eligible' && reviewed.promotion.review.warnings)
      .not.toContain('media_type_defaulted');

    const currentMetadata = vi.spyOn(runtime.repository, 'getBodyMetadata');
    currentMetadata.mockReturnValue({
      ...responseBody,
      mediaType: 'application/json',
      encoding: 'gzip',
    });
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'reuse', variantId: endpoint.variants[0]!.id } },
    });
    currentMetadata.mockReturnValue({
      ...responseBody,
      encoding: 'deflate',
    });
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'create' } },
    });
    currentMetadata.mockImplementation(() => {
      throw new Error('Body Asset was deleted');
    });
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'create' } },
    });
    currentMetadata.mockRestore();
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'reuse', variantId: endpoint.variants[0]!.id } },
    });

    const changedDateVariant = await runtime.repository.updateVariant(
      project.id,
      endpoint.id,
      endpoint.variants[0]!.id,
      endpoint.variants[0]!.revision,
      {
        responseHeaders: {
          'Content-Type': 'application/problem+json',
          'Content-Encoding': 'br',
          Date: 'Wed, 02 Sep 2026 00:00:00 GMT',
          'X-Repeat': ['one', 'two'],
        },
      },
    );
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'create' } },
    });
    const restoredDateVariant = await runtime.repository.updateVariant(
      project.id,
      endpoint.id,
      changedDateVariant.id,
      changedDateVariant.revision,
      {
        responseHeaders: {
          'Content-Type': 'application/problem+json',
          'Content-Encoding': 'br',
          Date: 'Tue, 01 Sep 2026 00:00:00 GMT',
          'X-Repeat': ['one', 'two'],
        },
      },
    );
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'reuse', variantId: endpoint.variants[0]!.id } },
    });

    const delayedVariant = await runtime.repository.updateVariant(
      project.id,
      endpoint.id,
      endpoint.variants[0]!.id,
      restoredDateVariant.revision,
      { delayMs: 25 },
    );
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'create' } },
    });
    const resetVariant = await runtime.repository.updateVariant(
      project.id,
      endpoint.id,
      delayedVariant.id,
      delayedVariant.revision,
      { delayMs: null },
    );
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'reuse', variantId: endpoint.variants[0]!.id } },
    });

    await runtime.repository.updateVariant(
      project.id,
      endpoint.id,
      endpoint.variants[0]!.id,
      resetVariant.revision,
      {
        responseHeaders: {
          'Content-Type': 'application/problem+json',
          'Content-Encoding': 'br',
          Date: 'Tue, 01 Sep 2026 00:00:00 GMT',
          'X-Repeat': ['two', 'one'],
        },
      },
    );
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'create' } },
    });

    const currentEndpoint = runtime.repository.getEndpoint(project.id, endpoint.id);
    await runtime.repository.updateEndpoint(project.id, endpoint.id, currentEndpoint.revision, {
      matcher: { method: 'GET', path: '*' },
    });
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { endpoint: { action: 'create', targetMode: 'mock' } },
    });

    const broadened = runtime.repository.getEndpoint(project.id, endpoint.id);
    await runtime.repository.deleteEndpoint(project.id, endpoint.id, broadened.revision);
    const recreated = await runtime.repository.createEndpoint(project.id, {
      name: 'Recreated exact identity',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/reviewed' },
      mode: 'mock',
      variants: [{
        name: 'Recreated response',
        status: 200,
        responseHeaders: {
          'Content-Type': 'application/problem+json',
          'Content-Encoding': 'br',
          Date: 'Tue, 01 Sep 2026 00:00:00 GMT',
          'X-Repeat': ['one', 'two'],
        },
        bodyAssetId: responseBody.id,
      }],
      defaultVariantIndex: 0,
    });
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: {
        endpoint: {
          action: 'reuse',
          endpointId: recreated.id,
          expectedRevision: recreated.revision,
        },
        variant: { action: 'reuse', variantId: recreated.variants[0]!.id },
      },
    });

    const otherState = await runtime.repository.createState(project.id, {
      name: 'Current active state',
      tags: [],
      bindings: {},
    });
    await runtime.repository.setStateSelection(
      project.id,
      runtime.repository.getProject(project.id).revision,
      { activeStateId: otherState.id, allowFallback: true },
    );
    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: {
        state: {
          action: 'bind',
          stateId: otherState.id,
          expectedRevision: otherState.revision,
        },
      },
    });
    await runtime.dispose();
  });

  it('derives warning names from private evidence and includes headers in response identity', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Private review evidence' });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });

    const capture = async (headerValue: string) => {
      const exchange = runtime.traffic.begin({
        projectId: project.id,
        requestId: `req_${headerValue}`,
        transport: 'direct',
        allowlistPattern: 'api.example.test',
        origin: normalizeHttpOrigin('http://api.example.test'),
        method: 'GET',
        path: '/identity',
        query: { ok: true, entries: [{ name: 'access_token', value: 'exact-query-secret' }] },
        headers: [],
        appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
      });
      exchange.setDecision({
        decision: 'direct_miss',
        appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
      });
      exchange.setResponse(200, [
        ['Content-Type', 'text/plain'],
        ['Set-Cookie', 'session=exact-response-secret'],
        ['X-Identity', headerValue],
      ]);
      exchange.observeResponse(Buffer.from('same'));
      await exchange.finalize({ kind: 'response', status: 200, responseBytes: 4 });
      return runtime.traffic.get(project.id, exchange.trafficId)!;
    };

    const first = await capture('one');
    const second = await capture('two');
    expect(first.promotion).toMatchObject({
      state: 'eligible',
      review: {
        request: { sensitiveQueryNames: ['access_token'] },
        response: { sensitiveHeaderNames: ['set-cookie'] },
        warnings: expect.arrayContaining([
          'sensitive_query_values_persisted',
          'sensitive_response_headers_persisted',
        ]),
      },
    });
    expect(JSON.stringify(first)).not.toContain('exact-query-secret');
    expect(JSON.stringify(first)).not.toContain('exact-response-secret');
    expect(first.promotion.state === 'eligible' && first.promotion.review.expectedResponseIdentity)
      .not.toBe(second.promotion.state === 'eligible' && second.promotion.review.expectedResponseIdentity);
    await runtime.dispose();
  });

  it('reuses a bodyless Variant with an authored Content-Type', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const project = await runtime.repository.createProject({ name: 'Bodyless review identity' });
    const endpoint = await runtime.repository.createEndpoint(project.id, {
      name: 'Bodyless',
      baseUrl: 'http://api.example.test',
      matcher: { method: 'GET', path: '/bodyless' },
      mode: 'mock',
      variants: [{
        name: 'No content',
        status: 204,
        responseHeaders: { 'Content-Type': 'application/problem+json' },
      }],
      defaultVariantIndex: 0,
    });
    const settings = runtime.repository.getRuntimeSettings(project.id);
    await runtime.repository.updateRuntimeSettings(project.id, {
      expectedRevision: settings.revision,
      interceptHosts: ['api.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
    });
    const exchange = runtime.traffic.begin({
      projectId: project.id,
      requestId: 'req_bodyless_identity',
      transport: 'direct',
      allowlistPattern: 'api.example.test',
      origin: normalizeHttpOrigin('http://api.example.test'),
      method: 'GET',
      path: '/bodyless',
      query: { ok: true, entries: [] },
      headers: [],
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.setDecision({
      decision: 'mock',
      endpoint: { id: endpoint.id, name: endpoint.name, specificity: 1, mode: 'mock' },
      variantId: endpoint.variants[0]!.id,
      appState: { mode: 'enabled', fallbackReasons: ['active_state_not_set', 'base_state_not_set'] },
    });
    exchange.setResponse(204, [['Content-Type', 'application/problem+json']]);
    await exchange.finalize({ kind: 'response', status: 204, responseBytes: 0 });

    expect(runtime.traffic.get(project.id, exchange.trafficId)?.promotion).toMatchObject({
      state: 'eligible',
      review: { variant: { action: 'reuse', variantId: endpoint.variants[0]!.id } },
    });
    await runtime.dispose();
  });

  it('exposes an opaque Traffic service without storage or snapshot capabilities', async () => {
    const runtime = await createRuntime({
      rootDirectory: await temporaryRoot(),
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    const traffic: TrafficService = runtime.traffic;

    expect(traffic).not.toHaveProperty('store');
    expect(traffic).not.toHaveProperty('cache');
    expect(traffic).not.toHaveProperty('snapshotForAcceptance');
    expect(await import('./create-runtime')).not.toHaveProperty('getRuntimePromotionAcceptor');
    await runtime.dispose();
  });
});
