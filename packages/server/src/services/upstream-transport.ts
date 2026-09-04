import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { finished } from 'node:stream';

import type { RequestAuthority } from './request-authority';

export type HeaderTuple = readonly [name: string, value: string];

export interface UpstreamRequest {
  authority: RequestAuthority;
  rawRequestTarget: string;
  method: string;
  headers: readonly HeaderTuple[];
  body?: NodeJS.ReadableStream;
  signal: AbortSignal;
}

export interface UpstreamResponse {
  statusCode: number;
  headers: HeaderTuple[];
  body: NodeJS.ReadableStream;
  closeConnection: boolean;
}

export interface UpstreamTransport {
  forward(request: UpstreamRequest): Promise<UpstreamResponse>;
}

export interface BlindTunnelConnector {
  connect(
    authority: RequestAuthority,
    signal: AbortSignal,
    claim: (socket: net.Socket) => void,
  ): Promise<void>;
}

export interface NodeUpstreamTransportOptions {
  lookup?: net.LookupFunction;
  ca?: string | Buffer | readonly (string | Buffer)[];
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function connectionTokens(headers: readonly HeaderTuple[]): Set<string> {
  const tokens = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) {
      const normalized = token.trim().toLowerCase();
      if (normalized) tokens.add(normalized);
    }
  }
  return tokens;
}

function endToEndHeaders(headers: readonly HeaderTuple[]): HeaderTuple[] {
  const excluded = connectionTokens(headers);
  return headers.filter(([name]) => {
    const normalized = name.toLowerCase();
    return !HOP_BY_HOP_HEADERS.has(normalized) && !excluded.has(normalized);
  });
}

function rawHeaderArray(headers: readonly HeaderTuple[]): string[] {
  return headers.flatMap(([name, value]) => [name, value]);
}

function upstreamRequestHeaders(
  authority: RequestAuthority,
  headers: readonly HeaderTuple[],
): HeaderTuple[] {
  const filtered = endToEndHeaders(headers);
  return filtered.some(([name]) => name.toLowerCase() === 'host')
    ? filtered
    : [...filtered, ['Host', authority.rawAuthority]];
}

function responseHeaderTuples(rawHeaders: readonly string[]): HeaderTuple[] {
  const headers: HeaderTuple[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers.push([rawHeaders[index], rawHeaders[index + 1]]);
  }
  return headers;
}

function originFormTarget(rawRequestTarget: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(rawRequestTarget);
  if (!absolute) return rawRequestTarget || '/';
  const suffix = absolute[1];
  if (!suffix) return '/';
  return suffix.startsWith('?') ? `/${suffix}` : suffix;
}

function responseCloses(message: http.IncomingMessage, rawHeaders: readonly HeaderTuple[]): boolean {
  const tokens = connectionTokens(rawHeaders);
  if (tokens.has('close')) return true;
  return message.httpVersionMajor === 1
    && message.httpVersionMinor === 0
    && !tokens.has('keep-alive');
}

function timeoutError(): Error & { code: string } {
  return Object.assign(new Error('Upstream request timed out'), { code: 'UPSTREAM_TIMEOUT' });
}

export function createNodeUpstreamTransport(
  options: NodeUpstreamTransportOptions = {},
): UpstreamTransport {
  return {
    forward(request): Promise<UpstreamResponse> {
      return new Promise((resolve, reject) => {
        let responseSettled = false;
        const headers = upstreamRequestHeaders(request.authority, request.headers);
        const ca: https.RequestOptions['ca'] = options.ca === undefined
          || typeof options.ca === 'string'
          || Buffer.isBuffer(options.ca)
          ? options.ca
          : [...options.ca];
        const requestOptions: https.RequestOptions = {
          protocol: `${request.authority.origin.scheme}:`,
          hostname: request.authority.origin.hostname,
          port: request.authority.origin.effectivePort,
          method: request.method,
          path: originFormTarget(request.rawRequestTarget),
          headers: rawHeaderArray(headers),
          joinDuplicateHeaders: true,
          signal: request.signal,
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
          ...(ca === undefined ? {} : { ca }),
        };
        const receive = (incoming: http.IncomingMessage) => {
          const rawResponseHeaders = responseHeaderTuples(incoming.rawHeaders);
          responseSettled = true;
          resolve({
            statusCode: incoming.statusCode ?? 502,
            headers: endToEndHeaders(rawResponseHeaders),
            body: incoming,
            closeConnection: responseCloses(incoming, rawResponseHeaders),
          });
        };
        const outgoing = request.authority.origin.scheme === 'https'
          ? https.request(requestOptions, receive)
          : http.request(requestOptions, receive);
        const body = request.body as (NodeJS.ReadableStream & {
          destroy?(error?: Error): void;
          destroyed?: boolean;
          readableEnded?: boolean;
        }) | undefined;
        let sourceDone = body === undefined;
        let outgoingDone = false;
        let destroyingBody = false;
        let destructionSettled = false;
        let cleanupFinishedListeners: (() => void) | undefined;

        const releaseCleanupListeners = () => {
          cleanupFinishedListeners?.();
          cleanupFinishedListeners = undefined;
        };
        const retainCleanupListeners = () => {
          if (!body || cleanupFinishedListeners) return;
          cleanupFinishedListeners = finished(body, { writable: false }, () => {
            releaseCleanupListeners();
            destructionSettled = true;
            maybeDetachBodyListeners();
          });
        };

        const detachBodyListeners = () => {
          body?.off('error', onBodyError);
          body?.off('end', onBodyEnd);
          body?.off('close', onBodyClose);
          outgoing.off('finish', onOutgoingFinish);
          outgoing.off('close', onOutgoingClose);
        };
        const maybeDetachBodyListeners = () => {
          if (!sourceDone || !outgoingDone || (destroyingBody && !destructionSettled)) return;
          detachBodyListeners();
        };
        const unpipeBody = () => {
          try {
            body?.unpipe?.(outgoing);
          } catch {
            // Cleanup failures cannot replace the transport result.
          }
        };
        const destroyBody = () => {
          if (!body || body.destroyed || body.destroy === undefined || destroyingBody) return;
          destroyingBody = true;
          retainCleanupListeners();
          try {
            body.destroy();
          } catch {
            destructionSettled = true;
            releaseCleanupListeners();
            maybeDetachBodyListeners();
          }
        };
        const endOutgoing = () => {
          if (outgoing.destroyed || outgoing.writableEnded) return;
          try {
            outgoing.end();
          } catch (error) {
            outgoing.destroy(error instanceof Error ? error : undefined);
          }
        };
        const terminateSource = () => {
          if (!body) return;
          sourceDone = true;
          unpipeBody();
          destroyBody();
          endOutgoing();
          maybeDetachBodyListeners();
        };
        const onBodyError = (error: Error) => {
          if (!responseSettled) outgoing.destroy(error);
          else terminateSource();
        };
        const onBodyEnd = () => {
          sourceDone = true;
          maybeDetachBodyListeners();
        };
        const onBodyClose = () => {
          if (body && !body.readableEnded) {
            if (!responseSettled) {
              outgoing.destroy(new Error('Upstream request body closed before completion'));
            } else {
              sourceDone = true;
              unpipeBody();
              endOutgoing();
            }
          } else {
            sourceDone = true;
          }
          maybeDetachBodyListeners();
        };
        const onOutgoingFinish = () => {
          outgoingDone = true;
          if (!sourceDone) terminateSource();
          else maybeDetachBodyListeners();
        };
        const onOutgoingClose = () => {
          outgoingDone = true;
          if (!sourceDone) terminateSource();
          else maybeDetachBodyListeners();
        };

        const fail = (error: Error) => {
          outgoingDone = true;
          terminateSource();
          if (!responseSettled) {
            responseSettled = true;
            reject(error);
          }
          maybeDetachBodyListeners();
        };
        outgoing.once('error', fail);
        outgoing.once('finish', onOutgoingFinish);
        outgoing.once('close', onOutgoingClose);
        outgoing.setTimeout(30_000, () => outgoing.destroy(timeoutError()));

        if (request.body === undefined) {
          outgoing.end();
          return;
        }
        request.body.once('error', onBodyError);
        request.body.once('end', onBodyEnd);
        request.body.once('close', onBodyClose);
        request.body.pipe(outgoing);
      });
    },
  };
}

export function createNodeBlindTunnelConnector(options: {
  lookup?: net.LookupFunction;
} = {}): BlindTunnelConnector {
  return {
    connect(authority, signal, claim): Promise<void> {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: authority.origin.hostname,
          port: authority.origin.effectivePort,
          signal,
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
        });
        const cleanup = () => {
          socket.off('connect', connected);
          socket.off('error', failed);
        };
        const connected = () => {
          try {
            claim(socket);
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            socket.destroy();
            reject(error);
          }
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        socket.once('connect', connected);
        socket.once('error', failed);
      });
    },
  };
}
