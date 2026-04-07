/**
 * Request matching service
 * Matches incoming HTTP requests to resources and resolves scenarios
 */

import type { Resource, Scenario, HttpMethod } from '../types';
import { hostMatchesPattern } from './intercept';
import { readHttpResponseFixture } from './fixtures';

/**
 * Path parameter extraction result
 */
export interface PathParams {
  [key: string]: string;
}

/**
 * Match result containing resource and extracted parameters
 */
export interface MatchResult {
  resource: Resource;
  params: PathParams;
}

export interface RequestMatchContext {
  host?: string;
  /** Query params (decoded). When both URL and ctx include a key, ctx wins. */
  query?: Record<string, string>;
  /** Request headers (any casing). Header matching is case-insensitive. */
  headers?: Record<string, string>;
}

function parsePathAndQuery(rawPath: string): { pathname: string; query: Record<string, string> } {
  // rawPath is usually "/foo?bar=baz".
  // Use a dummy base to let URL do the parsing.
  try {
    const url = new URL(rawPath, 'http://mockmate.local');
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      // Keep the last value when duplicate keys exist.
      query[k] = v;
    }
    return { pathname: url.pathname, query };
  } catch {
    // Best-effort fallback.
    const [pathname, search] = rawPath.split('?', 2);
    const query: Record<string, string> = {};
    if (search) {
      for (const part of search.split('&')) {
        const [k, v] = part.split('=', 2);
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      }
    }
    return { pathname: pathname || rawPath, query };
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.trim().toLowerCase();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

function valueMatchesPattern(pattern: string, actual: string): boolean {
  // Use the same wildcard semantics as host matching.
  return hostMatchesPattern(pattern, actual);
}

function renderTemplateString(
  input: string,
  ctx: { query: Record<string, string>; params: PathParams; headers: Record<string, string> }
): any {
  // If the whole value is exactly one token, allow returning non-string values.
  const full = input.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  const expr = full ? full[1] : null;

  const resolve = (e: string): any => {
    if (e === 'now_ms') return Date.now();
    const plus = e.match(/^now_ms_plus:(-?\d+)$/);
    if (plus) return Date.now() + parseInt(plus[1], 10);
    const minus = e.match(/^now_ms_minus:(-?\d+)$/);
    if (minus) return Date.now() - parseInt(minus[1], 10);

    const q = e.match(/^query\.([a-zA-Z0-9_\-]+)$/);
    if (q) return ctx.query[q[1]] ?? '';
    const p = e.match(/^params\.([a-zA-Z0-9_\-]+)$/);
    if (p) return ctx.params[p[1]] ?? '';
    const h = e.match(/^headers\.([a-zA-Z0-9_\-]+)$/);
    if (h) return ctx.headers[h[1].toLowerCase()] ?? '';

    return '';
  };

  if (expr) {
    return resolve(expr.trim());
  }

  // Interpolate tokens inside a longer string.
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => String(resolve(String(e).trim())));
}

function renderTemplates(value: any, ctx: { query: Record<string, string>; params: PathParams; headers: Record<string, string> }): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return renderTemplateString(value, ctx);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = renderTemplates(value[i], ctx);
    }
    return value;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      (value as any)[k] = renderTemplates(v, ctx);
    }
    return value;
  }
  return value;
}

/**
 * Response configuration built from scenario
 */
export interface ResponseConfig {
  statusCode: number;
  headers: Record<string, string>;
  body?: any;
  /** Raw body bytes (for fixture-backed or binary responses). */
  rawBody?: Buffer;
  delay: number;
  scenario: string;
  resourceId?: string;
  scenarioSource?: 'header' | 'active' | 'active_base' | 'base' | 'default';
  /** Whether this resource should be proxied to the real server */
  passthrough?: boolean;
}

/**
 * Convert a path pattern to a regular expression
 * Converts /api/users/:id to a regex that matches /api/users/123
 * @param path - Path pattern (e.g., "/api/users/:id")
 * @returns Regex pattern and list of parameter names
 */
export function pathToRegex(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];

  // Escape special regex characters except :
  let pattern = path.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');

  // Replace :paramName with a capturing group
  pattern = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, paramName) => {
    paramNames.push(paramName);
    return '([^/]+)'; // Match any character except /
  });

  // Ensure exact match (start and end)
  pattern = `^${pattern}$`;

  return {
    regex: new RegExp(pattern),
    paramNames,
  };
}

/**
 * Extract path parameters from a matched URL
 * @param path - Request path (e.g., "/api/users/123")
 * @param pattern - Resource path pattern (e.g., "/api/users/:id")
 * @returns Extracted parameters object
 */
export function extractParams(path: string, pattern: string): PathParams {
  const { regex, paramNames } = pathToRegex(pattern);
  const match = path.match(regex);

  if (!match) {
    return {};
  }

  const params: PathParams = {};

  // match[0] is the full match, match[1..n] are the capturing groups
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]] = match[i + 1];
  }

  return params;
}

/**
 * Match an incoming request to a resource
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Request path
 * @param resources - Available resources
 * @returns Match result or null if no match found
 */
export function matchRequest(
  method: HttpMethod,
  rawPath: string,
  resources: Resource[],
  ctx?: RequestMatchContext
): MatchResult | null {
  const parsed = parsePathAndQuery(rawPath);
  const incomingQuery = { ...parsed.query, ...(ctx?.query ?? {}) };
  const incomingHost = (ctx?.host ?? '').trim().toLowerCase() || undefined;
  const incomingHeaders = normalizeHeaders(ctx?.headers);

  // Normalize path (remove trailing slash unless it's the root path)
  const normalizedPath = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');

  let best: MatchResult | null = null;
  let bestScore = -Infinity;

  const scoreResource = (resource: Resource, normalizedResourcePath: string): number => {
    const hasHost = resource.host ? 1 : 0;
    const qCount = Object.keys(resource.match?.query ?? {}).length;
    const hCount = Object.keys(resource.match?.headers ?? {}).length;

    const { paramNames } = pathToRegex(normalizedResourcePath);
    const segments = normalizedResourcePath.split('/').filter(Boolean).length;
    const staticSegments = Math.max(0, segments - paramNames.length);

    // Prefer more constrained rules.
    return hasHost * 10_000 + qCount * 1_000 + hCount * 100 + staticSegments * 10 - paramNames.length;
  };

  for (const resource of resources) {
    // Check if method matches
    if (resource.method !== method) {
      continue;
    }

    // Check host match (if scoped)
    if (resource.host) {
      const resourceHost = resource.host.trim().toLowerCase();
      if (!incomingHost) {
        continue;
      }
      if (!hostMatchesPattern(resourceHost, incomingHost)) {
        continue;
      }
    }

    // Normalize resource path
    const normalizedResourcePath = resource.path === '/'
      ? '/'
      : resource.path.replace(/\/$/, '');

    // Try to match the path
    const { regex } = pathToRegex(normalizedResourcePath);

    if (regex.test(normalizedPath)) {
      // Optional query/header match to disambiguate resources
      if (resource.match?.query) {
        let ok = true;
        for (const [k, expected] of Object.entries(resource.match.query)) {
          const actual = incomingQuery[k];
          if (actual === undefined || !valueMatchesPattern(expected, actual)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }

      if (resource.match?.headers) {
        let ok = true;
        for (const [k, expected] of Object.entries(resource.match.headers)) {
          const key = k.trim().toLowerCase();
          const actual = incomingHeaders[key];
          if (actual === undefined || !valueMatchesPattern(expected, actual)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }

      // Extract parameters
      const params = extractParams(normalizedPath, normalizedResourcePath);

      const score = scoreResource(resource, normalizedResourcePath);
      if (score > bestScore) {
        bestScore = score;
        best = { resource, params };
      }
    }
  }

  return best;
}

/**
 * Resolve scenario from resource with fallback logic
 * Priority: specified scenario → default scenario → first scenario
 * @param resource - Resource containing scenarios
 * @param scenarioName - Requested scenario name (optional)
 * @returns Resolved scenario
 */
export function resolveScenario(
  resource: Resource,
  scenarioName?: string
): Scenario {
  // If no scenario specified, use default
  if (!scenarioName) {
    const defaultScenario = resource.scenarios.find(s => s.name === 'default');
    if (defaultScenario) {
      return defaultScenario;
    }

    // Fallback to first scenario if no default exists
    if (resource.scenarios.length > 0) {
      return resource.scenarios[0];
    }

    // Should never happen, but provide a safe fallback
    return {
      name: 'default',
      statusCode: 200,
      body: {},
      headers: {},
      delay: 0,
    };
  }

  // Try to find requested scenario
  const scenario = resource.scenarios.find(s => s.name === scenarioName);
  if (scenario) {
    return scenario;
  }

  // Fallback to default scenario if requested scenario not found
  const defaultScenario = resource.scenarios.find(s => s.name === 'default');
  if (defaultScenario) {
    return defaultScenario;
  }

  // Fallback to first scenario
  if (resource.scenarios.length > 0) {
    return resource.scenarios[0];
  }

  // Should never happen, but provide a safe fallback
  return {
    name: 'default',
    statusCode: 200,
    body: {},
    headers: {},
    delay: 0,
  };
}

/**
 * Build response configuration from scenario
 * @param scenario - Scenario to build response from
 * @param params - Path parameters extracted from URL
 * @returns Response configuration
 */
export function buildResponse(
  scenario: Scenario,
  params: PathParams = {},
  fixtureProjectSlug?: string,
): ResponseConfig {
  if (scenario.fixture && fixtureProjectSlug) {
    const { statusCode, headers, body } = readHttpResponseFixture(
      fixtureProjectSlug,
      scenario.fixture.path,
    );

    return {
      statusCode,
      headers,
      rawBody: body,
      delay: scenario.delay ?? 0,
      scenario: scenario.name,
    };
  }

  // Create default headers and merge with response headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(scenario.headers ?? {}),
    ...(scenario.responseHeaders ?? {}),
  };

  const body = scenario.body;

  return {
    statusCode: scenario.statusCode,
    headers,
    body,
    delay: scenario.delay ?? 0,
    scenario: scenario.name,
  };
}

/**
 * Main request handler that combines matching, scenario resolution, and response building
 * @param method - HTTP method
 * @param path - Request path
 * @param resources - Available resources
 * @param activeScenario - Active scenario name from project
 * @param headerScenario - Scenario specified in X-MockMate-Scenario header (optional)
 * @returns Response configuration or null if no match
 */
export function handleRequest(
  method: HttpMethod,
  rawPath: string,
  resources: Resource[],
  activeScenario: string,
  baseScenario: string,
  headerScenario?: string,
  ctx?: RequestMatchContext,
  fixtureProjectSlug?: string,
): ResponseConfig | null {
  // Match request to resource
  const match = matchRequest(method, rawPath, resources, ctx);

  if (!match) {
    return null;
  }

  // Determine which scenario to use.
  // Priority: header-specified → active scenario → base scenario → default.
  // Additionally, for stateful scenarios like "test001__content_added",
  // fall back to the base "test001" if the suffixed scenario isn't present.
  let requested = (headerScenario ?? activeScenario ?? '').trim();
  // Treat "default" as "no override" so baseScenario can still apply.
  // This is important for automation flows where the server may be in the default
  // global scenario but the auth/persona baseline should still be applied.
  if (!headerScenario && requested.toLowerCase() === 'default') {
    requested = '';
  }
  const requestedBase = requested.includes('__') ? requested.split('__')[0] : '';
  const base = (baseScenario ?? '').trim();

  const candidates: string[] = [];
  for (const s of [requested, requestedBase, base]) {
    const name = (s ?? '').trim();
    if (!name) continue;
    if (!candidates.includes(name)) candidates.push(name);
  }

  console.log(`[Matcher] Selecting scenario for ${method} ${rawPath}:`);
  console.log(`  - Header scenario: ${headerScenario || 'none'}`);
  console.log(`  - Active scenario: ${activeScenario}`);
  console.log(`  - Base scenario: ${baseScenario}`);
  console.log(`  - Candidates: ${candidates.join(' -> ') || '<none>'}`);
  console.log(`  - Available scenarios: ${match.resource.scenarios.map(s => s.name).join(', ')}`);

  let scenario: Scenario | undefined;
  let scenarioSource: ResponseConfig['scenarioSource'] = 'default';
  for (const name of candidates) {
    scenario = match.resource.scenarios.find(s => s.name === name);
    if (scenario) {
      if (headerScenario && name === headerScenario) scenarioSource = 'header';
      else if (name === requested) scenarioSource = 'active';
      else if (name === requestedBase) scenarioSource = 'active_base';
      else if (name === base) scenarioSource = 'base';
      break;
    }
  }
  // Final fallback to default behavior (default scenario or first).
  if (!scenario) {
    scenario = resolveScenario(match.resource, undefined);
    scenarioSource = 'default';
  }

  console.log(`  - Resolved to: ${scenario.name}`);

  // Build response
  const response = buildResponse(scenario, match.params, fixtureProjectSlug);
  response.scenarioSource = scenarioSource;
  response.resourceId = match.resource.id;

  // Apply template rendering for JSON bodies (both inline and fixture-backed).
  const parsed = parsePathAndQuery(rawPath);
  const query = { ...parsed.query, ...(ctx?.query ?? {}) };
  const headers = normalizeHeaders(ctx?.headers);
  const tmplCtx = { query, params: match.params, headers };
  const contentType = String(response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? '').toLowerCase();

  if (response.rawBody && (contentType.includes('application/json') || contentType.includes('+json'))) {
    try {
      const json = JSON.parse(response.rawBody.toString('utf-8'));
      const rendered = renderTemplates(json, tmplCtx);
      response.rawBody = Buffer.from(JSON.stringify(rendered), 'utf-8');
    } catch {
      // ignore
    }
  } else if (response.body && (contentType.includes('application/json') || contentType.includes('+json') || contentType.startsWith('text/'))) {
    try {
      response.body = renderTemplates(response.body, tmplCtx);
    } catch {
      // ignore
    }
  }

  // Propagate passthrough flag from resource
  if (match.resource.passthrough) {
    response.passthrough = true;
  }

  return response;
}
