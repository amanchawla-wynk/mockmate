import express, { Router } from 'express';

import type { ProjectRepository } from '../repository/project-repository';
import type { TrafficService } from '../services/traffic-service';
import { createStaticFilesRouter } from './static-files';
import { createBodiesRouter } from './admin/bodies';
import { createDiagnosticsRouter } from './admin/diagnostics';
import { createEndpointsRouter } from './admin/endpoints';
import { createImportsRouter } from './admin/imports';
import { createInterceptionGuidanceRouter } from './admin/interception-guidance';
import { createProjectsRouter, mountWorkspaceRoutes } from './admin/projects';
import { createStatesRouter, mountStateSelectionRoute } from './admin/states';
import { createTrafficRouter } from './admin/traffic';

export function createAdminRouter(
  repository: ProjectRepository,
  localControlHosts: ReadonlySet<string>,
  traffic: TrafficService,
): Router {
  const router = Router();

  router.use('/projects/:projectId/bodies', createBodiesRouter(repository));
  router.use('/projects/:projectId/static-files', createStaticFilesRouter(repository));
  router.use(express.json({ limit: '12mb' }));

  mountWorkspaceRoutes(router, repository);
  mountStateSelectionRoute(router, repository);
  router.use(createDiagnosticsRouter(repository));
  router.use('/projects', createProjectsRouter(repository, localControlHosts));
  router.use('/projects/:projectId/endpoints', createEndpointsRouter(repository));
  router.use('/projects/:projectId/states', createStatesRouter(repository));
  router.use(
    '/projects/:projectId/interception-guidance',
    createInterceptionGuidanceRouter(repository),
  );
  router.use('/projects/:projectId/traffic', createTrafficRouter(repository, traffic));
  router.use('/projects/:projectId/import', createImportsRouter(repository));

  return router;
}
