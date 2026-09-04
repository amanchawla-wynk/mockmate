import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { pipeline } from 'node:stream/promises';
import * as tls from 'node:tls';

import type { ResponseHeaders } from '../domain/model';
import { projectRequestHeaders } from '../domain/http-metadata';
import { parseRawQuery } from '../domain/query-matcher';
import type { ProjectRepository } from '../repository/project-repository';
import { HttpError, serializeApiError } from './api-errors';
import { writeCanonicalErrorResponse } from './canonical-error-response';
import { CertCache } from './cert-cache';
import { createDeliveryCauseTracker, type DeliveryCauseTracker } from './delivery-cause';
import { getInterceptHostPatterns, hostMatchesPattern } from './intercept';
import { ObservedResponseTarget } from './observed-response-target';
import {
  resolveProxyRequest,
  type ProxyIncomingRequest,
  type ProxyRequestObservation,
  type ProxyRequestObservationTerminal,
} from './proxy-handler';
import {
  deriveConnectAuthority,
  derivePlainProxyAuthority,
  type RequestAuthority,
} from './request-authority';
import { outgoingHeaderTuples, writeResolvedResponse } from './response-writer';
import type { TrafficExchange } from '../domain/traffic';
import type { TrafficService } from './traffic-service';
import { debugHeaders } from './traffic-provenance';
import { currentTrafficAppState } from './traffic-evidence';
import {
  createNodeBlindTunnelConnector,
  createNodeUpstreamTransport,
  type BlindTunnelConnector,
  type HeaderTuple,
  type NodeUpstreamTransportOptions,
  type UpstreamTransport,
} from './upstream-transport';

interface BlindTunnelTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface BlindTunnelOptions {
  lookup?: net.LookupFunction;
  connector?: BlindTunnelConnector;
  timers?: BlindTunnelTimers;
}

export interface ProxyServerOptions {
  port: number;
  caCert: string;
  caKey: string;
  repository: ProjectRepository;
  traffic: TrafficService;
  upstreamTransport?: UpstreamTransport;
  blindTunnelConnector?: BlindTunnelConnector;
  upstream?: NodeUpstreamTransportOptions;
  blindTunnel?: BlindTunnelOptions;
  startWithAdmissionsClosed?: boolean;
  onAdmissionHeld?(): void;
}

const BLIND_TUNNEL_CONNECT_TIMEOUT_MS = 30_000;

const systemBlindTunnelTimers: BlindTunnelTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

function noActiveProject(): HttpError {
  return new HttpError(503, 'NO_ACTIVE_PROJECT', 'No active Project is selected');
}

function headerValues(
  tuples: ReadonlyArray<readonly [string, string]>,
  expected: string,
): string[] {
  return tuples
    .filter(([name]) => name.toLowerCase() === expected)
    .map(([, value]) => value);
}

function pathAndQuery(rawRequestTarget: string): { path: string; rawQuery: string } {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(rawRequestTarget);
  let target = absolute ? absolute[1] : rawRequestTarget;
  if (!target) target = '/';
  if (target.startsWith('?')) target = `/${target}`;
  const queryIndex = target.indexOf('?');
  return {
    path: queryIndex < 0 ? target : target.slice(0, queryIndex),
    rawQuery: queryIndex < 0 ? '' : target.slice(queryIndex + 1),
  };
}

function selectedPattern(
  repository: ProjectRepository,
  projectId: string,
  hostname: string,
): string | undefined {
  return getInterceptHostPatterns(repository.getRuntimeSettings(projectId))
    .find(pattern => hostMatchesPattern(pattern, hostname));
}

function requestCloses(request: http.IncomingMessage): boolean {
  const tokens = request.headers.connection?.split(',').map(value => value.trim().toLowerCase()) ?? [];
  return tokens.includes('close')
    || (request.httpVersionMajor === 1 && request.httpVersionMinor === 0 && !tokens.includes('keep-alive'));
}

function configuredResponseCloses(headers: ResponseHeaders): boolean {
  const connection = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'connection')?.[1];
  const values = Array.isArray(connection) ? connection : connection === undefined ? [] : [connection];
  return values.some(value => value.split(',').some(token => token.trim().toLowerCase() === 'close'));
}

function writeSocketError(
  socket: net.Socket,
  error: unknown,
  destroyAfterWrite = false,
): Promise<void> {
  const requestId = randomUUID();
  const serialized = serializeApiError(error, requestId);
  const body = Buffer.from(JSON.stringify(serialized.body));
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off('error', finish);
      socket.off('close', finish);
      resolve();
    };
    socket.once('error', finish);
    socket.once('close', finish);
    socket.end([
      `HTTP/1.1 ${serialized.status} Error`,
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      `X-Request-Id: ${requestId}`,
      'Connection: close',
      '',
      body.toString(),
    ].join('\r\n'), () => {
      if (destroyAfterWrite && !socket.destroyed) socket.destroy();
      finish();
    });
  });
}

function upstreamConnectionError(error: unknown): HttpError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
  return code === 'UPSTREAM_TIMEOUT'
    ? new HttpError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out')
    : new HttpError(502, 'UPSTREAM_FAILURE', 'Upstream request failed');
}

function tunnelTimeoutError(): Error & { code: string } {
  return Object.assign(new Error('Upstream connection timed out'), { code: 'UPSTREAM_TIMEOUT' });
}

async function ownBlindTunnel(input: {
  client: net.Socket;
  authority: RequestAuthority;
  head: Buffer;
  connector: BlindTunnelConnector;
  timers: BlindTunnelTimers;
  sockets: Set<net.Socket>;
}): Promise<void> {
  const controller = new AbortController();
  let upstream: net.Socket | undefined;
  let connectSettled = false;
  let established = false;
  let timedOut = false;
  let clientClosed = false;
  let upstreamClosed = false;
  let rejectClientFailure!: (error: Error) => void;
  let rejectUpstreamFailure!: (error: Error) => void;
  let rejectTimeout!: (error: Error) => void;

  const releaseIfClosed = () => {
    if (!clientClosed || (upstream !== undefined && !upstreamClosed)) return;
    input.client.off('error', onClientError);
    input.client.off('close', onClientClose);
    upstream?.off('error', onUpstreamError);
    upstream?.off('close', onUpstreamClose);
  };
  const destroyPair = () => {
    controller.abort();
    if (!input.client.destroyed) input.client.destroy();
    if (upstream && !upstream.destroyed) upstream.destroy();
  };
  const onClientError = (error: Error) => {
    if (!established) rejectClientFailure(error);
    destroyPair();
  };
  const onClientClose = () => {
    clientClosed = true;
    if (!established) {
      rejectClientFailure(Object.assign(new Error('Proxy client disconnected'), { code: 'ABORT_ERR' }));
    }
    controller.abort();
    if (upstream && !upstream.destroyed) upstream.destroy();
    releaseIfClosed();
  };
  const onUpstreamError = (error: Error) => {
    if (!established) {
      if (!timedOut) rejectUpstreamFailure(error);
      controller.abort();
      if (upstream && !upstream.destroyed) upstream.destroy();
      return;
    }
    destroyPair();
  };
  const onUpstreamClose = () => {
    upstreamClosed = true;
    if (upstream) input.sockets.delete(upstream);
    if (!established) {
      if (!timedOut) rejectUpstreamFailure(new Error('Upstream tunnel closed before establishment'));
    } else if (!input.client.destroyed) input.client.destroy();
    releaseIfClosed();
  };
  input.client.on('error', onClientError);
  input.client.on('close', onClientClose);

  const clientFailure = new Promise<never>((_resolve, reject) => { rejectClientFailure = reject; });
  const upstreamFailure = new Promise<never>((_resolve, reject) => { rejectUpstreamFailure = reject; });
  const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timeout = input.timers.setTimeout(() => {
    timedOut = true;
    rejectTimeout(tunnelTimeoutError());
    controller.abort();
  }, BLIND_TUNNEL_CONNECT_TIMEOUT_MS);
  const claim = (socket: net.Socket) => {
    if (upstream || connectSettled || timedOut || clientClosed) {
      const consumeError = () => {};
      socket.once('error', consumeError);
      socket.once('close', () => socket.off('error', consumeError));
      socket.destroy();
      return;
    }
    upstream = socket;
    input.sockets.add(socket);
    socket.on('error', onUpstreamError);
    socket.on('close', onUpstreamClose);
  };
  const connecting = Promise.resolve()
    .then(() => input.connector.connect(input.authority, controller.signal, claim));

  try {
    await Promise.race([connecting, clientFailure, upstreamFailure, deadline]);
    if (!upstream || upstream.destroyed) throw new Error('Blind connector completed without an active socket');
  } finally {
    connectSettled = true;
    input.timers.clearTimeout(timeout);
    releaseIfClosed();
  }
  const tunnel = upstream;

  if (clientClosed || input.client.destroyed || tunnel.destroyed) {
    destroyPair();
    return;
  }

  input.client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  established = true;
  if (input.head.length > 0 && !tunnel.write(input.head)) {
    await new Promise<void>(resolve => {
      const finish = () => {
        tunnel.off('drain', finish);
        tunnel.off('close', finish);
        resolve();
      };
      tunnel.once('drain', finish);
      tunnel.once('close', finish);
    });
  }
  if (input.client.destroyed || tunnel.destroyed) return;
  tunnel.pipe(input.client);
  input.client.pipe(tunnel);
}

async function writeMockResponse(
  response: http.ServerResponse,
  repository: ProjectRepository,
  result: Extract<Awaited<ReturnType<typeof resolveProxyRequest>>, { proxied: false }>,
  requestId: string,
  forceClose: boolean,
  deliveryCause: DeliveryCauseTracker,
  observeBytes: (bytes: number) => void,
  requestMethod: string,
): Promise<number> {
  const target = new ObservedResponseTarget(response, deliveryCause, {
    forceClose,
    onHead: status => result.traffic.setResponse(status, outgoingHeaderTuples(response.getHeaders())),
    onChunk: chunk => {
      observeBytes(chunk.length);
      result.traffic.observeResponse(chunk);
    },
  });
  target.setHeader('X-Request-Id', requestId);
  const settings = repository.getRuntimeSettings(result.resolved.projectId);
  for (const [name, value] of Object.entries(debugHeaders(result.resolved, {
    enabled: settings.debugProvenanceHeaders,
    projectId: result.resolved.projectId,
    requestId,
  }))) target.setHeader(name, value);
  const bodies = {
    getBody: repository.getBody.bind(repository),
    openBody: (...arguments_: Parameters<ProjectRepository['openBody']>) => {
      const source = repository.openBody(...arguments_);
      const consumeCleanupError = () => undefined;
      source.on('error', consumeCleanupError);
      source.once('close', () => {
        setImmediate(() => source.off('error', consumeCleanupError));
      });
      return source;
    },
  };
  return writeResolvedResponse(target, result.resolved, bodies, requestMethod);
}

async function writeUpstreamResponse(
  response: http.ServerResponse,
  request: http.IncomingMessage,
  result: Extract<Awaited<ReturnType<typeof resolveProxyRequest>>, { proxied: true }>,
  requestId: string,
  deliveryCause: DeliveryCauseTracker,
  observeBytes: (bytes: number) => void,
): Promise<number> {
  const closes = result.closeConnection || requestCloses(request);
  if (closes) response.shouldKeepAlive = false;
  const headers = result.headers.flatMap(([name, value]) => [name, value]);
  headers.push('X-Request-Id', requestId);
  if (closes) headers.push('Connection', 'close');
  const deliveredHeaders: HeaderTuple[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    deliveredHeaders.push([headers[index]!, headers[index + 1]!]);
  }
  result.traffic?.setResponse(result.statusCode, deliveredHeaders);
  response.writeHead(result.statusCode, headers);
  const markSourceFailure = () => deliveryCause.markFailure();
  result.body.once('error', markSourceFailure);
  const target = new ObservedResponseTarget(response, deliveryCause, {
    onChunk: chunk => {
      observeBytes(chunk.length);
      result.traffic?.observeResponse(chunk);
    },
  });
  try {
    await pipeline(result.body, target);
  } finally {
    result.body.off('error', markSourceFailure);
  }
  if (closes && !request.complete && !request.socket.destroyed) request.socket.destroy();
  return target.responseBytes;
}

function requestEnvelope(
  request: http.IncomingMessage,
  transport: ProxyIncomingRequest['transport'],
  signal: AbortSignal,
): ProxyIncomingRequest {
  const rawRequestTarget = request.url ?? '';
  const headers = projectRequestHeaders(request.rawHeaders);
  return {
    transport,
    method: request.method ?? 'GET',
    ...pathAndQuery(rawRequestTarget),
    rawRequestTarget,
    httpVersion: `HTTP/${request.httpVersion}`,
    headers: headers.grouped,
    rawHeaders: headers.tuples,
    body: request,
    signal,
  };
}

function requestSignal(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  markCancelled: () => void,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const cancel = () => {
    markCancelled();
    controller.abort();
  };
  const socketClosed = () => {
    if (!request.complete) cancel();
  };
  const responseClosed = () => {
    if (!response.writableFinished) cancel();
  };
  request.once('aborted', cancel);
  request.socket.once('close', socketClosed);
  response.once('close', responseClosed);
  return {
    signal: controller.signal,
    cleanup() {
      request.off('aborted', cancel);
      request.socket.off('close', socketClosed);
      response.off('close', responseClosed);
    },
  };
}

export async function createProxyServer(options: ProxyServerOptions): Promise<{
  server: net.Server;
  markAdmissionsOpen: () => void;
  releaseHeldAdmissions: () => void;
  closeAdmissions: (error?: HttpError) => Promise<void>;
  close: () => Promise<void>;
}> {
  const certCache = new CertCache({ maxSize: 100, caCert: options.caCert, caKey: options.caKey });
  const upstreamTransport = options.upstreamTransport ?? createNodeUpstreamTransport(options.upstream);
  const blindConnector = options.blindTunnelConnector ?? options.blindTunnel?.connector
    ?? createNodeBlindTunnelConnector({ lookup: options.blindTunnel?.lookup });
  const blindTimers = options.blindTunnel?.timers ?? systemBlindTunnelTimers;
  const sockets = new Set<net.Socket>();
  const connectAuthorities = new WeakMap<net.Socket, RequestAuthority>();
  const requestQueues = new WeakMap<net.Socket, Promise<void>>();
  const closedAdmissions = new WeakSet<net.Socket>();
  let admissionState: 'holding' | 'open' | 'closed' = options.startWithAdmissionsClosed
    ? 'holding'
    : 'open';
  const heldRequests: Array<[http.IncomingMessage, http.ServerResponse]> = [];
  const heldConnects: Array<[http.IncomingMessage, net.Socket, Buffer]> = [];
  const trafficSettlements = new Set<Promise<void>>();
  const ownTrafficSettlement = (operation: Promise<void>) => {
    const settlement = operation.catch(() => undefined);
    trafficSettlements.add(settlement);
    void settlement.then(() => trafficSettlements.delete(settlement));
  };

  const handleParsedRequest = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    transport: ProxyIncomingRequest['transport'],
  ): Promise<void> => {
    if (response.destroyed || request.socket.destroyed || closedAdmissions.has(request.socket)) return;
    const requestId = randomUUID();
    let traffic: TrafficExchange | undefined;
    let projectId: string | undefined;
    let requestObservation: ProxyRequestObservation | undefined;
    let requestCompletion: Promise<void> | undefined;
    let responseBytes = 0;
    const observeResponseBytes = (bytes: number) => { responseBytes += bytes; };
    const deliveryCause = createDeliveryCauseTracker();
    const responseClosed = () => {
      if (!response.writableFinished) deliveryCause.markCancelled();
    };
    response.once('close', responseClosed);
    let requestCancellation: ReturnType<typeof requestSignal> | undefined;
    try {
      projectId = options.repository.getWorkspaceState().activeProjectId;
      if (!projectId) throw noActiveProject();
      const tuples = projectRequestHeaders(request.rawHeaders).tuples;
      const authority = transport === 'plain_http_proxy'
        ? derivePlainProxyAuthority({
          requestTarget: request.url ?? '',
          hostHeaders: headerValues(tuples, 'host'),
          listenerScheme: 'http',
        })
        : deriveConnectAuthority({
          connectAuthority: connectAuthorities.get(request.socket)?.rawAuthority ?? '',
          innerHostHeaders: headerValues(tuples, 'host'),
        });
      const pattern = selectedPattern(options.repository, projectId, authority.origin.hostname);
      requestCancellation = requestSignal(
        request,
        response,
        () => deliveryCause.markCancelled(),
      );
      const result = await resolveProxyRequest(
        options.repository,
        requestEnvelope(
          request,
          transport,
          requestCancellation.signal,
        ),
        {
          projectId,
          authority,
          ...(pattern === undefined ? {} : { matchedAllowlistPattern: pattern }),
          transport: upstreamTransport,
          traffic: options.traffic,
          requestId,
          onTraffic: exchange => { traffic = exchange; },
          onRequestObservation: observation => { requestObservation = observation; },
        },
      );
      if (result.proxied) {
        const responseBytes = await writeUpstreamResponse(
          response, request, result, requestId, deliveryCause, observeResponseBytes,
        );
        if (result.traffic !== undefined) {
          if ((result.closeConnection || requestCloses(request)) && !request.complete) {
            requestObservation?.cancel();
          }
          const requestTerminal: ProxyRequestObservationTerminal | undefined =
            await requestObservation?.terminal;
          if (requestTerminal?.kind === 'incomplete') {
            result.traffic.abandonRequest('stream_cancelled');
          }
          options.traffic.complete(result.traffic, {
            kind: 'response',
            status: result.statusCode,
            responseBytes,
            upstreamStatus: result.statusCode,
          });
        }
      }
      else {
        requestCompletion = (async () => {
          for await (const chunk of request) result.traffic.observeRequest(Buffer.from(chunk));
        })();
        const forceClose = requestCloses(request) || configuredResponseCloses(result.headers);
        if (forceClose) closedAdmissions.add(request.socket);
        const responseBytes = await writeMockResponse(
          response, options.repository, result, requestId, forceClose, deliveryCause,
          observeResponseBytes, request.method ?? 'GET',
        );
        await requestCompletion;
        options.traffic.complete(result.traffic, {
          kind: 'response', status: result.statusCode, responseBytes,
        });
      }
    } catch (error) {
      if (deliveryCause.cause === undefined) deliveryCause.markFailure();
      if (traffic === undefined && projectId !== undefined) {
        try {
          const tuples = projectRequestHeaders(request.rawHeaders).tuples;
          const trustedAuthority = transport === 'plain_http_proxy'
            ? derivePlainProxyAuthority({
              requestTarget: request.url ?? '',
              hostHeaders: [],
              listenerScheme: 'http',
            })
            : connectAuthorities.get(request.socket);
          const pattern = trustedAuthority === undefined
            ? undefined
            : selectedPattern(options.repository, projectId, trustedAuthority.origin.hostname);
          if (trustedAuthority !== undefined && pattern !== undefined) {
            const target = pathAndQuery(request.url ?? '');
            const state = currentTrafficAppState(options.repository, projectId);
            traffic = options.traffic.begin({
              projectId,
              requestId,
              transport,
              allowlistPattern: pattern,
              origin: trustedAuthority.origin,
              method: request.method ?? 'GET',
              path: target.path,
              query: parseRawQuery(target.rawQuery),
              headers: tuples,
              appState: state,
            });
            traffic.setDecision({
              decision: 'failure',
              reason: 'Proxy authority validation failed',
              appState: state,
            });
          }
        } catch {
          // Failure observation cannot replace the initiating authority error.
        }
      }
      if (traffic !== undefined) {
        const activeTraffic = traffic;
        if (deliveryCause.cause === 'cancelled') {
          requestObservation?.cancel();
          activeTraffic.abandonRequest('stream_cancelled');
          if (!response.destroyed) response.destroy();
          const outcome = { kind: 'cancelled' as const, status: response.statusCode, responseBytes };
          ownTrafficSettlement((async () => {
            await requestObservation?.terminal;
            await requestCompletion?.catch(() => undefined);
            options.traffic.complete(activeTraffic, outcome);
          })());
        } else {
          if (!request.complete) activeTraffic.abandonRequest('body_unobservable');
          const headersAlreadySent = response.headersSent;
          const failure = await writeCanonicalErrorResponse(response, error, requestId, {
            closeConnection: true,
            onHead: (status, headers) => activeTraffic.setResponse(status, headers),
            onChunk: chunk => activeTraffic.observeResponse(chunk),
          });
          const outcome = {
            kind: 'failure',
            status: failure.status,
            responseBytes: headersAlreadySent ? responseBytes : failure.responseBytes,
            responseBodyComplete: !headersAlreadySent && failure.bodyComplete,
            failure: {
              code: failure.code,
              message: failure.message,
            },
          } as const;
          requestObservation?.cancel();
          ownTrafficSettlement((async () => {
            const requestTerminal: ProxyRequestObservationTerminal | undefined =
              await requestObservation?.terminal;
            await requestCompletion?.catch(() => undefined);
            if (requestTerminal?.kind === 'incomplete') activeTraffic.abandonRequest('body_unobservable');
            options.traffic.complete(activeTraffic, outcome);
          })());
        }
      } else if (deliveryCause.cause === 'cancelled') {
        if (!response.destroyed) response.destroy();
      } else {
        await writeCanonicalErrorResponse(response, error, requestId, { closeConnection: true });
      }
    } finally {
      requestCancellation?.cleanup();
      response.off('close', responseClosed);
    }
  };

  const enqueue = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    transport: ProxyIncomingRequest['transport'],
  ): void => {
    const socket = request.socket;
    const previous = requestQueues.get(socket) ?? Promise.resolve();
    const current = previous.then(() => handleParsedRequest(request, response, transport));
    const tail = current.catch(() => {});
    requestQueues.set(socket, tail);
    void tail.finally(() => {
      if (requestQueues.get(socket) === tail) requestQueues.delete(socket);
    });
  };

  const mitmServer = http.createServer((request, response) => {
    enqueue(request, response, 'https_mitm');
  });
  mitmServer.on('clientError', (_error, socket) => socket.destroy());

  const server = http.createServer();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  const handleConnect = (request: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    void (async () => {
      const client = clientSocket as net.Socket;
      try {
        const projectId = options.repository.getWorkspaceState().activeProjectId;
        if (!projectId) throw noActiveProject();
        const authority = deriveConnectAuthority({
          connectAuthority: request.url ?? '',
          innerHostHeaders: [],
        });
        const pattern = selectedPattern(options.repository, projectId, authority.origin.hostname);
        if (pattern === undefined) {
          try {
            await ownBlindTunnel({
              client,
              authority,
              head,
              connector: blindConnector,
              timers: blindTimers,
              sockets,
            });
          } catch (error) {
            throw upstreamConnectionError(error);
          }
          return;
        }

        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) client.unshift(head);
        const cert = certCache.getCert(authority.origin.hostname);
        const secureSocket = new tls.TLSSocket(client, {
          isServer: true,
          key: cert.privateKey,
          cert: cert.cert,
          ALPNProtocols: ['http/1.1'],
        });
        connectAuthorities.set(secureSocket, authority);
        sockets.delete(client);
        sockets.add(secureSocket);
        const consumeSecureError = () => {
          if (!secureSocket.destroyed) secureSocket.destroy();
        };
        secureSocket.on('error', consumeSecureError);
        secureSocket.once('close', () => {
          sockets.delete(secureSocket);
        });
        mitmServer.emit('connection', secureSocket);
      } catch (error) {
        if (!client.destroyed) void writeSocketError(client, error);
      }
    })();
  };
  server.on('request', (request, response) => {
    if (admissionState === 'open') {
      enqueue(request, response, 'plain_http_proxy');
      return;
    }
    if (admissionState === 'closed') {
      void writeCanonicalErrorResponse(
        response,
        new HttpError(503, 'SERVER_STARTUP_FAILED', 'Server startup failed'),
        randomUUID(),
        { closeConnection: true },
      ).catch(error => response.destroy(error instanceof Error ? error : undefined));
      return;
    }
    request.pause();
    heldRequests.push([request, response]);
    options.onAdmissionHeld?.();
  });
  server.on('connect', (request, clientSocket, head) => {
    const client = clientSocket as net.Socket;
    if (admissionState === 'open') {
      handleConnect(request, client, head);
      return;
    }
    if (admissionState === 'closed') {
      void writeSocketError(client, new HttpError(503, 'SERVER_STARTUP_FAILED', 'Server startup failed'));
      return;
    }
    client.pause();
    heldConnects.push([request, client, Buffer.from(head)]);
    options.onAdmissionHeld?.();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, resolve);
  });
  const address = server.address();
  console.log(`[Proxy] HTTP proxy listening on port ${typeof address === 'object' && address ? address.port : options.port}`);

  const markAdmissionsOpen = (): void => {
    if (admissionState !== 'holding') return;
    admissionState = 'open';
  };
  const releaseHeldAdmissions = (): void => {
    if (admissionState !== 'open') return;
    for (const [request, response] of heldRequests.splice(0)) {
      if (request.destroyed || response.destroyed) continue;
      try {
        enqueue(request, response, 'plain_http_proxy');
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
      request.resume();
    }
    for (const [request, socket, head] of heldConnects.splice(0)) {
      if (socket.destroyed) continue;
      try {
        handleConnect(request, socket, head);
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
      socket.resume();
    }
  };
  const closeAdmissions = async (
    error = new HttpError(503, 'SERVER_STARTUP_FAILED', 'Server startup failed'),
  ): Promise<void> => {
    if (admissionState === 'closed') return;
    admissionState = 'closed';
    const settlements: Promise<void>[] = [];
    for (const [request, response] of heldRequests.splice(0)) {
      request.resume();
      if (response.destroyed) continue;
      settlements.push(writeCanonicalErrorResponse(
        response,
        error,
        randomUUID(),
        { closeConnection: true },
      ).then(() => undefined));
    }
    for (const [, socket] of heldConnects.splice(0)) {
      if (socket.destroyed) continue;
      settlements.push(writeSocketError(socket, error, true));
    }
    await Promise.allSettled(settlements);
  };
  const close = async (): Promise<void> => {
    await closeAdmissions();
    const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) {
      socket.on('error', () => undefined);
      if (socket instanceof tls.TLSSocket && socket.writable && !socket.writableEnded) socket.end();
      else socket.destroy();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const socket of sockets) {
      if (!socket.destroyed) socket.destroy();
    }
    await serverClosed;
    await Promise.allSettled([...trafficSettlements]);
  };
  return { server, markAdmissionsOpen, releaseHeldAdmissions, closeAdmissions, close };
}
