import { Router } from 'express';
import { z } from 'zod';
import { normalizeHttpOrigin } from '../../domain/http-origin';
import type { ProjectRepository } from '../../repository/project-repository';
import { HttpError, parseApiInput } from '../../services/api-errors';
import {
  getLocalControlHosts,
  hostMatchesPattern,
  normalizeInterceptionPatterns,
} from '../../services/intercept';

export interface InterceptionGuidanceOrigin {
  origin: string;
  hostname: string;
  source: 'endpoint' | 'import';
  coveredBy?: string;
  missing: boolean;
}

export interface InterceptionGuidance {
  configuredPatterns: string[];
  origins: InterceptionGuidanceOrigin[];
  unusedPatterns: string[];
}

const origin = z.string().min(1).max(2048);
const guidanceQuerySchema = z.strictObject({
  origin: z.union([origin, z.array(origin).max(100)]).optional()
    .transform(value => value === undefined ? [] : Array.isArray(value) ? value : [value]),
});

function normalizedOrigins(
  values: readonly string[],
  source: 'endpoint' | 'import',
  localHosts: ReadonlySet<string>,
): Array<{ origin: string; hostname: string; source: 'endpoint' | 'import' }> {
  return values.map(value => {
    const normalized = normalizeHttpOrigin(value);
    if ([...localHosts].some(local => hostMatchesPattern(local, normalized.hostname))) {
      throw new Error('Origin targets a local-control host');
    }
    return { origin: normalized.origin, hostname: normalized.hostname, source };
  });
}

export function buildInterceptionGuidance(input: {
  endpointOrigins: readonly string[];
  importOrigins: readonly string[];
  configuredPatterns: readonly string[];
}): InterceptionGuidance {
  const localHosts = getLocalControlHosts();
  const configuredPatterns = normalizeInterceptionPatterns(input.configuredPatterns, localHosts);
  const endpoints = normalizedOrigins(input.endpointOrigins, 'endpoint', localHosts);
  const imports = normalizedOrigins(input.importOrigins, 'import', localHosts);
  const byOrigin = new Map<string, (typeof endpoints)[number]>();
  for (const value of endpoints) byOrigin.set(value.origin, value);
  for (const value of imports) {
    if (!byOrigin.has(value.origin)) byOrigin.set(value.origin, value);
  }
  const origins = [...byOrigin.values()]
    .sort((left, right) => left.origin.localeCompare(right.origin))
    .map(value => {
      const coveredBy = configuredPatterns.find(pattern => hostMatchesPattern(pattern, value.hostname));
      return {
        ...value,
        ...(coveredBy === undefined ? {} : { coveredBy }),
        missing: coveredBy === undefined,
      };
    });
  const endpointHostnames = new Set(endpoints.map(value => value.hostname));
  const unusedPatterns = configuredPatterns.filter(pattern => (
    ![...endpointHostnames].some(hostname => hostMatchesPattern(pattern, hostname))
  ));
  return { configuredPatterns, origins, unusedPatterns };
}

export function createInterceptionGuidanceRouter(repository: ProjectRepository): Router {
  const router = Router({ mergeParams: true });
  router.get('/', (request, response) => {
    const { projectId } = request.params as { projectId: string };
    const { origin: importOrigins } = parseApiInput(guidanceQuerySchema, request.query);
    const sources = repository.getInterceptionGuidanceSources(projectId);
    try {
      response.json(buildInterceptionGuidance({ ...sources, importOrigins }));
    } catch {
      throw new HttpError(422, 'VALIDATION_FAILED', 'Interception guidance origins are invalid');
    }
  });
  return router;
}
