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
import type { HttpMethod, Project } from '../types';

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

/**
 * Forward a request to the real upstream server using native fetch.
 */
async function forwardRequest(
  baseUrl: string,
  req: ProxyIncomingRequest,
): Promise<ProxyOutgoingResponse> {
  const targetUrl = new URL(req.path, baseUrl);

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
): Promise<ProxyOutgoingResponse | null> {
  const startTime = Date.now();

  const project = getActiveProject();
  if (!project) {
    return null;
  }

  // Check if this host matches the project's baseUrl domain
  if (!project.baseUrl) {
    return null;
  }

  let projectHost: string;
  try {
    projectHost = new URL(project.baseUrl).hostname;
  } catch {
    return null;
  }

  if (projectHost !== host) {
    return null; // Not our domain — blind tunnel
  }

  const resources = listResources(project.id);
  const headerScenario = req.headers['x-mockmate-scenario'];

  const responseConfig = handleRequest(
    req.method as HttpMethod,
    req.path,
    resources,
    project.activeScenario,
    headerScenario,
  );

  // No matching resource — always forward to real server in proxy mode.
  // baseUrl is guaranteed to exist here (we matched the hostname against it above).
  if (!responseConfig) {
    const result = await forwardRequest(project.baseUrl, req);
    const duration = Date.now() - startTime;
    logRequest(req.method as HttpMethod, req.path, result.statusCode, duration, undefined, undefined, false, true);
    return result;
  }

  // Resource matched but marked passthrough — forward to real server.
  // In proxy mode we always have baseUrl (we matched the domain to get here),
  // so we don't require project.passthroughEnabled for per-resource passthrough.
  if (responseConfig.passthrough && project.baseUrl) {
    const result = await forwardRequest(project.baseUrl, req);
    const duration = Date.now() - startTime;
    logRequest(req.method as HttpMethod, req.path, result.statusCode, duration, undefined, undefined, false, true);
    return result;
  }

  // Apply delay
  if (responseConfig.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, responseConfig.delay));
  }

  // Return mock response
  const body = Buffer.from(JSON.stringify(responseConfig.body));
  const duration = Date.now() - startTime;

  logRequest(
    req.method as HttpMethod,
    req.path,
    responseConfig.statusCode,
    duration,
    undefined,
    responseConfig.scenario,
    !!headerScenario,
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
