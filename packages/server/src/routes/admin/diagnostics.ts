import { Router } from 'express';
import { z } from 'zod';

import type { ProjectRepository } from '../../repository/project-repository';
import { parseApiInput } from '../../services/api-errors';

const projectParams = z.strictObject({ projectId: z.string().min(1) });

export function createDiagnosticsRouter(repository: ProjectRepository): Router {
  const router = Router({ mergeParams: true });

  router.get('/diagnostics', (_req, res) => {
    res.json({ diagnostics: repository.listAllDiagnostics() });
  });

  router.get('/projects/:projectId/diagnostics', (req, res) => {
    const { projectId } = parseApiInput(projectParams, req.params);
    const diagnostics = repository.listDiagnostics(projectId);
    if (diagnostics.length === 0) repository.getProject(projectId);
    res.json({ projectId, diagnostics });
  });

  return router;
}
