import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectRepository } from '../../repository/project-repository';
import { apiErrorMiddleware, requestIdMiddleware } from '../../services/api-errors';
import {
  buildInterceptionGuidance,
  createInterceptionGuidanceRouter,
} from './interception-guidance';

describe('buildInterceptionGuidance', () => {
  it('normalizes, deduplicates, sorts, and explains Endpoint and Import origins', () => {
    expect(buildInterceptionGuidance({
      endpointOrigins: [
        'https://api.example.test',
        'http://events.example.test:8080',
        'https://API.example.test:443/',
      ],
      importOrigins: ['https://upload.example.test', 'https://api.example.test'],
      configuredPatterns: ['*.example.test', 'unused.test'],
    })).toEqual({
      configuredPatterns: ['*.example.test', 'unused.test'],
      origins: [
        {
          origin: 'http://events.example.test:8080', hostname: 'events.example.test',
          source: 'endpoint', coveredBy: '*.example.test', missing: false,
        },
        {
          origin: 'https://api.example.test', hostname: 'api.example.test',
          source: 'endpoint', coveredBy: '*.example.test', missing: false,
        },
        {
          origin: 'https://upload.example.test', hostname: 'upload.example.test',
          source: 'import', coveredBy: '*.example.test', missing: false,
        },
      ],
      unusedPatterns: ['unused.test'],
    });
  });

  it('keeps patterns used only by ephemeral Import origins in unusedPatterns', () => {
    expect(buildInterceptionGuidance({
      endpointOrigins: ['https://api.example.test'],
      importOrigins: ['https://upload.ephemeral.test'],
      configuredPatterns: ['api.example.test', '*.ephemeral.test'],
    })).toMatchObject({
      origins: [
        expect.objectContaining({ origin: 'https://api.example.test', missing: false }),
        expect.objectContaining({
          origin: 'https://upload.ephemeral.test',
          coveredBy: '*.ephemeral.test',
          missing: false,
        }),
      ],
      unusedPatterns: ['*.ephemeral.test'],
    });
  });

  it('returns only exact hostname suggestions and rejects local/control origins', () => {
    const guidance = buildInterceptionGuidance({
      endpointOrigins: ['https://missing.example.test:8443'],
      importOrigins: [],
      configuredPatterns: [],
    });
    expect(guidance.origins.filter(value => value.missing).map(value => value.hostname))
      .toEqual(['missing.example.test']);
    expect(() => buildInterceptionGuidance({
      endpointOrigins: ['http://localhost:3000'],
      importOrigins: [],
      configuredPatterns: [],
    })).toThrow(/local-control/);
  });
});

describe('interception guidance route', () => {
  function app(sources = {
    endpointOrigins: ['https://api.example.test'],
    configuredPatterns: ['api.example.test'],
  }) {
    const getInterceptionGuidanceSources = vi.fn((projectId: string) => {
      if (projectId !== 'prj_1') throw Object.assign(new Error('missing'), { status: 404 });
      return sources;
    });
    const updateRuntimeSettings = vi.fn();
    const repository = {
      getInterceptionGuidanceSources,
      updateRuntimeSettings,
    } as unknown as ProjectRepository;
    const server = express();
    server.use(requestIdMiddleware);
    server.use(
      '/api/admin/projects/:projectId/interception-guidance',
      createInterceptionGuidanceRouter(repository),
    );
    server.use(apiErrorMiddleware);
    return { server, getInterceptionGuidanceSources, updateRuntimeSettings };
  }

  it('accepts repeated bounded origins and remains read-only', async () => {
    const owner = app();
    const response = await request(owner.server)
      .get('/api/admin/projects/prj_1/interception-guidance')
      .query({ origin: ['https://upload.example.test', 'http://events.example.test:8080'] })
      .expect(200);

    expect(response.body.origins).toEqual([
      expect.objectContaining({ origin: 'http://events.example.test:8080', source: 'import' }),
      expect.objectContaining({ origin: 'https://api.example.test', source: 'endpoint' }),
      expect.objectContaining({ origin: 'https://upload.example.test', source: 'import' }),
    ]);
    expect(owner.getInterceptionGuidanceSources).toHaveBeenCalledWith('prj_1');
    expect(owner.updateRuntimeSettings).not.toHaveBeenCalled();
  });

  it.each([
    '?unknown=value',
    `?origin=${encodeURIComponent('https://example.test/'.padEnd(2050, 'x'))}`,
  ])('rejects strict or over-bound query input: %s', async suffix => {
    await request(app().server)
      .get(`/api/admin/projects/prj_1/interception-guidance${suffix}`)
      .expect(422);
  });
});
