import { Readable } from 'node:stream';

import express, { Router, type RequestHandler } from 'express';

import type { ProjectRepository } from '../repository/project-repository';
import { asyncHandler, HttpError } from '../services/api-errors';
import { writeOwnedStream } from '../services/response-writer';

const MAX_STATIC_BYTES = 50 * 1024 * 1024;

const requireIdentityContentEncoding: RequestHandler = (req, _res, next) => {
  const contentEncoding = req.get('Content-Encoding');
  if (contentEncoding && contentEncoding.trim().toLowerCase() !== 'identity') {
    next(new HttpError(
      415,
      'STATIC_CONTENT_ENCODING_UNSUPPORTED',
      'Static uploads require an absent or identity Content-Encoding',
    ));
    return;
  }
  next();
};

export function createStaticFilesRouter(
  repository: ProjectRepository,
  getDeliveryBaseUrl: () => string,
): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    res.json({
      files: repository.listStaticFiles((req.params as { projectId: string }).projectId),
      baseUrl: getDeliveryBaseUrl(),
    });
  });

  router.post(
    '/',
    requireIdentityContentEncoding,
    express.raw({ type: () => true, limit: '50mb', inflate: false }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(400, 'STATIC_BODY_REQUIRED', 'Static upload body must be raw bytes');
      }
      const file = await repository.putStaticFile(
        (req.params as { projectId: string }).projectId,
        String(req.query.path ?? ''),
        Readable.from(req.body),
        { mediaType: req.get('Content-Type') ?? 'application/octet-stream', maxBytes: MAX_STATIC_BYTES },
      );
      res.status(201).json({ ok: true, file });
    }),
  );

  router.delete('/', asyncHandler(async (req, res) => {
    await repository.deleteStaticFile(
      (req.params as { projectId: string }).projectId,
      String(req.query.path ?? ''),
    );
    res.status(204).send();
  }));

  return router;
}

export function createStaticDeliveryRouter(repository: ProjectRepository): Router {
  const router = Router();
  router.get('/*', asyncHandler(async (req, res) => {
    const workspace = repository.getWorkspaceState();
    if (!workspace.activeProjectId) {
      throw new HttpError(503, 'NO_ACTIVE_PROJECT', 'No active Project is selected');
    }
    const relativePath = req.params[0];
    const metadata = repository.listStaticFiles(workspace.activeProjectId)
      .find(file => file.path === relativePath);
    if (!metadata) throw new HttpError(404, 'STATIC_FILE_NOT_FOUND', 'Static file was not found');
    const source = repository.openStaticFile(workspace.activeProjectId, relativePath);
    res.setHeader('Content-Type', metadata.mediaType);
    res.setHeader('Content-Length', String(metadata.size));
    await writeOwnedStream(res, source);
  }));
  return router;
}
