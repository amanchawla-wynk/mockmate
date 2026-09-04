import type { ResponseHeaders } from '../domain/model';
import { PassThrough } from 'node:stream';
import { parseRawQuery } from '../domain/query-matcher';
import type { EndpointDecision, ResolvedMock } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';
import type { TrafficExchange } from '../domain/traffic';
import { HttpError } from './api-errors';
import type { RequestAuthority } from './request-authority';
import { decideRuntimeRequest, type RuntimeRoutingDecision } from './runtime-decision';
import type { TrafficService } from './traffic-service';
import { withoutReservedDebugHeaders } from './traffic-provenance';
import { currentTrafficAppState, projectTrafficDecision } from './traffic-evidence';
import type { HeaderTuple, UpstreamTransport } from './upstream-transport';

export interface ProxyIncomingRequest {
  transport: 'plain_http_proxy' | 'https_mitm';
  method: string;
  path: string;
  rawQuery: string;
  rawRequestTarget: string;
  httpVersion?: string;
  headers: Readonly<Record<string, readonly string[]>>;
  rawHeaders: readonly HeaderTuple[];
  body?: NodeJS.ReadableStream;
  signal: AbortSignal;
}

export interface ProxyRequestContext {
  projectId: string;
  authority: RequestAuthority;
  matchedAllowlistPattern?: string;
  transport: UpstreamTransport;
  traffic: TrafficService;
  requestId: string;
  onTraffic?(exchange: TrafficExchange): void;
  onRequestObservation?(observation: ProxyRequestObservation): void;
}

export type ProxyRequestObservationTerminal =
  | { kind: 'complete' }
  | { kind: 'incomplete' };

export interface ProxyRequestObservation {
  terminal: Promise<ProxyRequestObservationTerminal>;
  cancel(): void;
}

function observeForwardedRequest(
  source: NodeJS.ReadableStream,
  traffic: TrafficExchange,
): { body: NodeJS.ReadableStream; observation: ProxyRequestObservation } {
  const body = new PassThrough();
  let cancel: () => void = () => {};
  const terminal = new Promise<ProxyRequestObservationTerminal>(resolve => {
    let settled = false;
    const cleanup = () => {
      source.off('data', observe);
      source.off('end', complete);
      source.off('aborted', incomplete);
      source.off('error', fail);
      source.off('close', closed);
    };
    const settle = (result: ProxyRequestObservationTerminal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const observe = (chunk: Buffer) => traffic.observeRequest(Buffer.from(chunk));
    const complete = () => settle({ kind: 'complete' });
    const incomplete = () => {
      if (!body.destroyed) body.destroy();
      settle({ kind: 'incomplete' });
    };
    cancel = incomplete;
    const fail = (error: Error) => {
      if (!body.destroyed) body.destroy(error);
      settle({ kind: 'incomplete' });
    };
    const closed = () => {
      if (!('readableEnded' in source) || !source.readableEnded) incomplete();
    };
    source.on('data', observe);
    source.once('end', complete);
    source.once('aborted', incomplete);
    source.once('error', fail);
    source.once('close', closed);
    source.pipe(body);
  });
  return { body, observation: { terminal, cancel: () => cancel() } };
}

interface ResolvedProxyOutgoingResponse {
  statusCode: number;
  headers: ResponseHeaders;
  proxied: false;
  resolved: ResolvedMock;
  decision: Extract<RuntimeRoutingDecision, { kind: 'mock' }>;
  traffic: TrafficExchange;
}

interface ForwardedProxyOutgoingResponse {
  statusCode: number;
  headers: HeaderTuple[];
  body: NodeJS.ReadableStream;
  closeConnection: boolean;
  proxied: true;
  resolved?: never;
  decision: Exclude<RuntimeRoutingDecision, { kind: 'mock' | 'direct_unavailable' }>;
  traffic?: TrafficExchange;
}

export type ProxyOutgoingResponse = ResolvedProxyOutgoingResponse | ForwardedProxyOutgoingResponse;

export async function resolveProxyRequest(
  repository: ProjectRepository,
  request: ProxyIncomingRequest,
  context: ProxyRequestContext,
): Promise<ProxyOutgoingResponse> {
  const decision = decideRuntimeRequest({
    transport: request.transport,
    authority: context.authority,
    rawRequestTarget: request.rawRequestTarget,
    method: request.method,
    path: request.path,
    rawQuery: request.rawQuery,
    headers: request.headers,
    ...(context.matchedAllowlistPattern === undefined
      ? {}
      : { matchedAllowlistPattern: context.matchedAllowlistPattern }),
    repository,
    projectId: context.projectId,
  });
  let traffic: TrafficExchange | undefined;
  if (decision.inspected) {
    const appState = currentTrafficAppState(repository, context.projectId);
    traffic = context.traffic.begin({
      projectId: context.projectId,
      requestId: context.requestId,
      transport: request.transport,
      allowlistPattern: context.matchedAllowlistPattern!,
      origin: context.authority.origin,
      method: request.method,
      path: request.path,
      query: parseRawQuery(request.rawQuery),
      headers: request.rawHeaders,
      appState,
    });
    context.onTraffic?.(traffic);
    if (decision.kind !== 'direct_unavailable') {
      traffic.setDecision(projectTrafficDecision(decision, appState));
    }
  }

  if (decision.kind === 'mock') {
    const selected: EndpointDecision & { kind: 'mock' } = decision.endpoint;
    const resolved = {
      ...selected.resolved,
      responseHeaders: withoutReservedDebugHeaders(selected.resolved.responseHeaders),
    };
    return {
      statusCode: resolved.status,
      headers: { ...resolved.responseHeaders },
      proxied: false,
      resolved,
      decision,
      traffic: traffic!,
    };
  }

  if (decision.kind === 'direct_unavailable') {
    throw new Error('Proxy handler received a direct-only routing decision');
  }
  let response;
  try {
    let body = request.body;
    if (body !== undefined && traffic !== undefined) {
      const observed = observeForwardedRequest(body, traffic);
      body = observed.body;
      context.onRequestObservation?.(observed.observation);
    }
    response = await context.transport.forward({
      authority: context.authority,
      rawRequestTarget: request.rawRequestTarget,
      method: request.method,
      headers: request.rawHeaders,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
    if (code === 'UPSTREAM_TIMEOUT') {
      throw new HttpError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out');
    }
    throw new HttpError(502, 'UPSTREAM_FAILURE', 'Upstream request failed');
  }
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    closeConnection: response.closeConnection,
    proxied: true,
    decision,
    ...(traffic === undefined ? {} : { traffic }),
  };
}
