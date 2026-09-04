import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { normalizeHttpOrigin } from '../domain/http-origin';
import { parseRawQuery } from '../domain/query-matcher';
import type { MatchRequest, ResolvedMock } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';
import { HttpError } from '../services/api-errors';
import { writeResolvedResponse } from '../services/response-writer';

function matcherHeaders(req: Request): Record<string, string[]> {
  return Object.fromEntries(Object.entries(req.headers)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value : [value]]));
}

function rawQuery(req: Request): string {
  const queryIndex = req.originalUrl.indexOf('?');
  return queryIndex < 0 ? '' : req.originalUrl.slice(queryIndex + 1);
}

export function createMockRequestHandler(repository: ProjectRepository): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspace = repository.getWorkspaceState();
      if (!workspace.activeProjectId) {
        throw new HttpError(503, 'NO_ACTIVE_PROJECT', 'No active Project is selected');
      }
      const projectId = workspace.activeProjectId;
      const authority = req.get('host');
      if (!authority) throw new HttpError(400, 'REQUEST_ORIGIN_INVALID', 'Request Host header is required');
      const matchRequest: MatchRequest = {
        origin: normalizeHttpOrigin(`${req.protocol}://${authority}`),
        method: req.method,
        path: req.path,
        query: parseRawQuery(rawQuery(req)),
        headers: matcherHeaders(req),
      };
      const decision = repository.resolve(projectId, matchRequest);
      if (decision?.kind === 'mock') {
        await writeResolvedResponse(res, decision.resolved, repository, req.method);
        return;
      }
      throw new HttpError(404, 'ENDPOINT_NOT_FOUND', `No Endpoint matched ${req.method} ${req.path}`);
    } catch (error) {
      next(error);
    }
  };
}
