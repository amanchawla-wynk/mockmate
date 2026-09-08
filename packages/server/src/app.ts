import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';

import cors from 'cors';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';

import type { TrafficExchange } from './domain/traffic';
import { projectRequestHeaders } from './domain/http-metadata';
import { parseRawQuery } from './domain/query-matcher';
import { requireLocalAdmin } from './middleware/admin-security';
import { createAdminRouter } from './routes/admin';
import { createAutomationRouter } from './routes/automation';
import { createSetupRouter } from './routes/setup';
import { createStaticDeliveryRouter } from './routes/static-files';
import {
  apiErrorMiddleware,
  HttpError,
  requestIdMiddleware,
  serializeApiError,
} from './services/api-errors';
import { ensureCertificates } from './services/certs';
import { writeCanonicalErrorResponse } from './services/canonical-error-response';
import { createDeliveryCauseTracker } from './services/delivery-cause';
import { ObservedResponseTarget } from './services/observed-response-target';
import { getInterceptHostPatterns, getLocalControlHosts, hostMatchesPattern } from './services/intercept';
import { getLocalIPAddresses } from './services/network';
import { createProxyServer } from './services/proxy-server';
import { deriveDirectAuthority } from './services/request-authority';
import { decideRuntimeRequest } from './services/runtime-decision';
import {
  outgoingHeaderTuples,
  writeResolvedResponse,
} from './services/response-writer';
import { debugHeaders, withoutReservedDebugHeaders } from './services/traffic-provenance';
import { currentTrafficAppState, projectTrafficDecision } from './services/traffic-evidence';
import { getRuntimeTransportOwners, type RuntimeContext } from './runtime/create-runtime';

export interface ServerPorts {
  http: number;
  https: number;
  proxy: number;
}

export interface StartServersOptions {
  runtime: RuntimeContext;
  requestedPorts: ServerPorts;
  certificateDirectory: string;
  beforeOpenAdmissions?(ports: ServerPorts): Promise<void>;
  onAdmissionHeld?(listener: keyof ServerPorts): void;
}

export interface ServerRuntimeOwner {
  readonly ports: ServerPorts;
  readonly app: Application;
  close(): Promise<void>;
}

function headerValues(headers: ReadonlyArray<readonly [string, string]>, name: string): string[] {
  return headers.filter(([candidate]) => candidate.toLowerCase() === name).map(([, value]) => value);
}

function pathAndQuery(target: string): { path: string; rawQuery: string } {
  const queryIndex = target.indexOf('?');
  return {
    path: queryIndex < 0 ? target || '/' : target.slice(0, queryIndex) || '/',
    rawQuery: queryIndex < 0 ? '' : target.slice(queryIndex + 1),
  };
}

async function consumeDirectRequest(request: Request, exchange: TrafficExchange): Promise<void> {
  for await (const chunk of request) exchange.observeRequest(Buffer.from(chunk));
}

async function handleDirectRequest(input: {
  request: Request;
  response: Response;
  next: NextFunction;
  runtime: RuntimeContext;
  projectId: string;
  matchedPattern: string;
  authority: ReturnType<typeof deriveDirectAuthority>;
}): Promise<void> {
  const { request, response, runtime, projectId, matchedPattern, authority } = input;
  const rawTarget = request.originalUrl || request.url || '/';
  const target = pathAndQuery(rawTarget);
  const headers = projectRequestHeaders(request.rawHeaders);
  const state = currentTrafficAppState(runtime.repository, projectId);
  const decision = decideRuntimeRequest({
    transport: 'direct',
    authority,
    rawRequestTarget: rawTarget,
    method: request.method,
    path: target.path,
    rawQuery: target.rawQuery,
    headers: headers.grouped,
    matchedAllowlistPattern: matchedPattern,
    repository: runtime.repository,
    projectId,
  });
  if (decision.kind === 'blind' || decision.kind === 'upstream') {
    input.next(new Error('Direct routing produced an invalid decision'));
    return;
  }
  const exchange = runtime.traffic.begin({
    projectId,
    requestId: String(response.locals.requestId),
    transport: 'direct',
    allowlistPattern: matchedPattern,
    origin: authority.origin,
    method: request.method,
    path: target.path,
    query: parseRawQuery(target.rawQuery),
    headers: headers.tuples,
    appState: state,
  });
  exchange.setDecision(projectTrafficDecision(decision, state));
  const deliveryCause = createDeliveryCauseTracker();
  const markRequestCancelled = () => deliveryCause.markCancelled();
  request.once('aborted', markRequestCancelled);
  let targetResponse: ObservedResponseTarget | undefined;

  try {
    await consumeDirectRequest(request, exchange);
    if (decision.kind === 'mock') {
      const resolved = {
        ...decision.endpoint.resolved,
        responseHeaders: withoutReservedDebugHeaders(decision.endpoint.resolved.responseHeaders),
      };
      const settings = runtime.repository.getRuntimeSettings(projectId);
      for (const [name, value] of Object.entries(debugHeaders(
        resolved,
        {
          enabled: settings.debugProvenanceHeaders,
          projectId,
          requestId: String(response.locals.requestId),
        },
      ))) response.setHeader(name, value);
      targetResponse = new ObservedResponseTarget(response, deliveryCause, {
        onHead: status => exchange.setResponse(status, outgoingHeaderTuples(response.getHeaders())),
        onChunk: chunk => exchange.observeResponse(chunk),
      });
      const responseBytes = await writeResolvedResponse(
        targetResponse,
        resolved,
        runtime.repository,
        request.method,
      );
      runtime.traffic.complete(exchange, {
        kind: 'response', status: decision.endpoint.resolved.status, responseBytes,
      });
      return;
    }
    const error = new HttpError(404, 'ENDPOINT_NOT_FOUND', 'No Endpoint matched the direct request');
    deliveryCause.markFailure();
    const failure = await writeCanonicalErrorResponse(
      response,
      error,
      String(response.locals.requestId),
      {
        contentType: 'application/json; charset=utf-8',
        requestIdFirst: true,
        onHead: (status, headers) => exchange.setResponse(status, headers),
        onChunk: chunk => exchange.observeResponse(chunk),
      },
    );
    runtime.traffic.complete(exchange, {
      kind: 'failure',
      status: failure.status,
      responseBytes: failure.responseBytes,
      responseBodyComplete: failure.bodyComplete,
      failure: { code: failure.code, message: failure.message },
    });
  } catch (error) {
    if (deliveryCause.cause === 'cancelled') {
      if (!response.destroyed) response.destroy();
      runtime.traffic.complete(exchange, {
        kind: 'cancelled', status: response.statusCode, responseBytes: targetResponse?.responseBytes ?? 0,
      });
      return;
    }
    deliveryCause.markFailure();
    if (response.headersSent) {
      const serialized = serializeApiError(error, String(response.locals.requestId));
      response.destroy(error instanceof Error ? error : undefined);
      runtime.traffic.complete(exchange, {
        kind: 'failure',
        status: response.statusCode,
        responseBytes: targetResponse?.responseBytes ?? 0,
        failure: { code: serialized.body.code, message: serialized.body.message },
      });
      return;
    }
    const failure = await writeCanonicalErrorResponse(
      response,
      error,
      String(response.locals.requestId),
      {
        contentType: 'application/json; charset=utf-8',
        requestIdFirst: true,
        onHead: (status, headers) => exchange.setResponse(status, headers),
        onChunk: chunk => exchange.observeResponse(chunk),
      },
    );
    runtime.traffic.complete(exchange, {
      kind: 'failure',
      status: failure.status,
      responseBytes: failure.responseBytes,
      responseBodyComplete: failure.bodyComplete,
      failure: { code: failure.code, message: failure.message },
    });
  } finally {
    request.off('aborted', markRequestCancelled);
  }
}

export function createApp(options: {
  runtime: RuntimeContext;
  setupRouter: Router;
  getPorts: () => ServerPorts;
}): Application {
  if (!options?.runtime?.repository || !options.runtime.traffic) {
    throw new Error('MockMate requires an initialized RuntimeContext');
  }
  if (!options.setupRouter) throw new Error('MockMate requires an owned setup Router');
  const { runtime } = options;
  const { repository } = runtime;
  const localControlHosts = getLocalControlHosts();
  const getStaticDeliveryBaseUrl = () => {
    const host = getLocalIPAddresses()[0] ?? 'localhost';
    return `https://${host}:${options.getPorts().https}`;
  };
  const app = express();
  app.use(requestIdMiddleware);
  app.use((request, response, next) => {
    let authority;
    try {
      const tuples = projectRequestHeaders(request.rawHeaders).tuples;
      authority = deriveDirectAuthority({
        listenerScheme: (request.socket as net.Socket & { encrypted?: boolean }).encrypted ? 'https' : 'http',
        hostHeaders: headerValues(tuples, 'host'),
        reservedOriginHeaders: headerValues(tuples, 'x-mockmate-origin'),
      });
    } catch (error) {
      next(error);
      return;
    }
    if (localControlHosts.has(authority.origin.hostname)) {
      next();
      return;
    }
    const projectId = repository.getWorkspaceState().activeProjectId;
    if (!projectId) {
      next(new HttpError(503, 'NO_ACTIVE_PROJECT', 'No active Project is selected'));
      return;
    }
    const matchedPattern = getInterceptHostPatterns(repository.getRuntimeSettings(projectId))
      .find(pattern => hostMatchesPattern(pattern, authority.origin.hostname));
    if (matchedPattern === undefined) {
      next(new HttpError(404, 'ENDPOINT_NOT_FOUND', 'No Endpoint matched the direct request'));
      return;
    }
    void handleDirectRequest({
      request,
      response,
      next,
      runtime,
      projectId,
      matchedPattern,
      authority,
    }).catch(next);
  });

  app.use('/api/admin', requireLocalAdmin(runtime.adminSecurity));
  app.use('/api/admin', cors({
    origin: runtime.adminSecurity.dashboardOrigins ?? [],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-MockMate-Encoding', 'X-Request-Id', 'Authorization'],
    exposedHeaders: ['Content-Type', 'Content-Length', 'Content-Encoding', 'X-Request-Id'],
    credentials: false,
  }));
  app.use('/api/admin', createAdminRouter(
    repository,
    localControlHosts,
    runtime.traffic,
    getStaticDeliveryBaseUrl,
  ));
  app.use('/api/admin', (_request, _response, next) => {
    next(new HttpError(404, 'ADMIN_ROUTE_NOT_FOUND', 'Admin route not found'));
  });

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-Id', 'Authorization'],
    exposedHeaders: ['Content-Type', 'X-Request-Id'],
    credentials: false,
  }));
  app.use(express.json());
  app.use('/setup', options.setupRouter);
  app.use(createAutomationRouter(repository, runtime.traffic));
  app.get('/health', (_request, response) => response.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.use('/static_files', createStaticDeliveryRouter(repository));

  const dashboardCandidates = [
    path.join(__dirname, 'public'),
    path.resolve(__dirname, '../dist/public'),
    path.resolve(process.cwd(), 'dist/public'),
    path.resolve(process.cwd(), '../server/dist/public'),
    path.resolve(__dirname, '../../dashboard/dist'),
    path.resolve(process.cwd(), '../dashboard/dist'),
  ];
  const publicDirectory = dashboardCandidates.find(candidate =>
    fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'index.html')));
  if (publicDirectory) {
    app.use(express.static(publicDirectory));
    app.get('*', (request, response, next) => {
      const html = request.get('accept')?.includes('text/html') === true;
      if (!html
        || request.path.startsWith('/api')
        || request.path.startsWith('/setup')
        || request.path.startsWith('/static_files')
        || request.path === '/health'
        || request.path === '/setMockServerflags'
        || request.path === '/getMockServerData') next();
      else response.sendFile(path.join(publicDirectory, 'index.html'));
    });
  }
  app.all('*', (_request, _response, next) => {
    next(new HttpError(404, 'ENDPOINT_NOT_FOUND', 'No Endpoint matched the direct request'));
  });
  app.use(apiErrorMiddleware);
  return app;
}

function assignedPort(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not publish an assigned port');
  return address.port;
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

function startupFailure(): HttpError {
  return new HttpError(503, 'SERVER_STARTUP_FAILED', 'Server startup failed');
}

function writeStartupFailure(response: http.ServerResponse, error: HttpError): Promise<void> {
  if (response.destroyed) return Promise.resolve();
  const requestId = randomUUID();
  const serialized = serializeApiError(error, requestId);
  const body = Buffer.from(JSON.stringify(serialized.body));
  return new Promise(resolve => {
    response.once('finish', resolve);
    response.once('close', resolve);
    response.writeHead(serialized.status, [
      'Content-Type', 'application/json',
      'Content-Length', String(body.length),
      'X-Request-Id', requestId,
      'Connection', 'close',
    ]);
    response.end(body);
  });
}

export function createRequestAdmissionGate(
  app: Application,
  onHeld: () => void,
): {
  handle(request: http.IncomingMessage, response: http.ServerResponse): void;
  markOpen(): void;
  releaseHeld(): void;
  close(error?: HttpError): Promise<void>;
} {
  let state: 'holding' | 'open' | 'closed' = 'holding';
  const held: Array<[http.IncomingMessage, http.ServerResponse]> = [];
  const dispatch = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    try {
      app(request, response);
    } catch (error) {
      request.resume();
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    }
  };
  return {
    handle(request, response) {
      if (state === 'open') {
        dispatch(request, response);
        return;
      }
      if (state === 'closed') {
        void writeStartupFailure(response, startupFailure());
        return;
      }
      request.pause();
      held.push([request, response]);
      onHeld();
    },
    markOpen() {
      if (state !== 'holding') return;
      state = 'open';
    },
    releaseHeld() {
      if (state !== 'open') return;
      for (const [request, response] of held.splice(0)) {
        if (request.destroyed || response.destroyed) continue;
        dispatch(request, response);
        request.resume();
      }
    },
    async close(error = startupFailure()) {
      if (state === 'closed') return;
      state = 'closed';
      await Promise.allSettled(held.splice(0).map(([request, response]) => {
        request.resume();
        return writeStartupFailure(response, error);
      }));
    },
  };
}

function assertCertificateDirectory(rootDirectory: string, certificateDirectory: string): string {
  if (!path.isAbsolute(certificateDirectory)) throw new Error('Certificate directory must be absolute');
  const root = path.resolve(rootDirectory);
  const selected = path.resolve(certificateDirectory);
  const relative = path.relative(root, selected);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Certificate directory must be a strict descendant of the runtime root');
  }
  return selected;
}

export async function startServers(options: StartServersOptions): Promise<ServerRuntimeOwner> {
  const { runtime, requestedPorts } = options;
  let publishedPorts: ServerPorts | undefined;
  let certificates!: Awaited<ReturnType<typeof ensureCertificates>>;
  let app!: Application;
  try {
    const certificateDirectory = assertCertificateDirectory(
      runtime.rootDirectory,
      options.certificateDirectory,
    );
    const getPorts = () => {
      if (publishedPorts === undefined) throw new Error('Server ports are not published');
      return publishedPorts;
    };
    const setupRouter = createSetupRouter({
      certificateDirectory,
      getPorts,
    });
    certificates = await ensureCertificates(getLocalIPAddresses(), certificateDirectory);
    app = createApp({ runtime, setupRouter, getPorts });
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
  const httpAdmissions = createRequestAdmissionGate(
    app,
    () => options.onAdmissionHeld?.('http'),
  );
  const httpsAdmissions = createRequestAdmissionGate(
    app,
    () => options.onAdmissionHeld?.('https'),
  );
  const httpServer = http.createServer(httpAdmissions.handle);
  const httpsServer = https.createServer({
    key: certificates.server.privateKey,
    cert: certificates.server.cert,
  }, httpsAdmissions.handle);
  const sockets = new Set<net.Socket>();
  for (const server of [httpServer, httpsServer]) {
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await Promise.allSettled([
        httpAdmissions.close(),
        httpsAdmissions.close(),
        proxy?.closeAdmissions() ?? Promise.resolve(),
      ]);
      for (const socket of sockets) socket.destroy();
      const cleanup = await Promise.allSettled([
        closeServer(httpServer),
        closeServer(httpsServer),
        proxy?.close() ?? Promise.resolve(),
      ]);
      await runtime.dispose();
      const failed = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return closePromise;
  };

  try {
    await listen(httpServer, requestedPorts.http);
    await listen(httpsServer, requestedPorts.https);
    proxy = await createProxyServer({
      port: requestedPorts.proxy,
      caCert: certificates.ca.cert,
      caKey: certificates.ca.privateKey,
      repository: runtime.repository,
      traffic: runtime.traffic,
      startWithAdmissionsClosed: true,
      onAdmissionHeld: () => options.onAdmissionHeld?.('proxy'),
      ...getRuntimeTransportOwners(runtime),
    });
    const assignedPorts = {
      http: assignedPort(httpServer),
      https: assignedPort(httpsServer),
      proxy: assignedPort(proxy.server),
    };
    await options.beforeOpenAdmissions?.(assignedPorts);
    publishedPorts = assignedPorts;
    httpAdmissions.markOpen();
    httpsAdmissions.markOpen();
    proxy.markAdmissionsOpen();
    httpAdmissions.releaseHeld();
    httpsAdmissions.releaseHeld();
    proxy.releaseHeldAdmissions();
    return { ports: publishedPorts, app, close };
  } catch (error) {
    await Promise.allSettled([
      httpAdmissions.close(startupFailure()),
      httpsAdmissions.close(startupFailure()),
      proxy?.closeAdmissions(startupFailure()) ?? Promise.resolve(),
    ]);
    await close().catch(() => undefined);
    throw error;
  }
}
