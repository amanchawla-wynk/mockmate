import { describe, expect, it, vi } from 'vitest';

import { normalizeHttpOrigin } from '../domain/http-origin';
import type { EndpointDecision } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';
import { decideRuntimeRequest } from './runtime-decision';
import type { RequestAuthority } from './request-authority';

const authority: RequestAuthority = {
  origin: normalizeHttpOrigin('https://api.example.test'),
  rawAuthority: 'api.example.test:443',
};

const passthrough: EndpointDecision & { kind: 'passthrough' } = {
  kind: 'passthrough',
  endpointId: 'ep_passthrough',
  endpointName: 'Selected passthrough',
  specificity: 120,
  endpointMode: 'passthrough',
  fallbackReasons: [],
};

const mock: EndpointDecision & { kind: 'mock' } = {
  kind: 'mock',
  endpointId: 'ep_mock',
  endpointName: 'Selected mock',
  specificity: 100,
  resolved: {
    projectId: 'project_1',
    endpointId: 'ep_mock',
    variantId: 'variant_1',
    resolutionSource: 'endpoint_default',
    fallbackReasons: [],
    status: 201,
    responseHeaders: {},
    delayMs: 0,
  },
};

function repositoryReturning(decision: EndpointDecision | null): {
  repository: ProjectRepository;
  resolve: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn(() => decision);
  return {
    repository: {
      resolve,
      getEndpoint: () => { throw new Error('Runtime decision must not read stored Endpoint baseUrl'); },
    } as unknown as ProjectRepository,
    resolve,
  };
}

function decide(options: {
  transport?: 'direct' | 'plain_http_proxy' | 'https_mitm';
  matchedAllowlistPattern?: string;
  rawQuery?: string;
  decision?: EndpointDecision | null;
} = {}) {
  const candidate = repositoryReturning(options.decision ?? null);
  const result = decideRuntimeRequest({
    transport: options.transport ?? 'plain_http_proxy',
    authority,
    rawRequestTarget: '/users/%2f?tag=one&tag=two',
    method: 'GET',
    path: '/users/%2f',
    rawQuery: options.rawQuery ?? 'tag=one&tag=two',
    headers: { 'x-mode': ['preview', 'audit'] },
    ...(options.matchedAllowlistPattern === undefined
      ? {}
      : { matchedAllowlistPattern: options.matchedAllowlistPattern }),
    repository: candidate.repository,
    projectId: 'project_1',
  });
  return { result, resolve: candidate.resolve };
}

describe('runtime routing decision', () => {
  it.each(['plain_http_proxy', 'https_mitm'] as const)(
    'keeps non-allowlisted %s traffic blind without inspecting the repository',
    transport => {
      const { result, resolve } = decide({ transport, decision: mock });

      expect(result).toEqual({ kind: 'blind', inspected: false });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('passes allowlisted no-match proxy traffic to its incoming upstream', () => {
    const { result, resolve } = decide({ matchedAllowlistPattern: '*.example.test' });

    expect(result).toEqual({ kind: 'upstream', inspected: true, reason: 'no_match_passthrough' });
    expect(resolve).toHaveBeenCalledWith('project_1', {
      origin: authority.origin,
      method: 'GET',
      path: '/users/%2f',
      query: {
        ok: true,
        entries: [{ name: 'tag', value: 'one' }, { name: 'tag', value: 'two' }],
      },
      headers: { 'x-mode': ['preview', 'audit'] },
    });
  });

  it('returns all selected passthrough Endpoint evidence for proxy traffic', () => {
    expect(decide({ matchedAllowlistPattern: '*', decision: passthrough }).result).toEqual({
      kind: 'upstream',
      inspected: true,
      reason: 'endpoint_passthrough',
      endpoint: passthrough,
    });
  });

  it('returns all selected mock Endpoint evidence', () => {
    expect(decide({ matchedAllowlistPattern: '*', decision: mock }).result).toEqual({
      kind: 'mock',
      inspected: true,
      endpoint: mock,
    });
  });

  it('makes selected direct passthrough unavailable with Endpoint evidence', () => {
    expect(decide({ transport: 'direct', decision: passthrough }).result).toEqual({
      kind: 'direct_unavailable',
      inspected: true,
      reason: 'direct_passthrough_unavailable',
      endpoint: passthrough,
    });
  });

  it('returns endpoint-less direct miss', () => {
    expect(decide({ transport: 'direct' }).result).toEqual({
      kind: 'direct_unavailable',
      inspected: true,
      reason: 'direct_miss',
    });
  });

  it('treats invalid proxy query as an annotated no-match without repository selection', () => {
    const { result, resolve } = decide({
      matchedAllowlistPattern: '*',
      rawQuery: 'bad=%ZZ',
      decision: mock,
    });

    expect(result).toEqual({
      kind: 'upstream',
      inspected: true,
      reason: 'no_match_passthrough',
      provenanceReason: 'query_parse_invalid',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('treats invalid direct query as an annotated endpoint-less miss', () => {
    const { result, resolve } = decide({
      transport: 'direct',
      rawQuery: 'bad=%FF',
      decision: passthrough,
    });

    expect(result).toEqual({
      kind: 'direct_unavailable',
      inspected: true,
      reason: 'direct_miss',
      provenanceReason: 'query_parse_invalid',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
