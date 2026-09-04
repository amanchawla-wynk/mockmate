import { Router } from 'express';
import { z } from 'zod';

import type { ProjectRepository } from '../../repository/project-repository';
import { asyncHandler, parseApiInput } from '../../services/api-errors';
import { isStablePathSegment } from '../../services/storage';

const nonEmptyString = z.string().refine(value => value.trim().length > 0, 'Must not be empty');
const revision = z.number().int().nonnegative();
const idParams = z.strictObject({
  projectId: nonEmptyString,
  stateId: nonEmptyString.optional(),
});
const stableId = z.string().refine(isStablePathSegment, 'Must be a stable ID');
const bindings = z.record(stableId, stableId);
const stateCreate = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
  tags: z.array(z.string()),
  expectedUi: z.string().optional(),
  bindings,
});
const statePatch = z.strictObject({
  name: nonEmptyString.optional(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  expectedUi: z.string().nullable().optional(),
  bindings: bindings.optional(),
});
const stateUpdate = z.strictObject({ expectedRevision: revision, patch: statePatch });
const deleteInput = z.strictObject({ expectedRevision: revision });
const selection = z.strictObject({
  expectedRevision: revision,
  activeStateId: stableId.nullable().optional(),
  baseStateId: stableId.nullable().optional(),
  allowFallback: z.boolean(),
});
const appStateMode = z.strictObject({
  appStateMode: z.enum(['enabled', 'disabled']),
  expectedProjectRevision: revision,
});

export function createStatesRouter(repository: ProjectRepository): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const { projectId } = parseApiInput(idParams, req.params);
    res.json(repository.listStates(projectId));
  });

  router.post('/', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(idParams, req.params);
    res.status(201).json(await repository.createState(
      projectId,
      parseApiInput(stateCreate, req.body),
    ));
  }));

  router.get('/:stateId', (req, res) => {
    const { projectId, stateId } = parseApiInput(idParams, req.params);
    res.json(repository.getState(projectId, stateId!));
  });

  router.put('/:stateId', asyncHandler(async (req, res) => {
    const { projectId, stateId } = parseApiInput(idParams, req.params);
    const { expectedRevision, patch } = parseApiInput(stateUpdate, req.body);
    res.json(await repository.updateState(projectId, stateId!, expectedRevision, patch));
  }));

  router.delete('/:stateId', asyncHandler(async (req, res) => {
    const { projectId, stateId } = parseApiInput(idParams, req.params);
    const { expectedRevision } = parseApiInput(deleteInput, req.body);
    await repository.deleteState(projectId, stateId!, expectedRevision);
    res.status(204).send();
  }));

  return router;
}

export function mountStateSelectionRoute(router: Router, repository: ProjectRepository): void {
  router.put('/projects/:projectId/state-selection', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(idParams, req.params);
    const { expectedRevision, ...input } = parseApiInput(selection, req.body);
    res.json(await repository.setStateSelection(projectId, expectedRevision, input));
  }));

  router.put('/projects/:projectId/app-state-mode', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(idParams, req.params);
    res.json(await repository.setAppStateMode(
      projectId,
      parseApiInput(appStateMode, req.body),
    ));
  }));
}
