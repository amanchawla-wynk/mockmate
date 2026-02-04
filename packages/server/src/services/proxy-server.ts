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

  // For proxy requests the path may be a full URL — extract just the path
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    try {
      const url = new URL(rawPath);
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
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return map[code] || 'Unknown';
}

// ─── Domain matching ─────────────────────────────────────────────────────────

/**
 * Check if the given hostname matches the active project's baseUrl domain.
 */
function shouldIntercept(hostname: string): boolean {
  const project = getActiveProject();
  if (!project || !project.baseUrl) return false;

  try {
    const projectHost = new URL(project.baseUrl).hostname;
    return projectHost === hostname;
  } catch {
    return false;
  }
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
        handleHttpProxy(clientSocket, firstChunk);
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

  // Create a TLS server socket over the existing client connection
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: certData.privateKey,
    cert: certData.cert,
  });

  tlsSocket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      tlsSocket.destroy();
      return;
    }
    console.error(`[Proxy] TLS error (${hostname}):`, err.message);
    tlsSocket.destroy();
  });

  // Buffer for accumulating data
  let buffer = Buffer.alloc(0);

  tlsSocket.on('data', async (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Try to parse a complete HTTP request
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return; // Need more data

    // Check Content-Length to know if we have the full body
    const headerStr = buffer.slice(0, headerEnd).toString('utf-8');
    const contentLengthMatch = headerStr.match(/content-length:\s*(\d+)/i);
    const contentLength = contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : 0;
    const totalExpected = headerEnd + 4 + contentLength;

    if (buffer.length < totalExpected) return; // Need more body data

    // Extract this request's data
    const requestData = buffer.slice(0, totalExpected);
    buffer = buffer.slice(totalExpected); // Keep any remaining data for next request

    const parsed = parseHttpRequest(requestData);
    if (!parsed) {
      const errResponse = serializeHttpResponse(400, { 'content-type': 'text/plain' }, Buffer.from('Bad Request'));
      tlsSocket.write(errResponse);
      return;
    }

    // Set host header if not already set
    if (!parsed.headers['host']) {
      parsed.headers['host'] = hostname;
    }

    try {
      const result = await resolveProxyRequest(parsed, hostname);

      if (result) {
        const raw = serializeHttpResponse(result.statusCode, result.headers, result.body);
        tlsSocket.write(raw);
      } else {
        // Shouldn't happen (we checked shouldIntercept), but forward just in case
        const fallback = serializeHttpResponse(
          502,
          { 'content-type': 'application/json' },
          Buffer.from(JSON.stringify({ error: 'No active project for this domain' })),
        );
        tlsSocket.write(fallback);
      }
    } catch (err) {
      console.error(`[Proxy] Error handling request for ${hostname}${parsed.path}:`, err);
      const errResponse = serializeHttpResponse(
        500,
        { 'content-type': 'application/json' },
        Buffer.from(JSON.stringify({ error: 'Internal proxy error' })),
      );
      tlsSocket.write(errResponse);
    }
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
): Promise<void> {
  const parsed = parseHttpRequest(rawChunk);
  if (!parsed) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const host = parsed.headers['host'];
  if (!host) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  // Extract just the hostname (strip port if present)
  const hostname = host.split(':')[0];

  try {
    const result = await resolveProxyRequest(parsed, hostname);

    if (result) {
      const raw = serializeHttpResponse(result.statusCode, result.headers, result.body);
      clientSocket.end(raw);
    } else {
      // Not our domain — forward as plain HTTP proxy
      const targetUrl = `http://${host}${parsed.path}`;
      const response = await fetch(targetUrl, {
        method: parsed.method,
        headers: parsed.headers,
        body: parsed.body,
        redirect: 'manual',
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const body = Buffer.from(await response.arrayBuffer());
      const raw = serializeHttpResponse(response.status, responseHeaders, body);
      clientSocket.end(raw);
    }
  } catch (err) {
    console.error('[Proxy] HTTP proxy error:', err);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  }
}
