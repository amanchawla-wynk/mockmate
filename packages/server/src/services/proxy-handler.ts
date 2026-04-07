/**
 * Express-independent request resolution for the proxy server.
 * Given an incoming request (method, path, headers, body), resolves it
 * against the active project's resources and returns either a mock
 * response or forwards the request to the real upstream server.
 */

import { getActiveProject } from './projects';
import { listResources } from './resources';
import { handleRequest } from './matcher';
import { logRequest } from './logger';
import type { HttpMethod } from '../types';
import { isHostIntercepted } from './intercept';
import { readConfig } from './storage';
import { writeHttpResponseFixture } from './fixtures';

function generateTrafficFixtureName(req: ProxyIncomingRequest, host: string, pathName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeHost = (host || 'unknown').replace(/[^a-zA-Z0-9.-]+/g, '_');
  const safeMethod = String(req.method || 'GET').toUpperCase().replace(/[^A-Z]+/g, '');
  const safePath = (pathName || '/').replace(/[^a-zA-Z0-9/_-]+/g, '_').replace(/\/+/, '/').replace(/\//g, '_');
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}__${safeHost}__${safeMethod}__${safePath}__${rand}`;
}

/** Minimal incoming request shape (no Express dependency) */
export interface ProxyIncomingRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}

/** Resolved response to send back over the raw socket */
export interface ProxyOutgoingResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  /** true when the response came from the real upstream server */
  proxied: boolean;
  /** scenario name when a mock was used */
  scenario?: string;
}

const PROXY_TIMEOUT_MS = 30_000;

const EXCLUDED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'proxy-connection',
  'content-length',
  'transfer-encoding',
  'x-mockmate-scenario',
]);

const EXCLUDED_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'content-encoding',
  'connection',
  'keep-alive',
]);

function parsePathAndQuery(rawPath: string): { pathname: string; query: Record<string, string> } {
  try {
    const url = new URL(rawPath, 'http://mockmate.local');
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      query[k] = v;
    }
    return { pathname: url.pathname, query };
  } catch {
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

function parseRequestBody(body: Buffer | undefined, headers: Record<string, string>): any {
  if (!body || body.length === 0) return undefined;

  const contentType = (headers['content-type'] ?? '').toLowerCase();
  const text = body.toString('utf-8');

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function parseResponseBody(
  body: Buffer,
  headers: Record<string, string>
): { value: any; truncated: boolean; size: number } {
  const size = body.length;
  const contentType = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();

  const isText =
    contentType.includes('application/json') ||
    contentType.includes('+json') ||
    contentType.startsWith('text/') ||
    contentType.includes('application/xml') ||
    contentType.includes('text/xml') ||
    contentType.includes('application/x-www-form-urlencoded');

  const MAX_CAPTURE_BYTES = 256 * 1024;
  const truncated = size > MAX_CAPTURE_BYTES;
  const slice = truncated ? body.subarray(0, MAX_CAPTURE_BYTES) : body;

  if (!isText) {
    return {
      value: {
        _binary: true,
        contentType: (headers['content-type'] ?? headers['Content-Type'] ?? 'application/octet-stream'),
        size,
      },
      truncated,
      size,
    };
  }

  const text = slice.toString('utf-8');
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return { value: JSON.parse(text), truncated, size };
    } catch {
      return { value: text, truncated, size };
    }
  }

  return { value: text, truncated, size };
}

function normalizeHeaderKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    out[key] = v;
  }
  return out;
}

/**
 * Forward a request to the real upstream server using native fetch.
 */
async function forwardRequest(
  origin: { scheme: 'http' | 'https'; host: string; port: number },
  req: ProxyIncomingRequest
): Promise<ProxyOutgoingResponse> {
  const originBase = `${origin.scheme}://${origin.host}${origin.port ? `:${origin.port}` : ''}`;
  const targetUrl = new URL(req.path, originBase);

  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!EXCLUDED_REQUEST_HEADERS.has(key.toLowerCase()) && value) {
      forwardHeaders[key] = value;
    }
  }

  const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: forwardHeaders,
      signal: controller.signal,
      redirect: 'manual',
    };

    if (hasBody && req.body && req.body.length > 0) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl.toString(), fetchOptions);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    const body = Buffer.from(await response.arrayBuffer());

    console.log(`[ProxyHandler] FORWARD ${req.method} ${targetUrl.toString()} → ${response.status}`);

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body,
      proxied: true,
    };
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      console.error(`[ProxyHandler] FORWARD ${req.method} ${targetUrl.toString()} → TIMEOUT`);
      return {
        statusCode: 504,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          error: 'Gateway Timeout',
          message: `Upstream server did not respond within ${PROXY_TIMEOUT_MS / 1000}s`,
        })),
        proxied: true,
      };
    }

    console.error(`[ProxyHandler] FORWARD ${req.method} ${targetUrl.toString()} → ERROR: ${err.message}`);
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        error: 'Bad Gateway',
        message: `Failed to reach upstream server: ${err.message}`,
      })),
      proxied: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve an incoming request:
 *  1. Look up the active project
 *  2. Match against resources
 *  3. Return mock response or forward to upstream
 *
 * Returns null when there is no active project whose baseUrl matches the
 * requested host — the caller should blind-tunnel in that case.
 */
export async function resolveProxyRequest(
  req: ProxyIncomingRequest,
  host: string,
  origin: { scheme: 'http' | 'https'; port: number }
): Promise<ProxyOutgoingResponse | null> {
  const startTime = Date.now();

  const parsed = parsePathAndQuery(req.path);
  const requestQuery = parsed.query;
  const requestBody = parseRequestBody(req.body, req.headers);
  const logPath = parsed.pathname;

  const project = getActiveProject();
  if (!project) {
    return null;
  }

  // Only intercept allowlisted hosts.
  if (!isHostIntercepted(project, host)) {
    return null;
  }

  // Serve local automation media from the HTTP server when requests come in
  // for /static_files on any intercepted host.
  if (parsed.pathname.startsWith('/static_files/')) {
    const cfg = readConfig();
    const httpPort = cfg.server?.httpPort || 3456;
    const result = await forwardRequest({ scheme: 'http', host: '127.0.0.1', port: httpPort }, req);
    const duration = Date.now() - startTime;
    const responseHeaders = normalizeHeaderKeys(result.headers);
    const resp = parseResponseBody(result.body, responseHeaders);
    logRequest(req.method as HttpMethod, logPath, result.statusCode, duration, undefined, undefined, false, true, {
      host,
      requestHeaders: req.headers,
      requestQuery,
      requestBody,
      responseHeaders,
      responseBody: resp.value,
      responseBodyTruncated: resp.truncated,
      responseSize: resp.size,
    });
    return result;
  }

  const resources = listResources(project.id);
  const headerScenario = req.headers['x-mockmate-scenario'];

  const responseConfig = handleRequest(
    req.method as HttpMethod,
    req.path,
    resources,
    project.activeScenario,
    project.baseScenario,
    headerScenario,
    { host, headers: req.headers },
    project.slug,
  );

  // No matching resource — always forward to real server in proxy mode.
  if (!responseConfig) {
    const result = await forwardRequest({ scheme: origin.scheme, host, port: origin.port }, req);
    const duration = Date.now() - startTime;
    const responseHeaders = normalizeHeaderKeys(result.headers);
    const resp = parseResponseBody(result.body, responseHeaders);
    const fixture = project.captureRawTraffic
      ? writeHttpResponseFixture(
          project.slug,
          `fixtures/traffic/${new Date().toISOString().slice(0, 10)}/${generateTrafficFixtureName(req, host, logPath)}.http`,
          result.statusCode,
          responseHeaders,
          result.body,
        )
      : null;

    logRequest(req.method as HttpMethod, logPath, result.statusCode, duration, undefined, undefined, false, true, {
      host,
      requestHeaders: req.headers,
      requestQuery,
      requestBody,
      responseHeaders,
      responseBody: resp.value,
      responseBodyTruncated: resp.truncated,
      responseSize: resp.size,
      responseFixture: fixture
        ? {
            path: fixture.relPath,
            size: fixture.size,
            truncated: fixture.truncated,
            contentType: fixture.contentType,
          }
        : undefined,
      proxiedReason: 'no_rule_match',
    });
    return result;
  }

  // Resource matched but marked passthrough — forward to real server.
  if (responseConfig.passthrough) {
    const result = await forwardRequest({ scheme: origin.scheme, host, port: origin.port }, req);
    const duration = Date.now() - startTime;
    const responseHeaders = normalizeHeaderKeys(result.headers);
    const resp = parseResponseBody(result.body, responseHeaders);
    const fixture = project.captureRawTraffic
      ? writeHttpResponseFixture(
          project.slug,
          `fixtures/traffic/${new Date().toISOString().slice(0, 10)}/${generateTrafficFixtureName(req, host, logPath)}.http`,
          result.statusCode,
          responseHeaders,
          result.body,
        )
      : null;

    logRequest(req.method as HttpMethod, logPath, result.statusCode, duration, undefined, undefined, false, true, {
      host,
      requestHeaders: req.headers,
      requestQuery,
      requestBody,
      responseHeaders,
      responseBody: resp.value,
      responseBodyTruncated: resp.truncated,
      responseSize: resp.size,
      responseFixture: fixture
        ? {
            path: fixture.relPath,
            size: fixture.size,
            truncated: fixture.truncated,
            contentType: fixture.contentType,
          }
        : undefined,
      proxiedReason: 'resource_passthrough',
    });
    return result;
  }

  // Apply delay
  if (responseConfig.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, responseConfig.delay));
  }

  // Return mock response (JSON or raw fixture)
  const body = responseConfig.rawBody
    ? responseConfig.rawBody
    : Buffer.from(JSON.stringify(responseConfig.body ?? {}));
  const duration = Date.now() - startTime;

  logRequest(
    req.method as HttpMethod,
    logPath,
    responseConfig.statusCode,
    duration,
    responseConfig.resourceId,
    responseConfig.scenario,
    !!headerScenario,
    false,
    {
      host,
      requestHeaders: req.headers,
      requestQuery,
      requestBody,
      scenarioSource: responseConfig.scenarioSource,
      responseHeaders: normalizeHeaderKeys(responseConfig.headers),
      responseBody: responseConfig.rawBody
        ? {
            _fixture: true,
            format: 'http',
          }
        : responseConfig.body,
      responseBodyTruncated: false,
      responseSize: body.length,
    }
  );

  console.log(`[ProxyHandler] MOCK ${req.method} ${req.path} → ${responseConfig.statusCode} (scenario: ${responseConfig.scenario})`);

  return {
    statusCode: responseConfig.statusCode,
    headers: responseConfig.headers,
    body,
    proxied: false,
    scenario: responseConfig.scenario,
  };
}
