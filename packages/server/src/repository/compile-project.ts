import type { NormalizedOrigin } from '../domain/http-origin';
import { normalizeHttpOrigin } from '../domain/http-origin';
import {
  canonicalizeQueryConstraints,
  queryConstraintsMatch,
  type QueryParseResult,
} from '../domain/query-matcher';
import type {
  EndpointDetail,
  EndpointMatcherInput,
  EndpointMode,
  MatchExpression,
  ResponseHeaders,
} from '../domain/model';
import { compileWildcardPattern } from './match-expression';
import type { ValidatedProjectSnapshot } from './snapshot';

export type ResolutionSource =
  | 'project_active_state'
  | 'project_base_state'
  | 'endpoint_default';

export type FallbackReason =
  | 'app_state_mode_disabled'
  | 'active_state_not_set'
  | 'active_state_unbound'
  | 'base_state_not_set'
  | 'base_state_unbound';

export interface MatchRequest {
  origin: NormalizedOrigin;
  method: string;
  path: string;
  query: QueryParseResult;
  headers: Readonly<Record<string, readonly string[]>>;
}

export interface CompiledEndpointMatch {
  endpointId: string;
  specificity: number;
}

export interface CompiledVariant {
  id: string;
  status: number;
  responseHeaders: Readonly<ResponseHeaders>;
  delayMs: number;
  bodyAssetId?: string;
}

type CompiledExpression = (value: string | undefined) => boolean;

export interface CompiledMatcher {
  origin: string;
  method: CompiledExpression;
  path: CompiledExpression;
  query?: Readonly<Record<string, readonly MatchExpression[]>>;
  headers: ReadonlyMap<string, CompiledExpression>;
}

interface CompiledEndpoint {
  name: string;
  mode: EndpointMode;
  defaultVariantId?: string;
  variants: ReadonlyMap<string, CompiledVariant>;
}

export interface CompiledProject {
  projectId: string;
  appStateMode: 'enabled' | 'disabled';
  activeStateId?: string;
  baseStateId?: string;
  matchers: ReadonlyArray<{
    endpointId: string;
    matcher: CompiledMatcher;
    specificity: number;
  }>;
  endpoints: ReadonlyMap<string, CompiledEndpoint>;
  states: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface MatcherSpecificityExtras {
  queryCount: number;
  exactQueryCount: number;
  headerCount: number;
  exactHeaderCount: number;
}

export interface ResolvedMock {
  projectId: string;
  endpointId: string;
  variantId: string;
  selectedStateId?: string;
  resolutionSource: ResolutionSource;
  fallbackReasons: FallbackReason[];
  status: number;
  responseHeaders: ResponseHeaders;
  delayMs: number;
  bodyAssetId?: string;
}

export type EndpointDecision =
  | { kind: 'passthrough'; endpointId: string; endpointName: string; specificity: number }
  | {
    kind: 'mock';
    endpointId: string;
    endpointName: string;
    specificity: number;
    resolved: ResolvedMock;
  };

export class CompileProjectError extends Error {
  readonly name = 'CompileProjectError';

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class StateCoverageError extends Error {
  readonly name = 'StateCoverageError';
  readonly code = 'STATE_NOT_FOUND';

  constructor(readonly stateId: string) {
    super(`App State ${stateId} was not found in the compiled Project`);
  }
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(values: Iterable<readonly [K, V]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
}

function immutableMap<K, V>(values: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(values);
}

function fail(code: string, message: string): never {
  throw new CompileProjectError(code, message);
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareRanks(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = right[index] - left[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function cloneResponseHeaders(headers: Readonly<ResponseHeaders>): ResponseHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? [...value] : value,
  ]));
}

function freezeResponseHeaders(headers: ResponseHeaders): Readonly<ResponseHeaders> {
  return Object.freeze(Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? Object.freeze([...value]) : value,
  ]))) as Readonly<ResponseHeaders>;
}

export function normalizeMethod(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizePath(value: string): string {
  let pathname: string;
  try {
    pathname = new URL(value || '/', 'http://mockmate.local').pathname;
  } catch {
    [pathname] = value.split('?', 1);
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '') || '/';
}

export function normalizeCanonicalMatcher(matcher: EndpointMatcherInput): EndpointMatcherInput {
  const headers = matcher.headers === undefined
    ? undefined
    : Object.fromEntries(Object.entries(matcher.headers)
      .map(([name, expression]) => [name.trim().toLowerCase(), { ...expression }] as const)
      .sort(([left], [right]) => compareCodeUnits(left, right)));
  return {
    method: normalizeMethod(matcher.method),
    path: normalizePath(matcher.path),
    ...(canonicalizeQueryConstraints(matcher.query) === undefined
      ? {}
      : { query: canonicalizeQueryConstraints(matcher.query) }),
    ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

export function matcherSpecificity(
  matcher: EndpointMatcherInput,
  extras: MatcherSpecificityExtras = {
    queryCount: Object.values(matcher.query ?? {}).reduce(
      (count, expressions) => count + expressions.length,
      0,
    ),
    exactQueryCount: Object.values(matcher.query ?? {}).flat()
      .filter(expression => expression.operator === 'equals').length,
    headerCount: Object.keys(matcher.headers ?? {}).length,
    exactHeaderCount: Object.values(matcher.headers ?? {})
      .filter(expression => expression.operator === 'equals').length,
  },
): readonly number[] {
  const normalized = normalizeCanonicalMatcher(matcher);
  const staticPath = normalized.path.replaceAll('*', '');
  return Object.freeze([
    extras.queryCount,
    extras.exactQueryCount,
    extras.headerCount,
    extras.exactHeaderCount,
    staticPath.split('/').filter(Boolean).length,
    staticPath.length,
    normalized.path.includes('*') ? 0 : 1,
    normalized.method.includes('*') ? 0 : 1,
  ]);
}

function canonicalMatcherValue(matcher: EndpointMatcherInput): unknown {
  const normalized = normalizeCanonicalMatcher(matcher);
  return {
    method: normalized.method,
    path: normalized.path,
    query: normalized.query ?? null,
    headers: normalized.headers ?? null,
  };
}

export function canonicalEndpointIdentity(
  endpoint: Pick<EndpointDetail, 'baseUrl' | 'matcher'>,
): string {
  return JSON.stringify({
    baseUrl: normalizeHttpOrigin(endpoint.baseUrl).origin,
    matcher: canonicalMatcherValue(endpoint.matcher),
  });
}

function compileString(value: string, normalize: (input: string) => string): CompiledExpression {
  const normalized = normalize(value);
  return Object.freeze(normalized.includes('*')
    ? compileWildcardPattern(normalized)
    : (actual: string | undefined) => actual === normalized);
}

function compileExpression(expression: MatchExpression): CompiledExpression {
  return Object.freeze(expression.operator === 'equals'
    ? (actual: string | undefined) => actual === expression.value
    : compileWildcardPattern(expression.value));
}

function compileMatcher(source: EndpointDetail): {
  endpointId: string;
  matcher: CompiledMatcher;
  rank: readonly number[];
} {
  const normalized = normalizeCanonicalMatcher(source.matcher);
  const headerEntries = Object.entries(normalized.headers ?? {}).map(([name, expression]) => (
    [name, compileExpression(expression)] as const
  ));
  return {
    endpointId: source.id,
    matcher: Object.freeze({
      origin: normalizeHttpOrigin(source.baseUrl).origin,
      method: compileString(normalized.method, normalizeMethod),
      path: compileString(normalized.path, normalizePath),
      ...(normalized.query === undefined ? {} : { query: Object.freeze(normalized.query) }),
      headers: immutableMap(headerEntries),
    }),
    rank: matcherSpecificity(normalized),
  };
}

export function compileProject(snapshot: ValidatedProjectSnapshot): CompiledProject {
  const endpoints = new Map<string, CompiledEndpoint>();
  const matcherValues: Array<ReturnType<typeof compileMatcher>> = [];
  const endpointIdentities = new Set<string>();
  const variantIds = new Set<string>();

  for (const [mapId, source] of [...snapshot.endpoints].sort(([left], [right]) => (
    compareCodeUnits(left, right)
  ))) {
    if (mapId !== source.id) fail('ENDPOINT_ID_MISMATCH', `Endpoint map key ${mapId} does not match ${source.id}`);
    const identity = canonicalEndpointIdentity(source);
    if (endpointIdentities.has(identity)) {
      fail('ENDPOINT_IDENTITY_CONFLICT', `Endpoint ${source.id} duplicates a canonical Endpoint identity`);
    }
    endpointIdentities.add(identity);

    const variants = new Map<string, CompiledVariant>();
    for (const sourceVariant of source.variants) {
      if (sourceVariant.endpointId !== source.id) {
        fail('VARIANT_ENDPOINT_MISMATCH', `Variant ${sourceVariant.id} does not belong to Endpoint ${source.id}`);
      }
      if (variantIds.has(sourceVariant.id)) fail('DUPLICATE_VARIANT_ID', `Duplicate Variant ID ${sourceVariant.id}`);
      variantIds.add(sourceVariant.id);
      variants.set(sourceVariant.id, Object.freeze({
        id: sourceVariant.id,
        status: sourceVariant.status,
        responseHeaders: freezeResponseHeaders(sourceVariant.responseHeaders),
        delayMs: sourceVariant.delayMs ?? 0,
        ...(sourceVariant.bodyAssetId === undefined ? {} : { bodyAssetId: sourceVariant.bodyAssetId }),
      }));
    }
    const fallbackReady = source.defaultVariantId !== undefined && variants.has(source.defaultVariantId);
    if (source.mode === 'mock' && !fallbackReady) {
      fail('MISSING_DEFAULT_VARIANT', `Mock Endpoint ${source.id} requires a default Variant`);
    }
    if (source.mode === 'passthrough' && variants.size > 0 && !fallbackReady) {
      fail('MISSING_DEFAULT_VARIANT', `Passthrough Endpoint ${source.id} must retain its default Variant`);
    }
    endpoints.set(source.id, Object.freeze({
      name: source.name,
      mode: source.mode,
      ...(source.defaultVariantId === undefined ? {} : { defaultVariantId: source.defaultVariantId }),
      variants: immutableMap(variants),
    }));
    matcherValues.push(compileMatcher(source));
  }

  const states = new Map<string, ReadonlyMap<string, string>>();
  for (const [mapId, state] of [...snapshot.states].sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (mapId !== state.id) fail('STATE_ID_MISMATCH', `App State map key ${mapId} does not match ${state.id}`);
    const bindings: Array<readonly [string, string]> = [];
    for (const [endpointId, variantId] of Object.entries(state.bindings).sort(([left], [right]) => (
      compareCodeUnits(left, right)
    ))) {
      const endpoint = endpoints.get(endpointId);
      if (!endpoint) fail('UNKNOWN_BOUND_ENDPOINT', `App State ${state.id} binds unknown Endpoint ${endpointId}`);
      if (!endpoint.variants.has(variantId)) {
        fail('MISSING_BOUND_VARIANT', `App State ${state.id} binds missing Variant ${variantId}`);
      }
      bindings.push([endpointId, variantId]);
    }
    states.set(state.id, immutableMap(bindings));
  }

  for (const [field, stateId] of [
    ['activeStateId', snapshot.project.activeStateId],
    ['baseStateId', snapshot.project.baseStateId],
  ] as const) {
    if (stateId !== undefined && !states.has(stateId)) {
      fail('MISSING_SELECTED_STATE', `Project ${field} references missing App State ${stateId}`);
    }
  }

  matcherValues.sort((left, right) => compareRanks(left.rank, right.rank)
    || compareCodeUnits(left.endpointId, right.endpointId));
  let specificity = matcherValues.length;
  let priorRank: readonly number[] | undefined;
  const matchers = Object.freeze(matcherValues.map(value => {
    if (priorRank !== undefined && compareRanks(priorRank, value.rank) !== 0) specificity -= 1;
    priorRank = value.rank;
    return Object.freeze({
      endpointId: value.endpointId,
      matcher: value.matcher,
      specificity,
    });
  }));

  return Object.freeze({
    projectId: snapshot.project.id,
    appStateMode: snapshot.project.appStateMode,
    ...(snapshot.project.activeStateId === undefined ? {} : { activeStateId: snapshot.project.activeStateId }),
    ...(snapshot.project.baseStateId === undefined ? {} : { baseStateId: snapshot.project.baseStateId }),
    matchers,
    endpoints: immutableMap(endpoints),
    states: immutableMap(states),
  });
}

export function matchRequest(
  compiled: CompiledProject,
  request: MatchRequest,
): CompiledEndpointMatch | null {
  if (!request.query.ok) return null;
  const origin = normalizeHttpOrigin(request.origin.origin).origin;
  const method = normalizeMethod(request.method);
  const path = normalizePath(request.path);
  const headers = new Map<string, readonly string[]>();
  for (const [sourceName, values] of Object.entries(request.headers)) {
    const name = sourceName.trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), ...values]);
  }

  for (const candidate of compiled.matchers) {
    if (candidate.matcher.origin !== origin
      || !candidate.matcher.method(method)
      || !candidate.matcher.path(path)
      || !queryConstraintsMatch(candidate.matcher.query, request.query.entries)) continue;
    let matches = true;
    for (const [name, evaluator] of candidate.matcher.headers) {
      if (!(headers.get(name) ?? []).some(value => evaluator(value))) {
        matches = false;
        break;
      }
    }
    if (matches) return { endpointId: candidate.endpointId, specificity: candidate.specificity };
  }
  return null;
}

function resolved(
  compiled: CompiledProject,
  endpointId: string,
  variantId: string,
  resolutionSource: ResolutionSource,
  fallbackReasons: FallbackReason[],
  selectedStateId?: string,
): ResolvedMock {
  const variant = compiled.endpoints.get(endpointId)?.variants.get(variantId);
  if (!variant) fail('MISSING_COMPILED_VARIANT', `Compiled Variant ${variantId} is unavailable`);
  return {
    projectId: compiled.projectId,
    endpointId,
    variantId,
    ...(selectedStateId === undefined ? {} : { selectedStateId }),
    resolutionSource,
    fallbackReasons: [...fallbackReasons],
    status: variant.status,
    responseHeaders: cloneResponseHeaders(variant.responseHeaders),
    delayMs: variant.delayMs,
    ...(variant.bodyAssetId === undefined ? {} : { bodyAssetId: variant.bodyAssetId }),
  };
}

function resolveMock(compiled: CompiledProject, endpointId: string): ResolvedMock {
  const endpoint = compiled.endpoints.get(endpointId);
  if (!endpoint || endpoint.defaultVariantId === undefined) {
    fail('ENDPOINT_FALLBACK_REQUIRED', `Compiled Endpoint ${endpointId} is not mock-ready`);
  }
  if (compiled.appStateMode === 'disabled') {
    return {
      ...resolved(
      compiled,
      endpointId,
      endpoint.defaultVariantId,
      'endpoint_default',
      ['app_state_mode_disabled'],
      ),
      selectedStateId: undefined,
    };
  }
  const reasons: FallbackReason[] = [];
  if (compiled.activeStateId !== undefined) {
    const variantId = compiled.states.get(compiled.activeStateId)?.get(endpointId);
    if (variantId !== undefined) {
      return resolved(compiled, endpointId, variantId, 'project_active_state', reasons, compiled.activeStateId);
    }
    reasons.push('active_state_unbound');
  } else {
    reasons.push('active_state_not_set');
  }
  if (compiled.baseStateId !== undefined) {
    const variantId = compiled.states.get(compiled.baseStateId)?.get(endpointId);
    if (variantId !== undefined) {
      return resolved(compiled, endpointId, variantId, 'project_base_state', reasons, compiled.baseStateId);
    }
    reasons.push('base_state_unbound');
  } else {
    reasons.push('base_state_not_set');
  }
  return resolved(compiled, endpointId, endpoint.defaultVariantId, 'endpoint_default', reasons);
}

export function resolveEndpoint(
  compiled: CompiledProject,
  match: CompiledEndpointMatch,
): EndpointDecision {
  const endpoint = compiled.endpoints.get(match.endpointId);
  if (!endpoint) fail('ENDPOINT_NOT_FOUND', `Compiled Endpoint ${match.endpointId} was not found`);
  if (endpoint.mode === 'passthrough') {
    return {
      kind: 'passthrough',
      endpointId: match.endpointId,
      endpointName: endpoint.name,
      specificity: match.specificity,
    };
  }
  return {
    kind: 'mock',
    endpointId: match.endpointId,
    endpointName: endpoint.name,
    specificity: match.specificity,
    resolved: resolveMock(compiled, match.endpointId),
  };
}

export function calculateStateCoverage(
  compiled: CompiledProject,
  stateId: string,
): { bound: number; total: number; missingEndpointIds: string[] } {
  const state = compiled.states.get(stateId);
  if (!state) throw new StateCoverageError(stateId);
  const eligible = [...compiled.endpoints]
    .filter(([, endpoint]) => endpoint.mode === 'mock'
      && endpoint.defaultVariantId !== undefined
      && endpoint.variants.has(endpoint.defaultVariantId))
    .map(([endpointId]) => endpointId);
  const missingEndpointIds = eligible
    .filter(endpointId => !state.has(endpointId))
    .sort(compareCodeUnits);
  return {
    bound: eligible.length - missingEndpointIds.length,
    total: eligible.length,
    missingEndpointIds,
  };
}
