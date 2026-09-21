import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Router } from 'express';
import { z } from 'zod';

import {
  ContentEncodingDecodeError,
  decodeEntityStream,
} from '../../domain/content-encoding-decode';
import { TRAFFIC_LIMITS } from '../../domain/traffic';
import type { ProjectRepository } from '../../repository/project-repository';
import { asyncHandler, HttpError, parseApiInput } from '../../services/api-errors';
import type { TrafficSearchService } from '../../services/traffic-search';
import type { TrafficService } from '../../services/traffic-service';

const trafficQuerySchema = z.strictObject({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(1000)).optional(),
  afterId: z.string().min(1).optional(),
  beforeId: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.afterId !== undefined && value.beforeId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'afterId and beforeId cannot be provided together',
    });
  }
});

const searchQuerySchema = z.strictObject({
  q: z.string().min(1),
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(100)).optional(),
  cursor: z.string().min(1).optional(),
});

const promotionInputSchema = z.strictObject({
  expectedTrafficGeneration: z.string().min(1),
  expectedResponseIdentity: z.string().min(1),
  endpoint: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('create') }),
    z.strictObject({
      action: z.literal('reuse'),
      endpointId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
    }),
  ]),
  state: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('unbound') }),
    z.strictObject({
      action: z.literal('bind'),
      stateId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
    }),
  ]),
});

function trafficNotFound(): HttpError {
  return new HttpError(404, 'TRAFFIC_NOT_FOUND', 'Traffic entry was not found');
}

function requireProject(repository: ProjectRepository, projectId: string): void {
  try {
    repository.getProject(projectId);
  } catch {
    throw trafficNotFound();
  }
}

/**
 * Cancels owned work when the client goes away. `IncomingMessage`'s `aborted`
 * event is deprecated and does not fire for ordinary disconnects, so ownership
 * follows response `close` before the response finished writing.
 */
function requestAbortSignal(
  request: { socket?: { destroyed?: boolean } },
  response: {
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
    writableEnded: boolean;
  },
): AbortSignal {
  const controller = new AbortController();
  const closed = () => {
    if (!response.writableEnded) controller.abort();
    response.off('close', closed);
  };
  response.once('close', closed);
  if (request.socket?.destroyed === true) controller.abort();
  return controller.signal;
}

export function createTrafficRouter(
  repository: ProjectRepository,
  traffic: TrafficService,
  search: TrafficSearchService,
): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (request, response) => {
    const projectId = (request.params as { projectId: string }).projectId;
    requireProject(repository, projectId);
    response.json(traffic.list(projectId, parseApiInput(trafficQuerySchema, request.query)));
  });

  router.get('/search', asyncHandler(async (request, response) => {
    const projectId = (request.params as { projectId: string }).projectId;
    requireProject(repository, projectId);
    const input = parseApiInput(searchQuerySchema, request.query);
    response.json(await search.search(
      projectId,
      { query: input.q, limit: input.limit ?? 100, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
      requestAbortSignal(request, response),
    ));
  }));

  router.delete('/search/:searchSessionId', (request, response) => {
    const { projectId, searchSessionId } = request.params as {
      projectId: string;
      searchSessionId: string;
    };
    requireProject(repository, projectId);
    search.deleteSession(projectId, searchSessionId);
    response.status(204).send();
  });

  router.get('/:trafficId', (request, response) => {
    const { projectId, trafficId } = request.params as { projectId: string; trafficId: string };
    requireProject(repository, projectId);
    const detail = traffic.get(projectId, trafficId);
    if (detail === undefined) throw trafficNotFound();
    response.json(detail);
  });

  router.delete('/', asyncHandler(async (request, response) => {
    const projectId = (request.params as { projectId: string }).projectId;
    requireProject(repository, projectId);
    search.clearProject(projectId);
    await traffic.clear(projectId);
    response.status(204).send();
  }));

  router.get('/:trafficId/bodies/:side', asyncHandler(async (request, response) => {
    const { projectId, trafficId, side } = request.params as {
      projectId: string;
      trafficId: string;
      side: string;
    };
    requireProject(repository, projectId);
    if (side !== 'request' && side !== 'response') throw trafficNotFound();

    const viewDecoded = request.query.view === 'decoded';
    const download = request.query.download === '1';
    if (viewDecoded && download) {
      throw new HttpError(
        400,
        'TRAFFIC_BODY_VIEW_INVALID',
        'Decoded view cannot be combined with download',
      );
    }

    const { descriptor, lease } = await traffic.openBody(projectId, trafficId, side);
    let releasePromise: Promise<void> | undefined;
    const release = () => {
      releasePromise ??= lease.release();
      return releasePromise;
    };
    const releaseOnSettlement = () => { void release(); };
    request.once('aborted', releaseOnSettlement);
    response.once('finish', releaseOnSettlement);
    response.once('close', releaseOnSettlement);
    try {
      if (viewDecoded) {
        if (descriptor.contentEncoding === undefined) {
          throw new HttpError(
            400,
            'TRAFFIC_BODY_NOT_ENCODED',
            'Decoded view requires a Content-Encoding on the retained body',
          );
        }
        let decoded: { bytes: Buffer; sha256: string };
        try {
          decoded = await decodeEntityStream(
            lease.openStream() as Readable,
            descriptor.contentEncoding,
            TRAFFIC_LIMITS.bodyBytes,
          );
        } catch (error) {
          if (error instanceof ContentEncodingDecodeError) {
            throw new HttpError(
              409,
              'TRAFFIC_BODY_DECODE_FAILED',
              error.message,
            );
          }
          throw error;
        }
        response.setHeader('Content-Type', descriptor.mediaType ?? 'application/octet-stream');
        response.setHeader('Content-Length', String(decoded.bytes.byteLength));
        response.setHeader('X-MockMate-View', 'decoded');
        response.setHeader('X-MockMate-Decoded-Sha256', decoded.sha256);
        response.setHeader('X-MockMate-Original-Content-Encoding', descriptor.contentEncoding);
        await pipeline(Readable.from([decoded.bytes]), response);
        return;
      }

      response.setHeader('Content-Type', descriptor.mediaType ?? 'application/octet-stream');
      response.setHeader('Content-Length', String(descriptor.retainedSize));
      response.setHeader('X-MockMate-Sha256', descriptor.sha256);
      if (descriptor.contentEncoding !== undefined) {
        response.setHeader('X-MockMate-Original-Content-Encoding', descriptor.contentEncoding);
      }
      if (download) response.setHeader('Content-Disposition', 'attachment');
      await pipeline(lease.openStream() as Readable, response);
    } finally {
      request.off('aborted', releaseOnSettlement);
      response.off('finish', releaseOnSettlement);
      response.off('close', releaseOnSettlement);
      await release();
    }
  }));

  router.post('/:trafficId/mock', asyncHandler(async (request, response) => {
    const { projectId, trafficId } = request.params as { projectId: string; trafficId: string };
    requireProject(repository, projectId);
    const input = parseApiInput(promotionInputSchema, request.body ?? {});
    response.status(200).json(await traffic.promoter.promote(projectId, trafficId, input));
  }));

  return router;
}
