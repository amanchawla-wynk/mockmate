import { Router } from 'express';
import { z } from 'zod';

import { MAX_EDITABLE_BODY_BYTES } from '../../repository/body-store';
import type { ProjectRepository } from '../../repository/project-repository';
import { asyncHandler, parseApiInput } from '../../services/api-errors';

const params = z.strictObject({
  projectId: z.string().min(1),
  assetId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

function isSafeMediaType(value: string): boolean {
  if (![...value].every(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  })) return false;
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*.+)?$/.test(value);
}

const mediaType = z.string().refine(
  isSafeMediaType,
  'Content-Type must be a safe media type',
);
const encoding = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const uploadMetadata = z.strictObject({
  mediaType,
  encoding: encoding.optional(),
});

export function createBodiesRouter(repository: ProjectRepository): Router {
  const router = Router({ mergeParams: true });

  router.post('/', asyncHandler(async (req, res) => {
    const { projectId } = parseApiInput(params, req.params);
    const metadata = parseApiInput(uploadMetadata, {
      mediaType: req.get('Content-Type'),
      encoding: req.get('X-MockMate-Encoding'),
    });
    const asset = await repository.putBody(
      projectId,
      req,
      metadata,
      { maxBytes: MAX_EDITABLE_BODY_BYTES },
    );
    res.status(201).json(asset);
  }));

  router.get('/:assetId', asyncHandler(async (req, res, next) => {
    const { projectId, assetId } = parseApiInput(params, req.params);
    const asset = await repository.getBody(projectId, assetId!);
    const source = repository.openBody(projectId, assetId!);
    let lifecycle: 'active' | 'settling' | 'settled' = 'active';
    const removeResponseListeners = () => {
      res.off('close', responseClosed);
      res.off('finish', responseFinished);
    };
    const settle = () => {
      if (lifecycle === 'settled') return;
      lifecycle = 'settled';
      removeResponseListeners();
      source.removeListener('error', streamError);
      source.removeListener('close', sourceClosed);
    };
    const sourceClosed = () => settle();
    const stopSource = (): boolean => {
      try {
        if ('destroy' in source && typeof source.destroy === 'function') {
          source.destroy();
          return true;
        }
        if ('close' in source && typeof source.close === 'function') {
          source.close();
          return true;
        }
      } catch {
        settle();
      }
      return false;
    };
    const beginTeardown = () => {
      if (lifecycle !== 'active') return;
      lifecycle = 'settling';
      removeResponseListeners();
      source.unpipe(res);
      if (!stopSource()) settle();
    };
    const responseClosed = () => beginTeardown();
    const responseFinished = () => {
      if (lifecycle !== 'active') return;
      removeResponseListeners();
      if ('destroyed' in source && source.destroyed) {
        lifecycle = 'settling';
      } else {
        settle();
      }
    };
    const streamError = (error: Error) => {
      if (lifecycle !== 'active') return;
      beginTeardown();
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Encoding');
        next(error);
      }
    };
    res.once('close', responseClosed);
    res.once('finish', responseFinished);
    source.on('error', streamError);
    source.once('close', sourceClosed);
    res.setHeader('Content-Type', asset.mediaType);
    res.setHeader('Content-Length', String(asset.size));
    if (asset.encoding !== undefined) res.setHeader('Content-Encoding', asset.encoding);
    source.pipe(res);
  }));

  return router;
}
