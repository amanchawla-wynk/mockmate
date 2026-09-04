import { parseRawQuery } from '../domain/query-matcher';
import type { EndpointDecision } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';
import type { RequestAuthority } from './request-authority';

export type RuntimeRoutingDecision =
  | { kind: 'blind'; inspected: false }
  | { kind: 'mock'; inspected: true; endpoint: EndpointDecision & { kind: 'mock' } }
  | {
    kind: 'upstream';
    inspected: true;
    reason: 'endpoint_passthrough';
    endpoint: EndpointDecision & { kind: 'passthrough' };
  }
  | {
    kind: 'upstream';
    inspected: true;
    reason: 'no_match_passthrough';
    provenanceReason?: 'query_parse_invalid';
  }
  | {
    kind: 'direct_unavailable';
    inspected: true;
    reason: 'direct_passthrough_unavailable';
    endpoint: EndpointDecision & { kind: 'passthrough' };
  }
  | {
    kind: 'direct_unavailable';
    inspected: true;
    reason: 'direct_miss';
    provenanceReason?: 'query_parse_invalid';
  };

export function decideRuntimeRequest(input: {
  transport: 'direct' | 'plain_http_proxy' | 'https_mitm';
  authority: RequestAuthority;
  rawRequestTarget: string;
  method: string;
  path: string;
  rawQuery: string;
  headers: Readonly<Record<string, readonly string[]>>;
  matchedAllowlistPattern?: string;
  repository: ProjectRepository;
  projectId: string;
}): RuntimeRoutingDecision {
  if (input.transport !== 'direct' && input.matchedAllowlistPattern === undefined) {
    return { kind: 'blind', inspected: false };
  }

  const query = parseRawQuery(input.rawQuery);
  if (!query.ok) {
    return input.transport === 'direct'
      ? {
        kind: 'direct_unavailable',
        inspected: true,
        reason: 'direct_miss',
        provenanceReason: query.reason,
      }
      : {
        kind: 'upstream',
        inspected: true,
        reason: 'no_match_passthrough',
        provenanceReason: query.reason,
      };
  }

  const endpoint = input.repository.resolve(input.projectId, {
    origin: input.authority.origin,
    method: input.method,
    path: input.path,
    query,
    headers: input.headers,
  });
  if (endpoint?.kind === 'mock') {
    return { kind: 'mock', inspected: true, endpoint };
  }
  if (endpoint?.kind === 'passthrough') {
    return input.transport === 'direct'
      ? {
        kind: 'direct_unavailable',
        inspected: true,
        reason: 'direct_passthrough_unavailable',
        endpoint,
      }
      : {
        kind: 'upstream',
        inspected: true,
        reason: 'endpoint_passthrough',
        endpoint,
      };
  }
  return input.transport === 'direct'
    ? { kind: 'direct_unavailable', inspected: true, reason: 'direct_miss' }
    : { kind: 'upstream', inspected: true, reason: 'no_match_passthrough' };
}
