import { createHash } from 'node:crypto';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import request, { type SuperTest, type Test } from 'supertest';

import { startServers, type ServerRuntimeOwner } from '../app';
import { TRAFFIC_LIMITS } from '../domain/traffic';
import { nodeFileSystem, type FileSystem } from '../repository/file-system';
import type { ProjectRepository } from '../repository/project-repository';
import type { PublicationFailpoints, PublicationOperation } from '../repository/traffic-promotion';
import { createProcessTrafficContext, createRuntime, type RuntimeContext } from '../runtime/create-runtime';
import { generateCA, generateServerCert } from '../services/certs/generator';
import {
  createNodeBlindTunnelConnector,
  createNodeUpstreamTransport,
  type BlindTunnelConnector,
  type UpstreamTransport,
} from '../services/upstream-transport';
import {
  requestPlainProxy,
  requestTlsProxy,
  type PlainProxyTarget,
  type ProxyTestResponse,
  type TlsProxyTarget,
} from '../test-support/proxy-test-client';
import {
  extendCleanupManifest,
  finalizeCleanup,
  writeCleanupManifest,
  writeOwnerCloseReport,
  type CleanupManifest,
  type CleanupOwnerCloseReport,
  type CleanupReport,
} from '../test-support/cleanup-report';

export interface ProxyTestClient {
  port: number;
  requestPlain(target: PlainProxyTarget | {
    host: string;
    path?: string;
    method?: string;
  }): Promise<ProxyTestResponse>;
  requestTls(target: Omit<TlsProxyTarget, 'ca'> | {
    host: string;
    targetPort?: number;
    path?: string;
    method?: string;
  }): Promise<ProxyTestResponse>;
  close(): Promise<void>;
}

export interface IntegrationUpstream {
  origin: string;
  scheme: 'http' | 'https';
  hostname: string;
  port: number;
  requests: Array<{ method: string; url: string; headers: string[][]; body: Buffer }>;
  close(): Promise<void>;
}

export interface IntegrationHarness {
  request: SuperTest<Test>;
  repository: ProjectRepository;
  traffic: RuntimeContext['traffic'];
  rootDirectory: string;
  tlsTrustBundle: readonly (string | Buffer)[];
  failNextRename(error?: Error): void;
  failNext(operation: PublicationOperation, error?: Error): void;
  restart(): Promise<void>;
  proxy(): Promise<ProxyTestClient>;
  upstream(
    options: { scheme: 'http' | 'https'; hostname: string },
    handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  ): Promise<IntegrationUpstream>;
  readJson(relativePath: string): Promise<unknown>;
  listRootEntries(): Promise<string[]>;
  cleanupManifest(): CleanupManifest;
  closeOwners(): Promise<CleanupOwnerCloseReport>;
  dispose(): Promise<CleanupReport>;
}

function appRequest(port: number): SuperTest<Test> {
  return request(`http://127.0.0.1:${port}`) as unknown as SuperTest<Test>;
}

type LookupOneCallback = (
  error: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;
type LookupAllCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: dns.LookupAddress[],
) => void;

export async function createIntegrationHarness(options: {
  upstreamTransport?: UpstreamTransport;
  blindTunnelConnector?: BlindTunnelConnector;
  publicationFailpoints?: PublicationFailpoints;
  fixtureHostnameAliases?: Readonly<Record<string, string>>;
  lookupAddresses?: Readonly<Record<string, string>>;
  lookupFailures?: readonly string[];
  onLookup?(hostname: string): void;
} = {}): Promise<IntegrationHarness> {
  const rootDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-integration-'));
  const certificateDirectory = path.join(rootDirectory, 'certificates');
  let cleanupManifest: CleanupManifest = {
    listeners: ['http', 'https', 'proxy'],
    socketOwners: ['proxy-clients', 'server-runtime'],
    roots: [
      { owner: 'runtime', relativePath: 'projects', afterOwnerClose: 'contained-until-parent-removal' },
      { owner: 'certificates', relativePath: 'certificates', afterOwnerClose: 'contained-until-parent-removal' },
      { owner: 'traffic-cache', relativePath: 'traffic-cache', afterOwnerClose: 'absent-or-empty' },
      { owner: 'body-staging', relativePath: 'traffic-cache/incoming', afterOwnerClose: 'absent-or-empty' },
    ],
  };
  const fixtureCA = generateCA();
  const fixtureAddresses = new Map<string, number>();
  const fixtureHostnameAliases = new Map(Object.entries(options.fixtureHostnameAliases ?? {})
    .map(([alias, fixture]) => [alias.toLowerCase(), fixture.toLowerCase()]));
  const lookupAddresses = new Map(Object.entries(options.lookupAddresses ?? {})
    .map(([hostname, address]) => [hostname.toLowerCase(), address]));
  const lookupFailures = new Set((options.lookupFailures ?? []).map(hostname => hostname.toLowerCase()));
  const lookup = ((
    hostname: string,
    lookupOptions: dns.LookupOptions | number,
    callback: LookupOneCallback | LookupAllCallback,
  ) => {
    options.onLookup?.(hostname);
    const normalizedHostname = hostname.toLowerCase();
    if (lookupFailures.has(normalizedHostname)) {
      const error = Object.assign(new Error(`Injected lookup failure for ${hostname}`), {
        code: 'ENOTFOUND',
        hostname,
      });
      if (typeof lookupOptions === 'object' && lookupOptions.all) {
        (callback as LookupAllCallback)(error, []);
      } else {
        (callback as LookupOneCallback)(error, '', 0);
      }
      return;
    }
    const fixtureHostname = fixtureHostnameAliases.get(normalizedHostname) ?? normalizedHostname;
    const injectedAddress = lookupAddresses.get(normalizedHostname)
      ?? (fixtureAddresses.has(fixtureHostname) ? '127.0.0.1' : undefined);
    if (injectedAddress !== undefined) {
      if (typeof lookupOptions === 'object' && lookupOptions.all) {
        (callback as LookupAllCallback)(null, [{ address: injectedAddress, family: 4 }]);
      } else {
        (callback as LookupOneCallback)(null, injectedAddress, 4);
      }
      return;
    }
    if (typeof lookupOptions === 'number') {
      dns.lookup(hostname, lookupOptions, callback as LookupOneCallback);
    } else if (lookupOptions.all) {
      dns.lookup(hostname, { ...lookupOptions, all: true }, callback as LookupAllCallback);
    } else {
      dns.lookup(hostname, lookupOptions as dns.LookupOneOptions, callback as LookupOneCallback);
    }
  }) as net.LookupFunction;
  const upstreamTransport = options.upstreamTransport
    ?? createNodeUpstreamTransport({ lookup, ca: fixtureCA.cert });
  const blindTunnelConnector = options.blindTunnelConnector
    ?? createNodeBlindTunnelConnector({ lookup });
  const upstreamOwners: Array<{ close(): Promise<void> }> = [];
  let renameFailure: Error | undefined;
  const fileSystem: FileSystem = {
    ...nodeFileSystem,
    async rename(from, to) {
      if (renameFailure) {
        const error = renameFailure;
        renameFailure = undefined;
        throw error;
      }
      await nodeFileSystem.rename(from, to);
    },
  };
  const proxyClients = new Set<ProxyTestClient>();
  const closeProxyClients = async (): Promise<void> => {
    await Promise.all([...proxyClients].map(client => client.close()));
    proxyClients.clear();
  };

  try {
    await writeCleanupManifest(rootDirectory, cleanupManifest);
    await fs.promises.mkdir(certificateDirectory, { recursive: true });
    await Promise.all([
      fs.promises.writeFile(path.join(certificateDirectory, 'ca.crt'), fixtureCA.cert),
      fs.promises.writeFile(path.join(certificateDirectory, 'ca.key'), fixtureCA.privateKey),
    ]);
    const processTraffic = createProcessTrafficContext({
      ...TRAFFIC_LIMITS,
      rowsPerProject: 40,
      previewBytes: 1_024,
      bodyBytes: 64 * 1_024,
      sidecarQueueBytes: 64 * 1_024,
      projectActiveSidecars: 4,
      projectQueuedBytes: 256 * 1_024,
      processActiveSidecars: 8,
      processQueuedBytes: 512 * 1_024,
      projectTemporaryBytes: 512 * 1_024,
      processTemporaryBytes: 1_024 * 1_024,
      projectRetainedBytes: 512 * 1_024,
      processRetainedBytes: 1_024 * 1_024,
    });
    let pendingPublicationFailure: { operation: PublicationOperation; error: Error } | undefined;
    const publicationFailpoints: PublicationFailpoints = {
      async before(operation) {
        await options.publicationFailpoints?.before(operation);
        if (pendingPublicationFailure?.operation !== operation) return;
        const failure = pendingPublicationFailure.error;
        pendingPublicationFailure = undefined;
        throw failure;
      },
    };
    const createOwnedRuntime = async (): Promise<{
      runtime: RuntimeContext;
      owner: ServerRuntimeOwner;
    }> => {
      const runtime = await createRuntime({
        rootDirectory,
        fileSystem,
        processTraffic,
        isAdminRequestLocal: () => true,
        upstreamTransport,
        blindTunnelConnector,
        publicationFailpoints,
      });
      const owner = await startServers({
        runtime,
        requestedPorts: { http: 0, https: 0, proxy: 0 },
        certificateDirectory,
      });
      return { runtime, owner };
    };
    let { runtime, owner } = await createOwnedRuntime();
    let ownerCloseReport: CleanupOwnerCloseReport | undefined;

    const rootState = async (relativePath: string): Promise<'absent' | 'empty' | 'contained'> => {
      const absolute = path.join(rootDirectory, relativePath);
      try {
        const stat = await fs.promises.stat(absolute);
        if (stat.isDirectory() && (await fs.promises.readdir(absolute)).length === 0) return 'empty';
        return 'contained';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw error;
      }
    };

    const closeOwners = async (): Promise<CleanupOwnerCloseReport> => {
      if (ownerCloseReport) return ownerCloseReport;
      await closeProxyClients();
      await Promise.all(upstreamOwners.map(upstream => upstream.close()));
      await owner.close();
      const report: CleanupOwnerCloseReport = {
        manifest: cleanupManifest,
        closedListeners: [...cleanupManifest.listeners],
        closedSocketOwners: [...cleanupManifest.socketOwners],
        rootsAfterOwnerClose: await Promise.all(cleanupManifest.roots.map(async root => ({
          owner: root.owner,
          relativePath: root.relativePath,
          state: await rootState(root.relativePath),
        }))),
      };
      await writeOwnerCloseReport(rootDirectory, report);
      ownerCloseReport = report;
      return report;
    };

    const harness: IntegrationHarness = {
      request: appRequest(owner.ports.http),
      repository: runtime.repository,
      traffic: runtime.traffic,
      rootDirectory,
      tlsTrustBundle: [fixtureCA.cert],
      failNextRename(error = new Error('Injected rename failure')) {
        renameFailure = error;
      },
      failNext(operation, error = new Error(`Injected ${operation} failure`)) {
        pendingPublicationFailure = { operation, error };
      },
      async restart() {
        ownerCloseReport = undefined;
        await closeProxyClients();
        await owner.close();
        ({ runtime, owner } = await createOwnedRuntime());
        harness.request = appRequest(owner.ports.http);
        harness.repository = runtime.repository;
        harness.traffic = runtime.traffic;
      },
      async proxy() {
        const port = owner.ports.proxy;
        let closed = false;
        const client: ProxyTestClient = {
          port,
          requestPlain: target => requestPlainProxy(port, target),
          requestTls: target => requestTlsProxy(port, { ...target, ca: harness.tlsTrustBundle }),
          async close() {
            if (closed) return;
            closed = true;
            proxyClients.delete(client);
          },
        };
        proxyClients.add(client);
        return client;
      },
      async upstream(upstreamOptions, handler) {
        const hostname = upstreamOptions.hostname.toLowerCase();
        if (!/^[a-z0-9.-]+$/.test(hostname) || hostname !== upstreamOptions.hostname) {
          throw new Error(`Invalid fixture hostname: ${upstreamOptions.hostname}`);
        }
        if (fixtureAddresses.has(hostname)) throw new Error(`Fixture hostname already registered: ${hostname}`);
        const requests: IntegrationUpstream['requests'] = [];
        const observe = (incoming: http.IncomingMessage, response: http.ServerResponse) => {
          const observed = {
            method: incoming.method ?? '',
            url: incoming.url ?? '',
            headers: [] as string[][],
            body: Buffer.alloc(0),
          };
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            observed.headers.push([incoming.rawHeaders[index], incoming.rawHeaders[index + 1]]);
          }
          const chunks: Buffer[] = [];
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
          incoming.once('end', () => { observed.body = Buffer.concat(chunks); });
          requests.push(observed);
          handler(incoming, response);
        };
        const sockets = new Set<net.Socket>();
        const fixtureDirectory = path.join(rootDirectory, 'upstreams');
        const certificate = generateServerCert(fixtureCA, [hostname]);
        const fixturePrefix = `${upstreamOptions.scheme}-${hostname}`;
        const server = upstreamOptions.scheme === 'https'
          ? https.createServer({ cert: certificate.cert, key: certificate.privateKey }, observe)
          : http.createServer(observe);
        server.on('connection', socket => {
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
              server.off('error', reject);
              resolve();
            });
          });
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Expected upstream TCP address');
          const listener = `upstream:${upstreamOptions.scheme}:${hostname}:${address.port}`;
          const socketOwner = `upstream-sockets:${upstreamOptions.scheme}:${hostname}:${address.port}`;
          cleanupManifest = await extendCleanupManifest(rootDirectory, {
            listeners: [listener],
            socketOwners: [socketOwner],
            roots: cleanupManifest.roots.some(root => root.owner === 'upstream')
              ? []
              : [{
                  owner: 'upstream',
                  relativePath: 'upstreams',
                  afterOwnerClose: 'contained-until-parent-removal',
                }],
          });
          await fs.promises.mkdir(fixtureDirectory, { recursive: true });
          await Promise.all([
            fs.promises.writeFile(path.join(fixtureDirectory, `${fixturePrefix}.crt`), certificate.cert),
            fs.promises.writeFile(path.join(fixtureDirectory, `${fixturePrefix}.key`), certificate.privateKey),
          ]);
          fixtureAddresses.set(hostname, address.port);
        } catch (error) {
          fixtureAddresses.delete(hostname);
          for (const socket of sockets) socket.destroy();
          if (server.listening) {
            await new Promise<void>(resolve => server.close(() => resolve()));
          }
          throw error;
        }
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected upstream TCP address');
        let closed = false;
        const upstream: IntegrationUpstream = {
          origin: `${upstreamOptions.scheme}://${hostname}:${address.port}`,
          scheme: upstreamOptions.scheme,
          hostname,
          port: address.port,
          requests,
          async close() {
            if (closed) return;
            closed = true;
            fixtureAddresses.delete(hostname);
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          },
        };
        upstreamOwners.push(upstream);
        return upstream;
      },
      async readJson(relativePath) {
        return JSON.parse(await fs.promises.readFile(path.join(rootDirectory, relativePath), 'utf8')) as unknown;
      },
      async listRootEntries() {
        return (await fs.promises.readdir(rootDirectory)).sort();
      },
      cleanupManifest() {
        return cleanupManifest;
      },
      closeOwners,
      async dispose() {
        return finalizeCleanup(rootDirectory, await closeOwners());
      },
    };
    return harness;
  } catch (error) {
    await fs.promises.rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function hashTree(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        hashes[`${relative}/`] = 'directory';
        await visit(absolute);
      } else {
        hashes[relative] = createHash('sha256')
          .update(await fs.promises.readFile(absolute))
          .digest('hex');
      }
    }
  };
  await visit(root);
  return hashes;
}
