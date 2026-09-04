import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepository } from '../repository/project-repository';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
} from '../runtime/create-runtime';
import { resolveProxyRequest, type ProxyIncomingRequest } from './proxy-handler';
import type { UpstreamTransport } from './upstream-transport';
import { normalizeOriginParts } from '../domain/http-origin';

const sensitiveQueryFamilies = [
  { family: 'credential', name: 'clientCredentialId' },
  { family: 'session', name: 'userSessionId' },
  { family: 'auth', name: 'authContext' },
] as const;

describe('resolveProxyRequest', () => {
  let root: string;
  let runtime: RuntimeContext;
  let repository: ProjectRepository;
  let projectId: string;
  const unusedTransport: UpstreamTransport = {
    forward: async () => { throw new Error('Unexpected upstream I/O'); },
  };

  function request(rawRequestTarget: string): ProxyIncomingRequest {
    const queryIndex = rawRequestTarget.indexOf('?');
    return {
      transport: 'https_mitm',
      method: 'GET',
      path: queryIndex < 0 ? rawRequestTarget : rawRequestTarget.slice(0, queryIndex),
      rawQuery: queryIndex < 0 ? '' : rawRequestTarget.slice(queryIndex + 1),
      rawRequestTarget,
      headers: {},
      rawHeaders: [],
      signal: new AbortController().signal,
    };
  }

  function context(hostname: string, scheme: 'http' | 'https', port: number, transport = unusedTransport) {
    const origin = normalizeOriginParts(scheme, hostname, port);
    return {
      projectId,
      authority: {
        origin,
        rawAuthority: origin.origin.slice(origin.origin.indexOf('://') + 3),
      },
      matchedAllowlistPattern: hostname,
      transport,
      traffic: runtime.traffic,
      requestId: 'req_proxy_handler',
    };
  }

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-proxy-handler-'));
    runtime = await createRuntime({
      rootDirectory: root,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: () => true,
    });
    repository = runtime.repository;
    const project = await repository.createProject({ name: 'Proxy handler' });
    projectId = project.id;
    await repository.updateRuntimeSettings(project.id, {
      interceptHosts: ['api.example.test', '2001:db8::1', 'passthrough.example.test'],
      captureRawTraffic: false,
      debugProvenanceHeaders: false,
      expectedRevision: 0,
    });
    await repository.setActiveProject(project.id, 0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime.dispose();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('resolves an explicit JSON null Body Asset without opening or buffering it', async () => {
    const body = await repository.putBody(
      projectId,
      Readable.from(Buffer.from('null')),
      { mediaType: 'application/json' },
      { maxBytes: 1024 },
    );
    await repository.createEndpoint(projectId, {
      name: 'Nullable',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/nullable' },
      mode: 'mock',
      variants: [{ name: 'Null', status: 200, responseHeaders: {}, bodyAssetId: body.id }],
      defaultVariantIndex: 0,
    });
    let opened = 0;
    const candidate = Object.create(repository) as ProjectRepository;
    candidate.openBody = (...args) => {
      opened += 1;
      return repository.openBody(...args);
    };

    const response = await resolveProxyRequest(
      candidate,
      request('/nullable'),
      context('api.example.test', 'https', 443),
    );

    expect(response).not.toBeNull();
    expect(response?.proxied).toBe(false);
    expect(response?.resolved).toMatchObject({ resolutionSource: 'endpoint_default' });
    expect(response?.body).toBeUndefined();
    expect(opened).toBe(0);
  });

  it.each([
    ['HTTPS default port', 'https://[2001:db8::1]', 'https' as const, 443],
    ['HTTPS non-default port', 'https://[2001:db8::1]:8443', 'https' as const, 8443],
    ['HTTP default port', 'http://[2001:db8::1]', 'http' as const, 80],
    ['HTTP non-default port', 'http://[2001:db8::1]:8080', 'http' as const, 8080],
  ])('matches bracketed IPv6 origin and repeated query through %s', async (
    _name,
    baseUrl,
    scheme,
    port,
  ) => {
    const endpoint = await repository.createEndpoint(projectId, {
      name: `IPv6 ${scheme} ${port}`,
      baseUrl,
      matcher: {
        method: 'GET',
        path: `/ipv6-${scheme}-${port}`,
        query: {
          tag: [
            { operator: 'equals', value: 'alpha' },
            { operator: 'equals', value: 'beta' },
          ],
        },
      },
      mode: 'mock',
      variants: [{ name: 'Matched', status: 204, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });

    const response = await resolveProxyRequest(
      repository,
      request(`/ipv6-${scheme}-${port}?tag=beta&tag=alpha`),
      context('2001:db8::1', scheme, port),
    );

    expect(response).toMatchObject({
      proxied: false,
      statusCode: 204,
      resolved: { endpointId: endpoint.id, resolutionSource: 'endpoint_default' },
    });
  });

  it('retains selected Endpoint evidence and the incoming target for passthrough', async () => {
    const endpoint = await repository.createEndpoint(projectId, {
      name: 'Matched passthrough',
      baseUrl: 'https://passthrough.example.test',
      matcher: {
        method: 'GET',
        path: '/forward',
        query: { apiToken: [{ operator: 'equals', value: 'proxy-log-secret' }] },
      },
      mode: 'passthrough',
    });
    const forward = vi.fn<UpstreamTransport['forward']>().mockResolvedValue({
      statusCode: 202,
      headers: [['content-type', 'text/plain']],
      body: Readable.from('upstream'),
      closeConnection: false,
    });

    const response = await resolveProxyRequest(
      repository,
      request('/forward?apiToken=proxy-log-secret'),
      context('passthrough.example.test', 'https', 443, { forward }),
    );

    expect(response).toMatchObject({
      proxied: true,
      statusCode: 202,
      decision: { reason: 'endpoint_passthrough', endpoint: { endpointId: endpoint.id } },
    });
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({
      authority: context('passthrough.example.test', 'https', 443).authority,
      rawRequestTarget: '/forward?apiToken=proxy-log-secret',
      method: 'GET',
    }));
    expect(runtime.traffic.list(projectId).entries).toEqual([]);
  });

  it.each(sensitiveQueryFamilies)(
    'does not create a premature Traffic record for $family passthrough query',
    async ({ family, name }) => {
      const exactValue = `${family}-proxy-exact`;
      const requestPath = `/forward-${family}`;
      await repository.createEndpoint(projectId, {
        name: `Forward ${family}`,
        baseUrl: 'https://passthrough.example.test',
        matcher: {
          method: 'GET',
          path: requestPath,
          query: { [name]: [{ operator: 'equals', value: exactValue }] },
        },
        mode: 'passthrough',
      });
      const forward = vi.fn<UpstreamTransport['forward']>().mockResolvedValue({
        statusCode: 200, headers: [], body: Readable.from('upstream'), closeConnection: false,
      });

      const response = await resolveProxyRequest(
        repository,
        request(`${requestPath}?${name}=${exactValue}`),
        context('passthrough.example.test', 'https', 443, { forward }),
      );

      expect(response).toMatchObject({ proxied: true, statusCode: 200 });
      expect(runtime.traffic.list(projectId).entries).toEqual([]);
    },
  );
});
