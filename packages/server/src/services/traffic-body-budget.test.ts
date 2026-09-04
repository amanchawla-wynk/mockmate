import { describe, expect, it } from 'vitest';

import { TRAFFIC_LIMITS } from '../domain/traffic';
import {
  createTrafficBodyBudgetManager,
  type TrafficBodyBudgetManager,
  type TrafficBodyBudgetReservation,
} from './traffic-body-budget';

const limits = {
  ...TRAFFIC_LIMITS,
  projectActiveSidecars: 1,
  processActiveSidecars: 2,
  projectQueuedBytes: 8,
  processQueuedBytes: 12,
  projectTemporaryBytes: 16,
  processTemporaryBytes: 24,
  projectRetainedBytes: 20,
  processRetainedBytes: 30,
};

function accepted(
  budgets: TrafficBodyBudgetManager,
  runtimeNamespace: string,
  projectId: string,
  queueBytes = 0,
  temporaryBytes = 0,
): TrafficBodyBudgetReservation {
  const result = budgets.reserveSidecar(
    runtimeNamespace,
    projectId,
    queueBytes,
    temporaryBytes,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected reservation, received ${result.reason}`);
  return result.reservation;
}

describe('Traffic body budgets', () => {
  it('enforces Project and process active-sidecar limits at exact boundaries', () => {
    const budgets = createTrafficBodyBudgetManager(limits);
    const first = accepted(budgets, 'runtime_a', 'prj_a');

    expect(budgets.reserveSidecar('runtime_a', 'prj_a', 0, 0))
      .toEqual({ ok: false, reason: 'sidecar_limit' });
    const second = accepted(budgets, 'runtime_a', 'prj_b');
    expect(budgets.reserveSidecar('runtime_b', 'prj_c', 0, 0))
      .toEqual({ ok: false, reason: 'sidecar_limit' });

    first.release();
    second.release();
    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });

  it('enforces Project and process queue limits on admission and growth', () => {
    const budgets = createTrafficBodyBudgetManager({
      ...limits,
      projectActiveSidecars: 4,
      processActiveSidecars: 8,
    });
    const projectFull = accepted(budgets, 'runtime_a', 'prj_a', 8);
    expect(budgets.reserveSidecar('runtime_a', 'prj_a', 1, 0))
      .toEqual({ ok: false, reason: 'queue_saturated' });

    const processFull = accepted(budgets, 'runtime_a', 'prj_b', 4);
    expect(budgets.reserveSidecar('runtime_b', 'prj_c', 1, 0))
      .toEqual({ ok: false, reason: 'queue_saturated' });
    expect(projectFull.growQueued(1)).toBe(false);

    projectFull.releaseQueued(1);
    expect(projectFull.growQueued(1)).toBe(true);
    projectFull.releaseQueued(9);
    projectFull.releaseQueued(9);
    projectFull.release();
    processFull.release();
    expect(budgets.snapshot().queuedBytes).toBe(0);
  });

  it('enforces Project and process temporary limits on admission and growth', () => {
    const budgets = createTrafficBodyBudgetManager({
      ...limits,
      projectActiveSidecars: 4,
      processActiveSidecars: 8,
    });
    const projectFull = accepted(budgets, 'runtime_a', 'prj_a', 0, 16);
    expect(budgets.reserveSidecar('runtime_a', 'prj_a', 0, 1))
      .toEqual({ ok: false, reason: 'temporary_budget_exceeded' });

    const processFull = accepted(budgets, 'runtime_a', 'prj_b', 0, 8);
    expect(budgets.reserveSidecar('runtime_b', 'prj_c', 0, 1))
      .toEqual({ ok: false, reason: 'temporary_budget_exceeded' });
    expect(projectFull.growTemporary(1)).toBe(false);

    processFull.release();
    expect(projectFull.growTemporary(1)).toBe(false);
    projectFull.release();
    expect(budgets.snapshot().temporaryBytes).toBe(0);
  });

  it('counts retained bytes once per runtime, Project, and digest', () => {
    const budgets = createTrafficBodyBudgetManager(limits);
    const first = accepted(budgets, 'runtime_a', 'prj_1', 0, 6);
    expect(first.convertTemporaryToRetained('a'.repeat(64), 6)).toEqual({
      ok: true,
      physicalBytesAdded: true,
    });
    first.release();

    const duplicate = accepted(budgets, 'runtime_a', 'prj_1', 0, 6);
    expect(duplicate.convertTemporaryToRetained('a'.repeat(64), 6)).toEqual({
      ok: true,
      physicalBytesAdded: false,
    });
    duplicate.release();

    const otherRuntime = accepted(budgets, 'runtime_b', 'prj_1', 0, 6);
    expect(otherRuntime.convertTemporaryToRetained('a'.repeat(64), 6)).toEqual({
      ok: true,
      physicalBytesAdded: true,
    });
    otherRuntime.release();

    expect(budgets.snapshot()).toMatchObject({
      retainedBytes: 12,
      runtimes: {
        runtime_a: { retainedBytes: 6, projects: { prj_1: { retainedBytes: 6 } } },
        runtime_b: { retainedBytes: 6, projects: { prj_1: { retainedBytes: 6 } } },
      },
    });

    budgets.releaseRetained('runtime_a', 'prj_1', 'a'.repeat(64), 6);
    budgets.releaseRetained('runtime_a', 'prj_1', 'a'.repeat(64), 6);
    expect(budgets.snapshot()).toMatchObject({
      retainedBytes: 6,
      runtimes: {
        runtime_b: { retainedBytes: 6 },
      },
    });
    expect(budgets.snapshot().runtimes).not.toHaveProperty('runtime_a');

    budgets.releaseRetained('runtime_b', 'prj_1', 'a'.repeat(64), 6);
    expect(budgets.snapshot().runtimes).toEqual({});
  });

  it('rejects Project and process retained growth without evicting another Project', () => {
    const budgets = createTrafficBodyBudgetManager({
      ...limits,
      projectActiveSidecars: 4,
      processActiveSidecars: 8,
      projectTemporaryBytes: 40,
      processTemporaryBytes: 80,
    });
    const projectFull = accepted(budgets, 'runtime_a', 'prj_a', 0, 20);
    expect(projectFull.convertTemporaryToRetained('a'.repeat(64), 20)).toEqual({
      ok: true,
      physicalBytesAdded: true,
    });
    projectFull.release();

    const projectRejected = accepted(budgets, 'runtime_a', 'prj_a', 0, 1);
    expect(projectRejected.convertTemporaryToRetained('b'.repeat(64), 1))
      .toEqual({ ok: false, reason: 'retained_budget_exceeded' });
    projectRejected.release();

    const foreign = accepted(budgets, 'runtime_a', 'prj_b', 0, 10);
    expect(foreign.convertTemporaryToRetained('c'.repeat(64), 10)).toEqual({
      ok: true,
      physicalBytesAdded: true,
    });
    foreign.release();

    const processRejected = accepted(budgets, 'runtime_b', 'prj_c', 0, 1);
    expect(processRejected.convertTemporaryToRetained('d'.repeat(64), 1))
      .toEqual({ ok: false, reason: 'retained_budget_exceeded' });
    processRejected.release();

    expect(budgets.snapshot()).toMatchObject({
      retainedBytes: 30,
      runtimes: {
        runtime_a: {
          retainedBytes: 30,
          projects: {
            prj_a: { retainedBytes: 20 },
            prj_b: { retainedBytes: 10 },
          },
        },
      },
    });
  });

  it('settles every reservation exactly once when release paths race', () => {
    const budgets = createTrafficBodyBudgetManager(limits);
    const reservation = accepted(budgets, 'runtime_a', 'prj_a', 8, 16);

    reservation.releaseQueued(3);
    reservation.releaseQueued(3);
    reservation.release();
    reservation.release();
    reservation.releaseQueued(8);
    expect(reservation.growQueued(1)).toBe(false);
    expect(reservation.growTemporary(1)).toBe(false);

    expect(budgets.snapshot()).toEqual({
      activeSidecars: 0,
      queuedBytes: 0,
      temporaryBytes: 0,
      retainedBytes: 0,
      runtimes: {},
    });
  });
});
