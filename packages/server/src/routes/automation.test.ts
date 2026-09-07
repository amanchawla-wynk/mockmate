import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectRepository } from '../repository/project-repository';
import type { TrafficService } from '../services/traffic-service';
import { createAutomationRouter } from './automation';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

function appFor(repository: ProjectRepository, traffic: TrafficService) {
  const app = express();
  app.use(express.json());
  app.use(createAutomationRouter(repository, traffic));
  return app;
}

describe('automation Traffic integration', () => {
  it('activates the requested App State through the atomic selection write', async () => {
    const setStateSelection = vi.fn().mockResolvedValue({});
    const repository = {
      getWorkspaceState: () => ({ activeProjectId: 'prj_1' }),
      getProject: () => ({ id: 'prj_1', revision: 7, appStateMode: 'disabled' }),
      setStateSelection,
    } as unknown as ProjectRepository;
    const traffic = { clear: vi.fn() } as unknown as TrafficService;

    await request(appFor(repository, traffic))
      .post('/setMockServerflags')
      .send({ projectId: 'prj_1', stateId: 'state_1' })
      .expect(204);

    expect(setStateSelection).toHaveBeenCalledWith('prj_1', 7, { activeStateId: 'state_1' });
  });

  it('awaits the Project-owned Traffic clear before responding', async () => {
    const clearing = deferred();
    const traffic = {
      clear: vi.fn(() => clearing.promise),
    } as unknown as TrafficService;
    const repository = {
      getWorkspaceState: () => ({ activeProjectId: 'prj_1' }),
    } as unknown as ProjectRepository;

    let settled = false;
    const response = request(appFor(repository, traffic))
      .put('/setMockServerflags')
      .send({ projectId: 'prj_1', clearTraffic: true })
      .then(result => {
        settled = true;
        return result;
      });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(traffic.clear).toHaveBeenCalledWith('prj_1');
    expect(settled).toBe(false);
    clearing.resolve();
    expect((await response).status).toBe(204);
  });

  it('reads only bounded canonical Traffic list and detail previews', async () => {
    const traffic = {
      list: vi.fn(() => ({
        entries: [{ id: 'traffic_1', method: 'POST', path: '/v5/user/content/sync' }],
        hasMore: false,
      })),
      get: vi.fn(() => ({
        request: { preview: { encoding: 'utf8', value: '{"bounded":true}', truncated: false } },
      })),
    } as unknown as TrafficService;
    const repository = {
      getWorkspaceState: () => ({ activeProjectId: 'prj_1' }),
    } as unknown as ProjectRepository;

    const response = await request(appFor(repository, traffic))
      .get('/getMockServerData?dataType=contentSyncApi')
      .expect(200);

    expect(response.body).toEqual({ bounded: true });
    expect(traffic.list).toHaveBeenCalledWith('prj_1', { limit: 500 });
    expect(traffic.get).toHaveBeenCalledWith('prj_1', 'traffic_1');
  });
});
