import * as net from 'node:net';
import { performance } from 'node:perf_hooks';
import * as tls from 'node:tls';
import { Duplex } from 'node:stream';

export interface ProxyTestResponse {
  statusCode: number;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
  body: Buffer;
  firstByteAt: number;
  completedAt: number;
}

export interface PlainProxyTarget {
  requestTarget: string;
  method?: string;
  headers?: Array<[string, string]>;
  bodyChunks?: Buffer[];
  onFirstByte?(at: number): void;
}

export interface TlsProxyTarget {
  connectAuthority: string;
  connectHeaders?: Array<[string, string]>;
  servername: string;
  ca: string | Buffer | readonly (string | Buffer)[];
  path?: string;
  method?: string;
  innerHeaders?: Array<[string, string]>;
  bodyChunks?: Buffer[];
  onFirstByte?(at: number): void;
}

function withDefaultHost(
  headers: Array<[string, string]> | undefined,
  authority: string | undefined,
): Array<[string, string]> {
  const exact = headers === undefined ? [] : [...headers];
  if (authority !== undefined && !exact.some(([name]) => name.toLowerCase() === 'host')) {
    exact.push(['Host', authority]);
  }
  return exact;
}

function absoluteAuthority(requestTarget: string): string | undefined {
  try {
    const parsed = new URL(requestTarget);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

export function readProxyResponse(
  socket: net.Socket | tls.TLSSocket,
  onFirstByte?: (at: number) => void,
): Promise<ProxyTestResponse> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let statusCode: number | undefined;
    let headers: Record<string, string> | undefined;
    let rawHeaders: Array<[string, string]> | undefined;
    let bodyStart = -1;
    let expectedBodyBytes: number | undefined;
    let chunked = false;
    let firstByteAt: number | undefined;
    const timeout = setTimeout(() => finish(new Error('Timed out reading proxy response')), 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const finish = (error?: Error, response?: ProxyTestResponse) => {
      cleanup();
      if (error) reject(error);
      else resolve(response!);
    };
    const parseHeader = (): void => {
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const lines = received.subarray(0, headerEnd).toString('utf8').split('\r\n');
      statusCode = Number(lines[0]?.split(' ')[1]);
      headers = {};
      rawHeaders = [];
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':');
        if (separator > 0) {
          const name = line.slice(0, separator);
          const value = line.slice(separator + 1).trim();
          rawHeaders.push([name, value]);
          headers[name.toLowerCase()] = value;
        }
      }
      bodyStart = headerEnd + 4;
      expectedBodyBytes = headers['content-length'] === undefined
        ? undefined
        : Number(headers['content-length']);
      chunked = headers['transfer-encoding']?.toLowerCase().split(',').map(value => value.trim())
        .includes('chunked') ?? false;
    };
    const decodedChunkedBody = (): Buffer | undefined => {
      let offset = bodyStart;
      const chunks: Buffer[] = [];
      while (offset >= 0) {
        const lineEnd = received.indexOf('\r\n', offset);
        if (lineEnd < 0) return undefined;
        const size = Number.parseInt(received.subarray(offset, lineEnd).toString('ascii').split(';')[0], 16);
        if (!Number.isFinite(size)) return undefined;
        offset = lineEnd + 2;
        if (size === 0) {
          const trailerEnd = received.indexOf('\r\n\r\n', offset);
          if (trailerEnd < 0 && received.subarray(offset, offset + 2).toString() !== '\r\n') return undefined;
          return Buffer.concat(chunks);
        }
        if (received.length < offset + size + 2) return undefined;
        chunks.push(received.subarray(offset, offset + size));
        offset += size + 2;
      }
      return undefined;
    };
    const completed = (): ProxyTestResponse | undefined => {
      if (statusCode === undefined || !headers || !rawHeaders || bodyStart < 0) return undefined;
      let body: Buffer;
      if (chunked) {
        const decoded = decodedChunkedBody();
        if (decoded === undefined) return undefined;
        body = decoded;
      } else if (expectedBodyBytes !== undefined) {
        if (received.length - bodyStart < expectedBodyBytes) return undefined;
        body = received.subarray(bodyStart, bodyStart + expectedBodyBytes);
      } else if (headers.connection?.toLowerCase() === 'close') {
        return undefined;
      } else {
        body = Buffer.alloc(0);
      }
      return {
        statusCode,
        headers,
        rawHeaders,
        body,
        firstByteAt: firstByteAt!,
        completedAt: performance.now(),
      };
    };
    const onData = (chunk: Buffer) => {
      if (firstByteAt === undefined) {
        firstByteAt = performance.now();
        onFirstByte?.(firstByteAt);
      }
      received = Buffer.concat([received, chunk]);
      if (statusCode === undefined) parseHeader();
      const response = completed();
      if (response) finish(undefined, response);
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => {
      const response = completed();
      if (response) finish(undefined, response);
      else if (statusCode !== undefined && headers && rawHeaders && bodyStart >= 0
        && expectedBodyBytes === undefined && !chunked) {
        finish(undefined, {
          statusCode,
          headers,
          rawHeaders,
          body: received.subarray(bodyStart),
          firstByteAt: firstByteAt!,
          completedAt: performance.now(),
        });
      } else {
        finish(new Error(
          `Proxy closed before a complete response (status=${statusCode ?? 'none'}, `
          + `expected=${expectedBodyBytes ?? (chunked ? 'chunked' : 'unknown')}, `
          + `received=${bodyStart < 0 ? 0 : received.length - bodyStart})`,
        ));
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

export function connectProxySocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export async function requestPlainProxy(
  port: number,
  target: PlainProxyTarget | { host: string; path?: string; method?: string },
): Promise<ProxyTestResponse> {
  const socket = await connectProxySocket(port);
  const exact: PlainProxyTarget = 'requestTarget' in target
    ? target
    : {
        requestTarget: `http://${target.host}${target.path ?? '/'}`,
        method: target.method,
        headers: [['Host', target.host], ['Connection', 'close']] as Array<[string, string]>,
      };
  const response = readProxyResponse(socket, exact.onFirstByte);
  socket.write(`${exact.method ?? 'GET'} ${exact.requestTarget} HTTP/1.1\r\n`);
  const headers = withDefaultHost(exact.headers, absoluteAuthority(exact.requestTarget));
  for (const [name, value] of headers) socket.write(`${name}: ${value}\r\n`);
  socket.write('\r\n');
  for (const chunk of exact.bodyChunks ?? []) socket.write(chunk);
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

export async function requestConnectProxy(port: number, target: string): Promise<ProxyTestResponse> {
  const socket = await connectProxySocket(port);
  const response = readProxyResponse(socket);
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  try {
    return await response;
  } finally {
    socket.destroy();
  }
}

export async function requestTlsProxy(
  port: number,
  target: TlsProxyTarget | {
    host: string;
    ca: string | Buffer | readonly (string | Buffer)[];
    targetPort?: number;
    path?: string;
    method?: string;
  },
): Promise<ProxyTestResponse> {
  const exact: TlsProxyTarget = 'connectAuthority' in target
    ? target
    : {
        connectAuthority: target.targetPort === undefined || target.targetPort === 443
          ? target.host
          : `${target.host}:${target.targetPort}`,
        servername: target.host,
        ca: target.ca,
        path: target.path,
        method: target.method,
      };
  const secureSocket = await openExactTlsProxyConnection(port, exact);
  const response = readProxyResponse(secureSocket, exact.onFirstByte);
  const innerHeaders = withDefaultHost(exact.innerHeaders, exact.connectAuthority);
  secureSocket.write(`${exact.method ?? 'GET'} ${exact.path ?? '/'} HTTP/1.1\r\n`);
  for (const [name, value] of innerHeaders) secureSocket.write(`${name}: ${value}\r\n`);
  secureSocket.write('\r\n');
  for (const chunk of exact.bodyChunks ?? []) secureSocket.write(chunk);
  try {
    return await response;
  } finally {
    secureSocket.destroy();
  }
}

async function openExactTlsProxyConnection(
  port: number,
  target: Pick<TlsProxyTarget, 'connectAuthority' | 'connectHeaders' | 'servername' | 'ca'>,
): Promise<tls.TLSSocket> {
  return openTlsProxyConnectionWithExactConnectHead(port, target);
}

export async function openTlsProxyConnection(
  port: number,
  host: string,
  ca: string | Buffer,
  targetPort = 443,
): Promise<tls.TLSSocket> {
  const socket = await connectProxySocket(port);
  const established = readProxyResponse(socket);
  const authority = `${host}:${targetPort}`;
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const connectResponse = await established;
  if (connectResponse.statusCode !== 200) {
    socket.destroy();
    throw new Error(`CONNECT failed with status ${connectResponse.statusCode}`);
  }
  const secureSocket = tls.connect({ socket, servername: host, ca });
  await new Promise<void>((resolve, reject) => {
    secureSocket.once('secureConnect', resolve);
    secureSocket.once('error', reject);
  });
  return secureSocket;
}

export async function openTlsProxyConnectionWithConnectHead(
  port: number,
  host: string,
  ca: string | Buffer,
  targetPort = 443,
): Promise<tls.TLSSocket> {
  const authority = `${host}:${targetPort}`;
  return openTlsProxyConnectionWithExactConnectHead(port, {
    connectAuthority: authority,
    connectHeaders: [['Host', authority]],
    servername: host,
    ca,
  });
}

async function openTlsProxyConnectionWithExactConnectHead(
  port: number,
  target: Pick<TlsProxyTarget, 'connectAuthority' | 'connectHeaders' | 'servername' | 'ca'>,
): Promise<tls.TLSSocket> {
  const socket = await connectProxySocket(port);
  const pending: Buffer[] = [];
  const state: { target?: net.Socket } = {};
  let firstWrite!: () => void;
  const firstTlsBytes = new Promise<void>(resolve => { firstWrite = resolve; });
  const transport = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      if (!state.target) {
        pending.push(bytes);
        firstWrite();
        callback();
      } else if (state.target.write(bytes)) callback();
      else state.target.once('drain', callback);
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  const ca = typeof target.ca === 'string' || Buffer.isBuffer(target.ca)
    ? target.ca
    : [...target.ca];
  const secureSocket = tls.connect({ socket: transport, servername: target.servername, ca });
  await firstTlsBytes;
  await new Promise(resolve => setImmediate(resolve));
  const hello = Buffer.concat(pending);
  pending.length = 0;
  state.target = socket;

  let connectResponse = Buffer.alloc(0);
  let connected = false;
  socket.on('data', chunk => {
    if (connected) {
      transport.push(chunk);
      return;
    }
    connectResponse = Buffer.concat([connectResponse, chunk]);
    const headerEnd = connectResponse.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const statusCode = Number(connectResponse.subarray(0, headerEnd).toString().split(' ')[1]);
    if (statusCode !== 200) {
      secureSocket.destroy(new Error(`CONNECT failed with status ${statusCode}`));
      return;
    }
    connected = true;
    const remainder = connectResponse.subarray(headerEnd + 4);
    if (remainder.length > 0) transport.push(remainder);
  });
  socket.once('end', () => transport.push(null));
  socket.once('error', error => secureSocket.destroy(error));
  const connectHeaders = withDefaultHost(target.connectHeaders, target.connectAuthority);
  const connectHead = [
    `CONNECT ${target.connectAuthority} HTTP/1.1`,
    ...connectHeaders.map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n');
  socket.write(Buffer.concat([
    Buffer.from(connectHead),
    hello,
  ]));
  await new Promise<void>((resolve, reject) => {
    secureSocket.once('secureConnect', resolve);
    secureSocket.once('error', reject);
  });
  return secureSocket;
}
