import type { TrafficLimits } from '../domain/traffic';

export interface TrafficProjectBudgetSnapshot {
  activeSidecars: number;
  queuedBytes: number;
  temporaryBytes: number;
  retainedBytes: number;
}

export interface TrafficRuntimeBudgetSnapshot extends TrafficProjectBudgetSnapshot {
  projects: Record<string, TrafficProjectBudgetSnapshot>;
}

export interface TrafficBudgetSnapshot extends TrafficProjectBudgetSnapshot {
  runtimes: Record<string, TrafficRuntimeBudgetSnapshot>;
}

export interface TrafficBodyBudgetReservation {
  growQueued(delta: number): boolean;
  releaseQueued(delta: number): void;
  growTemporary(delta: number): boolean;
  convertTemporaryToRetained(
    digest: string,
    bytes: number,
  ):
    | { ok: true; physicalBytesAdded: boolean }
    | { ok: false; reason: 'retained_budget_exceeded' };
  release(): void;
}

export interface TrafficBodyBudgetManager {
  reserveSidecar(
    runtimeNamespace: string,
    projectId: string,
    queueBytes: number,
    prospectiveTemporaryBytes: number,
  ):
    | { ok: true; reservation: TrafficBodyBudgetReservation }
    | {
      ok: false;
      reason: 'sidecar_limit' | 'queue_saturated' | 'temporary_budget_exceeded';
    };
  releaseRetained(
    runtimeNamespace: string,
    projectId: string,
    digest: string,
    bytes: number,
  ): void;
  snapshot(): TrafficBudgetSnapshot;
}

type MutableProjectBudget = TrafficProjectBudgetSnapshot;

interface MutableRuntimeBudget extends TrafficProjectBudgetSnapshot {
  projects: Map<string, MutableProjectBudget>;
}

function emptyBudget(): TrafficProjectBudgetSnapshot {
  return { activeSidecars: 0, queuedBytes: 0, temporaryBytes: 0, retainedBytes: 0 };
}

function validBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function retainedKey(runtimeNamespace: string, projectId: string, digest: string): string {
  return `${runtimeNamespace}\0${projectId}\0${digest}`;
}

export function createTrafficBodyBudgetManager(
  limits: Readonly<TrafficLimits>,
): TrafficBodyBudgetManager {
  const processBudget: MutableProjectBudget = emptyBudget();
  const runtimes = new Map<string, MutableRuntimeBudget>();
  const retained = new Map<string, number>();

  const runtimeBudget = (runtimeNamespace: string): MutableRuntimeBudget => {
    let runtime = runtimes.get(runtimeNamespace);
    if (runtime === undefined) {
      runtime = { ...emptyBudget(), projects: new Map() };
      runtimes.set(runtimeNamespace, runtime);
    }
    return runtime;
  };

  const projectBudget = (
    runtimeNamespace: string,
    projectId: string,
  ): { runtime: MutableRuntimeBudget; project: MutableProjectBudget } => {
    const runtime = runtimeBudget(runtimeNamespace);
    let project = runtime.projects.get(projectId);
    if (project === undefined) {
      project = emptyBudget();
      runtime.projects.set(projectId, project);
    }
    return { runtime, project };
  };

  const adjust = (
    runtime: MutableRuntimeBudget,
    project: MutableProjectBudget,
    field: keyof TrafficProjectBudgetSnapshot,
    delta: number,
  ): void => {
    project[field] += delta;
    runtime[field] += delta;
    processBudget[field] += delta;
  };

  const prune = (runtimeNamespace: string, projectId: string): void => {
    const runtime = runtimes.get(runtimeNamespace);
    const project = runtime?.projects.get(projectId);
    if (runtime === undefined || project === undefined) return;
    if (Object.values(project).every(value => value === 0)) runtime.projects.delete(projectId);
    if (runtime.projects.size === 0
      && runtime.activeSidecars === 0
      && runtime.queuedBytes === 0
      && runtime.temporaryBytes === 0
      && runtime.retainedBytes === 0) {
      runtimes.delete(runtimeNamespace);
    }
  };

  return {
    reserveSidecar(runtimeNamespace, projectId, queueBytes, prospectiveTemporaryBytes) {
      if (!validBytes(queueBytes) || !validBytes(prospectiveTemporaryBytes)) {
        throw new RangeError('Traffic body reservation bytes must be nonnegative safe integers');
      }
      const { runtime, project } = projectBudget(runtimeNamespace, projectId);
      if (project.activeSidecars + 1 > limits.projectActiveSidecars
        || processBudget.activeSidecars + 1 > limits.processActiveSidecars) {
        prune(runtimeNamespace, projectId);
        return { ok: false, reason: 'sidecar_limit' };
      }
      if (project.queuedBytes + queueBytes > limits.projectQueuedBytes
        || processBudget.queuedBytes + queueBytes > limits.processQueuedBytes) {
        prune(runtimeNamespace, projectId);
        return { ok: false, reason: 'queue_saturated' };
      }
      if (project.temporaryBytes + prospectiveTemporaryBytes > limits.projectTemporaryBytes
        || processBudget.temporaryBytes + prospectiveTemporaryBytes > limits.processTemporaryBytes) {
        prune(runtimeNamespace, projectId);
        return { ok: false, reason: 'temporary_budget_exceeded' };
      }

      adjust(runtime, project, 'activeSidecars', 1);
      adjust(runtime, project, 'queuedBytes', queueBytes);
      adjust(runtime, project, 'temporaryBytes', prospectiveTemporaryBytes);
      let ownedQueuedBytes = queueBytes;
      let ownedTemporaryBytes = prospectiveTemporaryBytes;
      let released = false;
      let conversion:
        | { digest: string; bytes: number; result: { ok: true; physicalBytesAdded: boolean } }
        | undefined;

      const reservation: TrafficBodyBudgetReservation = {
        growQueued(delta) {
          if (!validBytes(delta)) throw new RangeError('Queued-byte growth must be a safe integer');
          if (released) return false;
          if (project.queuedBytes + delta > limits.projectQueuedBytes
            || processBudget.queuedBytes + delta > limits.processQueuedBytes) return false;
          adjust(runtime, project, 'queuedBytes', delta);
          ownedQueuedBytes += delta;
          return true;
        },

        releaseQueued(delta) {
          if (!validBytes(delta)) throw new RangeError('Queued-byte release must be a safe integer');
          if (released) return;
          const releasedBytes = Math.min(delta, ownedQueuedBytes);
          adjust(runtime, project, 'queuedBytes', -releasedBytes);
          ownedQueuedBytes -= releasedBytes;
          prune(runtimeNamespace, projectId);
        },

        growTemporary(delta) {
          if (!validBytes(delta)) throw new RangeError('Temporary-byte growth must be a safe integer');
          if (released || conversion !== undefined) return false;
          if (project.temporaryBytes + delta > limits.projectTemporaryBytes
            || processBudget.temporaryBytes + delta > limits.processTemporaryBytes) return false;
          adjust(runtime, project, 'temporaryBytes', delta);
          ownedTemporaryBytes += delta;
          return true;
        },

        convertTemporaryToRetained(digest, bytes) {
          if (!/^[a-f0-9]{64}$/.test(digest) || !validBytes(bytes)) {
            throw new RangeError('Retained body identity is invalid');
          }
          if (released || bytes > ownedTemporaryBytes) {
            throw new Error('Traffic body reservation no longer owns the temporary bytes');
          }
          if (conversion !== undefined) {
            if (conversion.digest !== digest || conversion.bytes !== bytes) {
              throw new Error('Traffic body reservation was already converted');
            }
            return conversion.result;
          }

          const key = retainedKey(runtimeNamespace, projectId, digest);
          const existingBytes = retained.get(key);
          if (existingBytes !== undefined && existingBytes !== bytes) {
            throw new Error('Retained body digest size is inconsistent');
          }
          const physicalBytesAdded = existingBytes === undefined && bytes > 0;
          if (physicalBytesAdded
            && (project.retainedBytes + bytes > limits.projectRetainedBytes
              || processBudget.retainedBytes + bytes > limits.processRetainedBytes)) {
            return { ok: false, reason: 'retained_budget_exceeded' };
          }

          adjust(runtime, project, 'temporaryBytes', -bytes);
          ownedTemporaryBytes -= bytes;
          if (physicalBytesAdded) {
            retained.set(key, bytes);
            adjust(runtime, project, 'retainedBytes', bytes);
          }
          const result = { ok: true as const, physicalBytesAdded };
          conversion = { digest, bytes, result };
          return result;
        },

        release() {
          if (released) return;
          released = true;
          adjust(runtime, project, 'activeSidecars', -1);
          adjust(runtime, project, 'queuedBytes', -ownedQueuedBytes);
          adjust(runtime, project, 'temporaryBytes', -ownedTemporaryBytes);
          ownedQueuedBytes = 0;
          ownedTemporaryBytes = 0;
          prune(runtimeNamespace, projectId);
        },
      };
      return { ok: true, reservation };
    },

    releaseRetained(runtimeNamespace, projectId, digest, bytes) {
      if (!validBytes(bytes)) throw new RangeError('Retained-byte release must be a safe integer');
      const key = retainedKey(runtimeNamespace, projectId, digest);
      const retainedBytes = retained.get(key);
      if (retainedBytes === undefined) return;
      if (retainedBytes !== bytes) throw new Error('Retained body digest size is inconsistent');
      const runtime = runtimes.get(runtimeNamespace);
      const project = runtime?.projects.get(projectId);
      if (runtime === undefined || project === undefined) {
        throw new Error('Retained body budget owner is missing');
      }
      retained.delete(key);
      adjust(runtime, project, 'retainedBytes', -bytes);
      prune(runtimeNamespace, projectId);
    },

    snapshot() {
      const runtimeSnapshots: Record<string, TrafficRuntimeBudgetSnapshot> = {};
      for (const [runtimeNamespace, runtime] of runtimes) {
        const projects: Record<string, TrafficProjectBudgetSnapshot> = {};
        for (const [projectId, project] of runtime.projects) projects[projectId] = { ...project };
        runtimeSnapshots[runtimeNamespace] = {
          activeSidecars: runtime.activeSidecars,
          queuedBytes: runtime.queuedBytes,
          temporaryBytes: runtime.temporaryBytes,
          retainedBytes: runtime.retainedBytes,
          projects,
        };
      }
      return { ...processBudget, runtimes: runtimeSnapshots };
    },
  };
}
