/**
 * HTTP/HTTPS Proxy Server
 *
 * Listens on a single port (default 8888). Devices configure this as their
 * WiFi HTTP proxy. When a request arrives:
 *
 *  - CONNECT host:port  →  HTTPS interception (MITM) if the host matches the
 *                           active project's baseUrl domain; blind tunnel otherwise.
 *  - GET http://...      →  Plain HTTP proxy (rare, most APIs are HTTPS).
 *
 * MITM flow:
 *  1. Send "200 Connection Established" to the client.
 *  2. Generate a TLS certificate for the target domain (signed by MockMate CA).
 *  3. Wrap the client socket in a TLS server socket.
 *  4. Parse the decrypted HTTP request(s).
 *  5. Route through resolveProxyRequest() — return mock or forward upstream.
 */

import * as net from 'net';
import * as tls from 'tls';
import { CertCache } from './cert-cache';
import { resolveProxyRequest, type ProxyIncomingRequest } from './proxy-handler';
import { getActiveProject } from './projects';
import { isHostIntercepted } from './intercept';
import { getLocalIPAddresses } from './network';

export interface ProxyServerOptions {
  port: number;
  caCert: string;
  caKey: string;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Parse a raw HTTP request buffer into method, path, headers, and body.
 */
function parseHttpRequest(data: Buffer): ProxyIncomingRequest | null {
  const str = data.toString('utf-8');
  const headerEndIndex = str.indexOf('\r\n\r\n');
  if (headerEndIndex === -1) return null;

  const headerSection = str.slice(0, headerEndIndex);
  const bodySection = data.slice(headerEndIndex + 4);

  const lines = headerSection.split('\r\n');
  const requestLine = lines[0];
  if (!requestLine) return null;

  const parts = requestLine.split(' ');
  if (parts.length < 2) return null;

  const method = parts[0];
  let rawPath = parts[1];
  let hostFromRequestLine: string | undefined;

  // For proxy requests the path may be a full URL — extract just the path
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    try {
      const url = new URL(rawPath);
      hostFromRequestLine = url.host;
      rawPath = url.pathname + url.search;
    } catch {
      // keep as-is
    }
  }

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIndex = lines[i].indexOf(':');
    if (colonIndex > 0) {
      const key = lines[i].slice(0, colonIndex).trim().toLowerCase();
      const value = lines[i].slice(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  // Some clients may omit Host when using absolute-form request targets.
  if (!headers['host'] && hostFromRequestLine) {
    headers['host'] = hostFromRequestLine;
  }

  return {
    method,
    path: rawPath,
    headers,
    body: bodySection.length > 0 ? bodySection : undefined,
  };
}

/**
 * Serialize an HTTP response into a raw buffer suitable for writing to a socket.
 */
function serializeHttpResponse(
  statusCode: number,
  headers: Record<string, string>,
  body: Buffer,
): Buffer {
  const statusText = httpStatusText(statusCode);
  let head = `HTTP/1.1 ${statusCode} ${statusText}\r\n`;

  // Ensure content-length is set
  headers['content-length'] = String(body.length);

  for (const [key, value] of Object.entries(headers)) {
    head += `${key}: ${value}\r\n`;
  }
  head += '\r\n';

  return Buffer.concat([Buffer.from(head, 'utf-8'), body]);
}

function httpStatusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return map[code] || 'Unknown';
}

function serializeJson(statusCode: number, payload: any): Buffer {
  return serializeHttpResponse(
    statusCode,
    {
      'content-type': 'application/json',
      connection: 'close',
    },
    Buffer.from(JSON.stringify(payload)),
  );
}

function parseHostHeader(hostHeader: string): { hostname: string; port?: number } | null {
  const raw = (hostHeader ?? '').trim();
  if (!raw) return null;

  // IPv6: "[::1]:8888"
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    const hostname = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest.startsWith(':')) {
      const p = rest.slice(1);
      const port = Number.parseInt(p, 10);
      if (Number.isFinite(port)) return { hostname, port };
    }
    return { hostname };
  }

  // IPv4/hostname: "example.com:80" (split on last colon)
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && idx < raw.length - 1) {
    const maybePort = raw.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) {
      const port = Number.parseInt(maybePort, 10);
      return { hostname: raw.slice(0, idx), port };
    }
  }

  return { hostname: raw };
}

function isLocalHost(hostname: string): boolean {
  const h = (hostname ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  const ips = getLocalIPAddresses().map(ip => ip.toLowerCase());
  return ips.includes(h);
}

const EXCLUDED_PROXY_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

const PLAIN_HTTP_FORWARD_TIMEOUT_MS = 30_000;

function extractErrnoCode(err: unknown): string | undefined {
  const anyErr = err as any;
  const code = anyErr?.code ?? anyErr?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

function extractErrMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

async function readFullHttpRequest(
  clientSocket: net.Socket,
  initial: Buffer,
): Promise<Buffer | null> {
  let buffer = initial;

  const headerEnd = () => buffer.indexOf('\r\n\r\n');
  const getTotalExpected = (): number | null => {
    const end = headerEnd();
    if (end === -1) return null;
    const headerStr = buffer.slice(0, end).toString('utf-8');
    const m = headerStr.match(/content-length:\s*(\d+)/i);
    const contentLength = m ? Number.parseInt(m[1], 10) : 0;
    return end + 4 + (Number.isFinite(contentLength) ? contentLength : 0);
  };

  const expected0 = getTotalExpected();
  if (expected0 !== null && buffer.length >= expected0) {
    return buffer.slice(0, expected0);
  }

  return await new Promise<Buffer | null>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 10_000);

    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      const expected = getTotalExpected();
      if (expected !== null && buffer.length >= expected) {
        const out = buffer.slice(0, expected);
        cleanup();
        resolve(out);
      }
    }

    function onEnd() {
      cleanup();
      resolve(null);
    }

    function onError() {
      cleanup();
      resolve(null);
    }

    function cleanup() {
      clearTimeout(timeout);
      clientSocket.off('data', onData);
      clientSocket.off('end', onEnd);
      clientSocket.off('error', onError);
    }

    clientSocket.on('data', onData);
    clientSocket.once('end', onEnd);
    clientSocket.once('error', onError);
  });
}

// ─── Domain matching ─────────────────────────────────────────────────────────

/**
 * Check if the given hostname matches the active project's baseUrl domain.
 */
function shouldIntercept(hostname: string): boolean {
  const project = getActiveProject();
  if (!project) return false;
  return isHostIntercepted(project, hostname);
}

// ─── Proxy server ────────────────────────────────────────────────────────────

/**
 * Create and start the HTTP proxy server.
 * Returns the net.Server instance and a close() helper.
 */
export async function createProxyServer(options: ProxyServerOptions): Promise<{
  server: net.Server;
  close: () => Promise<void>;
}> {
  const certCache = new CertCache({
    maxSize: 100,
    caCert: options.caCert,
    caKey: options.caKey,
  });

  const server = net.createServer((clientSocket) => {
    clientSocket.once('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET / EPIPE are normal — clients often close connections abruptly
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
      console.error('[Proxy] Client socket error:', err.message);
    });

    // Read the first chunk to determine request type
    clientSocket.once('data', (firstChunk) => {
      const firstLine = firstChunk.toString('utf-8').split('\r\n')[0];

      if (firstLine.startsWith('CONNECT ')) {
        handleConnect(clientSocket, firstLine, firstChunk, certCache);
      } else {
        handleHttpProxy(clientSocket, firstChunk, options.port);
      }
    });
  });

  server.on('error', (err) => {
    console.error('[Proxy] Server error:', err.message);
  });

  // Start listening and wait until ready
  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, () => {
      console.log(`[Proxy] HTTP proxy listening on port ${options.port}`);
      resolve();
    });
    server.once('error', reject);
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return { server, close };
}

// ─── CONNECT handler (HTTPS) ─────────────────────────────────────────────────

function handleConnect(
  clientSocket: net.Socket,
  connectLine: string,
  _rawChunk: Buffer,
  certCache: CertCache,
): void {
  // Parse "CONNECT hostname:port HTTP/1.1"
  const parts = connectLine.split(' ');
  const target = parts[1]; // e.g. "example.com:443"
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const [hostname, portStr] = target.split(':');
  const port = parseInt(portStr || '443', 10);

  if (!shouldIntercept(hostname)) {
    // Blind tunnel — connect to real server and pipe both directions
    blindTunnel(clientSocket, hostname, port);
    return;
  }

  // MITM — intercept the TLS connection
  console.log(`[Proxy] MITM intercept: ${hostname}`);

  // Tell the client the tunnel is established
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Generate a TLS cert for this domain
  const certData = certCache.getCert(hostname);

  // Create a TLS server socket over the existing client connection.
  // - ALPNProtocols: advertise only HTTP/1.1 so iOS/Android apps don't try h2
  //   (our parser only speaks HTTP/1.1).
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: certData.privateKey,
    cert: certData.cert,
    ALPNProtocols: ['http/1.1'],
  });

  tlsSocket.on('error', (err: NodeJS.ErrnoException) => {
    const code = err.code ?? (err as any).cause?.code;
    // ECONNRESET during TLS almost always means the client aborted the
    // handshake — most commonly because the CA certificate is not trusted.
    if (code === 'ECONNRESET') {
      console.warn(
        `[Proxy] TLS handshake aborted by client for ${hostname} — ` +
        `device may not trust the MockMate CA. ` +
        `Visit http://<server-ip>:3456/setup to install the certificate.`,
      );
      tlsSocket.destroy();
      return;
    }
    if (code === 'EPIPE') {
      tlsSocket.destroy();
      return;
    }
    console.error(`[Proxy] TLS error (${hostname}): [${code ?? 'unknown'}] ${err.message}`);
    tlsSocket.destroy();
  });

  // Log when TLS handshake succeeds so we can distinguish "cert not trusted"
  // from "request never came".  ('secureConnect' fires on TLSSocket instances;
  // 'secureConnection' is only on tls.Server.)
  tlsSocket.once('secureConnect', () => {
    const proto = tlsSocket.alpnProtocol || 'none';
    console.log(`[Proxy] TLS handshake OK: ${hostname} (ALPN: ${proto})`);
  });

  // ── Serialised request processing ───────────────────────────────────────────
  // The data handler MUST NOT be async directly: if it awaits (e.g. during
  // upstream forwarding) Node fires more data events before the handler
  // returns, causing concurrent mutations of the shared buffer and
  // out-of-order / missing responses.
  //
  // Fix: accumulate raw bytes synchronously, then process requests one at a
  // time through a promise chain (processingChain) that never runs two
  // requests concurrently.

  let buffer = Buffer.alloc(0);
  // Each link in the chain is a fully-serialised drain of `buffer`.
  let processingChain: Promise<void> = Promise.resolve();

  /**
   * Process as many complete HTTP/1.1 requests as are currently buffered,
   * writing one response per request in order before moving to the next.
   */
  async function drainBuffer(): Promise<void> {
    while (true) {
      // ── Find end of HTTP headers ───────────────────────────────────────
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // Headers not fully received yet

      // ── Determine full request length ──────────────────────────────────
      const headerStr = buffer.slice(0, headerEnd).toString('utf-8');
      const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
      const totalExpected = headerEnd + 4 + (Number.isFinite(contentLength) ? contentLength : 0);

      if (buffer.length < totalExpected) return; // Body not fully received yet

      // ── Extract exactly one request and advance the buffer ─────────────
      const requestData = buffer.slice(0, totalExpected);
      buffer = buffer.slice(totalExpected);

      // ── Parse ──────────────────────────────────────────────────────────
      const parsed = parseHttpRequest(requestData);
      if (!parsed) {
        console.warn(`[Proxy] Failed to parse HTTP request from ${hostname} — sending 400`);
        tlsSocket.write(serializeHttpResponse(
          400, { 'content-type': 'application/json' },
          Buffer.from(JSON.stringify({ error: 'Bad Request', message: 'Could not parse HTTP request' })),
        ));
        continue;
      }

      if (!parsed.headers['host']) {
        parsed.headers['host'] = hostname;
      }

      // ── Resolve (mock or forward) ──────────────────────────────────────
      try {
        const result = await resolveProxyRequest(parsed, hostname, { scheme: 'https', port });

        if (result) {
          tlsSocket.write(serializeHttpResponse(result.statusCode, result.headers, result.body));
        } else {
          // Shouldn't happen (we checked shouldIntercept above), but guard anyway.
          console.warn(`[Proxy] resolveProxyRequest returned null for ${hostname}${parsed.path}`);
          tlsSocket.write(serializeHttpResponse(
            502, { 'content-type': 'application/json' },
            Buffer.from(JSON.stringify({ error: 'No active project matched this host' })),
          ));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Proxy] Error handling ${parsed.method} ${hostname}${parsed.path}: ${msg}`);
        tlsSocket.write(serializeHttpResponse(
          500, { 'content-type': 'application/json' },
          Buffer.from(JSON.stringify({ error: 'Internal proxy error', message: msg })),
        ));
      }
    }
  }

  // Synchronously append incoming bytes, then schedule a serialised drain.
  tlsSocket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Chain each drain so they execute sequentially, never concurrently.
    processingChain = processingChain.then(() => drainBuffer()).catch(() => {});
  });

  tlsSocket.on('end', () => {
    tlsSocket.destroy();
  });
}

// ─── Blind tunnel (non-intercepted HTTPS) ────────────────────────────────────

function blindTunnel(
  clientSocket: net.Socket,
  hostname: string,
  port: number,
): void {
  const upstream = net.createConnection(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      clientSocket.destroy();
      return;
    }
    console.error(`[Proxy] Tunnel error to ${hostname}:${port}:`, err.message);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });

  clientSocket.on('error', () => {
    upstream.destroy();
  });

  clientSocket.on('end', () => {
    upstream.end();
  });
}

// ─── Plain HTTP proxy ────────────────────────────────────────────────────────

async function handleHttpProxy(
  clientSocket: net.Socket,
  rawChunk: Buffer,
  proxyPort: number,
): Promise<void> {
  const full = await readFullHttpRequest(clientSocket, rawChunk);
  if (!full) {
    clientSocket.end(serializeJson(408, {
      error: 'Request Timeout',
      message: 'Timed out while reading the HTTP request through the proxy',
    }));
    return;
  }

  const parsed = parseHttpRequest(full);
  if (!parsed) {
    clientSocket.end(serializeJson(400, { error: 'Bad Request' }));
    return;
  }

  const host = parsed.headers['host'];
  if (!host) {
    clientSocket.end(serializeJson(400, { error: 'Bad Request', message: 'Missing Host header' }));
    return;
  }

  const hostInfo = parseHostHeader(host);
  if (!hostInfo) {
    clientSocket.end(serializeJson(400, { error: 'Bad Request', message: 'Invalid Host header' }));
    return;
  }

  const hostname = hostInfo.hostname;
  const port = hostInfo.port ?? 80;

  // ── MockMate control API bypass ───────────────────────────────────────────
  // The iOS Test Runner (XCTRunner) can't make direct connections to local IPs
  // (blocked by iOS Local Network privacy). Instead, tests use the fake hostname
  // "mockmate.test" which routes through the system proxy (this server on :8888)
  // to avoid the restriction. We intercept it here and forward to our own HTTP
  // server at localhost:3456.
  if (hostname === 'mockmate.test') {
    const httpApiPort = proxyPort > 1000 ? 3456 : 3456; // always 3456 for now
    const internalUrl = `http://127.0.0.1:${httpApiPort}${parsed.path}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8_000);
      const resp = await fetch(internalUrl, {
        method: parsed.method,
        headers: { 'content-type': parsed.headers['content-type'] ?? 'application/json' },
        body: parsed.body,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = Buffer.from(await resp.arrayBuffer());
      const hdrs: Record<string, string> = {};
      resp.headers.forEach((v, k) => { hdrs[k] = v; });
      clientSocket.end(serializeHttpResponse(resp.status, hdrs, body));
    } catch (err) {
      clientSocket.end(serializeJson(502, { error: 'MockMate internal routing error', message: String(err) }));
    }
    return;
  }

  // Guard against accidental loops (calling the proxy port directly).
  if (port === proxyPort && isLocalHost(hostname)) {
    clientSocket.end(serializeJson(400, {
      error: 'Bad Request',
      message: 'This port is the MockMate HTTP proxy. Call the API server on :3456 (HTTP) or :3457 (HTTPS) instead.',
      hint: {
        correctEndpoints: [
          'http://<host>:3456/setMockServerflags',
          'https://<host>:3457/setMockServerflags',
        ],
      },
    }));
    return;
  }

  try {
    const result = await resolveProxyRequest(parsed, hostname, { scheme: 'http', port });

    if (result) {
      const raw = serializeHttpResponse(result.statusCode, result.headers, result.body);
      clientSocket.end(raw);
    } else {
      // Not our domain — forward as plain HTTP proxy
      const targetUrl = `http://${host}${parsed.path}`;

      const forwardHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.headers)) {
        if (!v) continue;
        if (EXCLUDED_PROXY_REQUEST_HEADERS.has(k.toLowerCase())) continue;
        forwardHeaders[k] = v;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PLAIN_HTTP_FORWARD_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(targetUrl, {
          method: parsed.method,
          headers: forwardHeaders,
          body: parsed.body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const body = Buffer.from(await response.arrayBuffer());
      const raw = serializeHttpResponse(response.status, responseHeaders, body);
      clientSocket.end(raw);
    }
  } catch (err) {
    const code = extractErrnoCode(err);
    const msg = extractErrMessage(err);

    // These are common when clients cancel requests or upstream closes early.
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      console.warn(`[Proxy] HTTP proxy upstream closed connection (${code})`);
    } else if (msg === 'fetch failed') {
      console.warn('[Proxy] HTTP proxy fetch failed');
    } else {
      console.error('[Proxy] HTTP proxy error:', msg);
    }

    clientSocket.end(serializeJson(502, {
      error: 'Bad Gateway',
      message: 'Failed to proxy the upstream HTTP request',
      code,
    }));
  }
}
