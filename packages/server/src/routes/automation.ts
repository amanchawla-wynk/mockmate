import { Router } from 'express';

import type { ProjectRepository } from '../repository/project-repository';
import { asyncHandler, HttpError } from '../services/api-errors';
import type { TrafficService } from '../services/traffic-service';

export function createAutomationRouter(
  repository: ProjectRepository,
  traffic: TrafficService,
): Router {
  const router = Router();

  const setFlags = asyncHandler(async (req, res) => {
    const workspace = repository.getWorkspaceState();
    const projectId = typeof req.body?.projectId === 'string'
      ? req.body.projectId
      : workspace.activeProjectId;
    if (!projectId || projectId !== workspace.activeProjectId) {
      throw new HttpError(503, 'NO_ACTIVE_PROJECT', 'No active Project is selected');
    }
    if (req.body?.clearTraffic === true) await traffic.clear(projectId);
    if (typeof req.body?.stateId === 'string') {
      const project = repository.getProject(projectId);
      await repository.setStateSelection(projectId, project.revision, {
        activeStateId: req.body.stateId,
        allowFallback: true,
      });
    }
    res.status(204).send();
  });
  router.put('/setMockServerflags', setFlags);
  router.post('/setMockServerflags', setFlags);

  router.get('/getMockServerData', (req, res) => {
    const workspace = repository.getWorkspaceState();
    if (!workspace.activeProjectId) {
      res.json({});
      return;
    }
    const lookup: Record<string, { method: string; path: string }> = {
      contentSyncApi: { method: 'POST', path: '/v5/user/content/sync' },
      downloadSyncApi: { method: 'POST', path: '/v2/user/syncDownload/sync' },
    };
    const spec = lookup[String(req.query.dataType ?? '')];
    if (!spec) {
      res.json({});
      return;
    }
    const summary = [...traffic.list(workspace.activeProjectId, { limit: 500 }).entries]
      .reverse()
      .find(entry => entry.method === spec.method && entry.path === spec.path);
    const preview = summary
      ? traffic.get(workspace.activeProjectId, summary.id)?.request.preview
      : undefined;
    if (!preview || preview.encoding === 'base64') {
      res.json({});
      return;
    }
    try {
      res.json(JSON.parse(preview.value));
    } catch {
      res.json(preview.value);
    }
  });

  router.post('/api/upload', (_req, res) => res.json({ ok: true }));
  return router;
}
