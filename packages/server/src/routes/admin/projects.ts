import { Router } from 'express';
import { z } from 'zod';

import type { ProjectRepository } from '../../repository/project-repository';
import { asyncHandler, HttpError, parseApiInput } from '../../services/api-errors';
import { normalizeInterceptionPatterns } from '../../services/intercept';

const nonEmptyString = z.string().refine(value => value.trim().length > 0, 'Must not be empty');
const revision = z.number().int().nonnegative();
const projectIdParams = z.strictObject({ projectId: nonEmptyString });

const createProjectSchema = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
});

const projectPatchSchema = z.strictObject({
  name: nonEmptyString.optional(),
  description: z.string().nullable().optional(),
});

const updateProjectSchema = z.strictObject({
  expectedRevision: revision,
  patch: projectPatchSchema,
});

const deleteProjectSchema = z.strictObject({ expectedRevision: revision });

const workspaceUpdateSchema = z.strictObject({
  expectedRevision: revision,
  activeProjectId: nonEmptyString.nullable(),
});

const runtimeSettingsUpdateSchema = z.strictObject({
  interceptHosts: z.array(nonEmptyString),
  captureRawTraffic: z.boolean(),
  debugProvenanceHeaders: z.boolean(),
  expectedRevision: revision,
  confirmInterceptAll: z.literal(true).optional(),
});

export function createProjectsRouter(
  repository: ProjectRepository,
  localControlHosts: ReadonlySet<string>,
): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (_req, res) => {
    res.json(repository.listProjects());
  });

  router.post('/', asyncHandler(async (req, res) => {
    const input = parseApiInput(createProjectSchema, req.body);
    res.status(201).json(await repository.createProject(input));
  }));

  router.get('/:projectId', (req, res) => {
    const { projectId } = parseApiInput(projectIdParams, req.params);
    res.json(repository.getProject(projectId));
  });

  router.put('/:projectId', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(projectIdParams, req.params);
    const { expectedRevision, patch } = parseApiInput(updateProjectSchema, req.body);
    res.json(await repository.updateProject(projectId, expectedRevision, patch));
  }));

  router.delete('/:projectId', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(projectIdParams, req.params);
    const { expectedRevision } = parseApiInput(deleteProjectSchema, req.body);
    await repository.deleteProject(projectId, expectedRevision);
    res.status(204).send();
  }));

  router.get('/:projectId/runtime-settings', (req, res) => {
    const { projectId } = parseApiInput(projectIdParams, req.params);
    res.json(repository.getRuntimeSettings(projectId));
  });

  router.put('/:projectId/runtime-settings', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(projectIdParams, req.params);
    const input = parseApiInput(runtimeSettingsUpdateSchema, req.body);
    let interceptHosts: string[];
    try {
      interceptHosts = normalizeInterceptionPatterns(input.interceptHosts, localControlHosts);
    } catch {
      throw new HttpError(422, 'VALIDATION_FAILED', 'Interception patterns are invalid');
    }
    if (interceptHosts.includes('*') && input.confirmInterceptAll !== true) {
      throw new HttpError(
        422,
        'INTERCEPT_ALL_CONFIRMATION_REQUIRED',
        'Intercepting all hosts requires explicit confirmation',
      );
    }
    res.json(await repository.updateRuntimeSettings(projectId, {
      ...input,
      interceptHosts,
    }));
  }));

  return router;
}

export function mountWorkspaceRoutes(router: Router, repository: ProjectRepository): void {
  router.get('/workspace', (_req, res) => {
    res.json(repository.getWorkspaceState());
  });

  router.put('/workspace', asyncHandler(async (req, res) => {
    const { expectedRevision, activeProjectId } = parseApiInput(workspaceUpdateSchema, req.body);
    res.json(await repository.setActiveProject(activeProjectId, expectedRevision));
  }));
}
