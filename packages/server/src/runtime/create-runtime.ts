import { randomUUID } from 'node:crypto';

import { TRAFFIC_LIMITS, type TrafficLimits } from '../domain/traffic';
import type { AppOptions as AdminSecurityOptions } from '../middleware/admin-security';
import { createAtomicFileWriter } from '../repository/atomic-write';
import { createBodyStore } from '../repository/body-store';
import { nodeFileSystem, type FileSystem } from '../repository/file-system';
import {
  createProjectRepository,
  type ProjectRepository,
} from '../repository/project-repository';
import {
  createTrafficPromoter,
  type PublicationFailpoints,
} from '../repository/traffic-promotion';
import { createTrafficBodyBudgetManager, type TrafficBodyBudgetManager } from '../services/traffic-body-budget';
import { createTrafficBodyCache } from '../services/traffic-body-cache';
import {
  createTrafficService,
  type TrafficService,
} from '../services/traffic-service';
import { createTrafficStore } from '../services/traffic-store';
import {
  createNodeBlindTunnelConnector,
  createNodeUpstreamTransport,
  type BlindTunnelConnector,
  type UpstreamTransport,
} from '../services/upstream-transport';

export type { TrafficPromoter, TrafficService } from '../services/traffic-service';

export interface ProcessTrafficContext {
  readonly limits: Readonly<TrafficLimits>;
  bodyBudgets: TrafficBodyBudgetManager;
}

export function createProcessTrafficContext(
  limits: Readonly<TrafficLimits> = TRAFFIC_LIMITS,
): ProcessTrafficContext {
  if (!Number.isSafeInteger(limits.previewBytes) || limits.previewBytes < 0
    || limits.previewBytes > limits.bodyBytes) {
    throw new RangeError('Traffic previewBytes must be a non-negative safe integer no greater than bodyBytes');
  }
  if (!Number.isSafeInteger(limits.bodyBytes)
    || limits.bodyBytes < 0
    || limits.bodyBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Traffic bodyBytes must allow a schema-safe saturated observed size');
  }
  const immutableLimits = Object.freeze({ ...limits });
  return { limits: immutableLimits, bodyBudgets: createTrafficBodyBudgetManager(immutableLimits) };
}

export interface CreateRuntimeOptions extends AdminSecurityOptions {
  rootDirectory: string;
  processTraffic: ProcessTrafficContext;
  fileSystem?: FileSystem;
  upstreamTransport?: UpstreamTransport;
  blindTunnelConnector?: BlindTunnelConnector;
  publicationFailpoints?: PublicationFailpoints;
}

export interface RuntimeContext {
  rootDirectory: string;
  repository: ProjectRepository;
  traffic: TrafficService;
  readonly adminSecurity: AdminSecurityOptions;
  dispose(): Promise<void>;
}

interface RuntimeTransportOwners {
  upstreamTransport: UpstreamTransport;
  blindTunnelConnector: BlindTunnelConnector;
}

const transportOwners = new WeakMap<RuntimeContext, RuntimeTransportOwners>();

export function getRuntimeTransportOwners(runtime: RuntimeContext): RuntimeTransportOwners {
  const owners = transportOwners.get(runtime);
  if (owners === undefined) throw new Error('Runtime transport owners are unavailable');
  return owners;
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<RuntimeContext> {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const atomicWriter = createAtomicFileWriter(fileSystem);
  const bodyStore = createBodyStore({
    rootDirectory: options.rootDirectory,
    atomicWriter,
    fileSystem,
  });
  const repository = createProjectRepository({
    rootDirectory: options.rootDirectory,
    atomicWriter,
    bodyStore,
    ...(options.publicationFailpoints === undefined
      ? {}
      : { publicationFailpoints: options.publicationFailpoints }),
  });
  await repository.initialize();
  const runtimeNamespace = randomUUID();
  const cache = createTrafficBodyCache({
    rootDirectory: options.rootDirectory,
    runtimeNamespace,
    budgets: options.processTraffic.bodyBudgets,
    fileSystem,
    publishDescriptor: publication => store.updateBody(
      publication.projectId,
      publication.trafficId,
      publication.generation,
      publication.side,
      publication.descriptor,
    ),
    onDescriptorPublicationError: () => undefined,
  });
  const store = createTrafficStore({
    rowsPerProject: options.processTraffic.limits.rowsPerProject,
    releaseBodyReference: reference => cache.releaseBody(
      reference.projectId,
      reference.trafficId,
      reference.generation,
      reference.side,
    ),
  });
  await cache.initialize();
  const { service: traffic, promotionAcceptor, installPromoter } = createTrafficService({
    runtimeNamespace,
    repository,
    store,
    cache,
    budgets: options.processTraffic.bodyBudgets,
    fileSystem,
    limits: options.processTraffic.limits,
  });
  const publicationFailpoints = options.publicationFailpoints ?? { async before() {} };
  installPromoter(createTrafficPromoter({
    repository,
    promotionAcceptor,
    publicationFailpoints,
  }));
  const runtime: RuntimeContext = {
    rootDirectory: options.rootDirectory,
    repository,
    traffic,
    adminSecurity: {
      isAdminRequestLocal: options.isAdminRequestLocal,
      ...(options.dashboardOrigins === undefined ? {} : { dashboardOrigins: options.dashboardOrigins }),
    },
    dispose: async () => {
      try {
        await traffic.dispose();
      } finally {
        transportOwners.delete(runtime);
      }
    },
  };
  transportOwners.set(runtime, {
    upstreamTransport: options.upstreamTransport ?? createNodeUpstreamTransport(),
    blindTunnelConnector: options.blindTunnelConnector ?? createNodeBlindTunnelConnector(),
  });
  return runtime;
}
