/**
 * Proxy service for passthrough mode
 * Forwards requests to the real backend server when no mock is configured
 * or when a resource is explicitly set to passthrough
 */

import type { Request } from 'express';

/**
 * Result from proxying a request to the upstream server
 */
export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  contentType: string;
  duration: number;
}

/**
 * Headers that should NOT be forwarded to the upstream server
 */
const EXCLUDED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-mockmate-scenario',
]);

/**
 * Headers that should NOT be forwarded back from the upstream response
 */
const EXCLUDED_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'content-encoding',
  'connection',
  'keep-alive',
]);

/**
 * Default timeout for proxy requests (30 seconds)
 */
const PROXY_TIMEOUT_MS = 30_000;

/**
 * Forward a request to the real upstream server
 * @param baseUrl - Base URL of the real server (e.g., "https://api.example.com")
 * @param req - Express request object
 * @returns Proxy result with status, headers, and body
 */
export async function proxyRequest(
  baseUrl: string,
  req: Request
): Promise<ProxyResult> {
  const startTime = Date.now();

  // Construct the target URL (preserves path + query string)
  const targetUrl = new URL(req.originalUrl, baseUrl);

  // Build forwarded headers
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (EXCLUDED_REQUEST_HEADERS.has(key.toLowerCase()) || !value) {
      continue;
    }
    forwardHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  // Build fetch options
  const method = req.method;
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method,
      headers: forwardHeaders,
      signal: controller.signal,
      redirect: 'manual', // Don't follow redirects — pass them to client
    };

    // Forward body for methods that carry one
    if (hasBody && req.body !== undefined) {
      fetchOptions.body = JSON.stringify(req.body);
      // Ensure content-type is set for JSON bodies
      if (!forwardHeaders['content-type']) {
        forwardHeaders['content-type'] = 'application/json';
      }
    }

    const response = await fetch(targetUrl.toString(), fetchOptions);

    // Extract response headers (filter out problematic ones)
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    // Read response body as buffer to handle any content type
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    const duration = Date.now() - startTime;

    console.log(`[Proxy] ${method} ${targetUrl.toString()} → ${response.status} (${duration}ms)`);

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body,
      contentType,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as Error;

    if (err.name === 'AbortError') {
      console.error(`[Proxy] ${method} ${targetUrl.toString()} → TIMEOUT (${PROXY_TIMEOUT_MS}ms)`);
      return {
        statusCode: 504,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          error: 'Gateway Timeout',
          message: `Upstream server did not respond within ${PROXY_TIMEOUT_MS / 1000} seconds`,
        })),
        contentType: 'application/json',
        duration,
      };
    }

    console.error(`[Proxy] ${method} ${targetUrl.toString()} → ERROR: ${err.message}`);
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        error: 'Bad Gateway',
        message: `Failed to reach upstream server: ${err.message}`,
      })),
      contentType: 'application/json',
      duration,
    };
  } finally {
    clearTimeout(timeout);
  }
}
