import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app';
import {
  createProject,
  deleteProject,
  setActiveProject,
  updateProject
} from './services/projects';
import {
  createResource,
  addScenario,
  updateScenario
} from './services/resources';
import { clearLogEntries } from './services/logger';
import type { Application } from 'express';

describe('MockMate HTTP Server Integration Tests', () => {
  let app: Application;
  let projectId: string;

  beforeEach(() => {
    app = createApp();
    clearLogEntries();

    // Create a test project and set it as active
    const project = createProject({
      name: 'Test Project ' + Date.now(),
      description: 'Integration test project',
    });
    projectId = project.id;
    setActiveProject(projectId);
  });

  afterEach(() => {
    try {
      deleteProject(projectId);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers in responses', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle OPTIONS preflight requests', async () => {
      const response = await request(app).options('/api/test');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  describe('Mock API Handler', () => {
    it('should return 503 when no active project', async () => {
      // Delete the project to clear active project
      deleteProject(projectId);

      // Create new app - it will have no active project
      const newApp = createApp();

      const response = await request(newApp).get('/api/users');

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('No active project');

      // Recreate project for other tests
      const project = createProject({
        name: 'Test Project ' + Date.now(),
        description: 'Integration test project',
      });
      projectId = project.id;
      setActiveProject(projectId);
    });

    it('should return 404 for unmatched routes', async () => {
      const response = await request(app).get('/api/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
      expect(response.body.message).toContain('No mock resource found');
    });

    it('should return mock response for matched resource', async () => {
      // Create a test resource
      createResource(projectId, {
        method: 'GET',
        path: '/api/users',
        description: 'Get users',
      });

      const response = await request(app).get('/api/users');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toEqual({});
    });

    it('should match path parameters', async () => {
      createResource(projectId, {
        method: 'GET',
        path: '/api/users/:id',
      });

      const response = await request(app).get('/api/users/123');

      expect(response.status).toBe(200);
    });

    it('should differentiate between HTTP methods', async () => {
      createResource(projectId, {
        method: 'GET',
        path: '/api/users',
      });

      createResource(projectId, {
        method: 'POST',
        path: '/api/users',
      });

      const getResponse = await request(app).get('/api/users');
      const postResponse = await request(app).post('/api/users');

      expect(getResponse.status).toBe(200);
      expect(postResponse.status).toBe(200);
    });
  });

  describe('Scenario Selection', () => {
    let resourceId: string;

    beforeEach(() => {
      const resource = createResource(projectId, {
        method: 'GET',
        path: '/api/test',
      });
      resourceId = resource.id;

      // Update resource with multiple scenarios
      addScenario(projectId, resource.id, {
        name: 'empty',
        statusCode: 200,
        body: [],
      });
      addScenario(projectId, resource.id, {
        name: 'error',
        statusCode: 500,
        body: { error: 'Server error' },
      });
    });

    it('should use default scenario by default', async () => {
      const response = await request(app).get('/api/test');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should use header-specified scenario', async () => {
      const response = await request(app)
        .get('/api/test')
        .set('X-MockMate-Scenario', 'error');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Server error');
    });

    it('should prioritize header scenario over active scenario', async () => {
      // Set active scenario to 'empty'
      updateProject(projectId, { activeScenario: 'empty' });

      // Request with header scenario 'error'
      const response = await request(app)
        .get('/api/test')
        .set('X-MockMate-Scenario', 'error');

      expect(response.status).toBe(500);
    });

    it('should fallback to default when scenario not found', async () => {
      const response = await request(app)
        .get('/api/test')
        .set('X-MockMate-Scenario', 'nonexistent');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });
  });

  describe('Delay Simulation', () => {
    it('should apply delay before responding', async () => {
      const resource = createResource(projectId, {
        method: 'GET',
        path: '/api/slow',
      });

      updateScenario(projectId, resource.id, 'default', {
        delay: 100,
      });

      const startTime = Date.now();
      const response = await request(app).get('/api/slow');
      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(duration).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Custom Headers', () => {
    it('should include custom headers in response', async () => {
      const resource = createResource(projectId, {
        method: 'GET',
        path: '/api/custom',
      });

      updateScenario(projectId, resource.id, 'default', {
        headers: {
          'X-Custom-Header': 'test-value',
          'X-Rate-Limit': '100',
        },
      });

      const response = await request(app).get('/api/custom');

      expect(response.headers['x-custom-header']).toBe('test-value');
      expect(response.headers['x-rate-limit']).toBe('100');
    });

    it('should allow overriding Content-Type', async () => {
      const resource = createResource(projectId, {
        method: 'GET',
        path: '/api/text',
      });

      updateScenario(projectId, resource.id, 'default', {
        body: 'Plain text response',
        headers: {
          'Content-Type': 'text/plain',
        },
      });

      const response = await request(app).get('/api/text');

      expect(response.headers['content-type']).toContain('text/plain');
    });
  });

  describe('Request Logging', () => {
    it('should log successful requests', async () => {
      createResource(projectId, {
        method: 'GET',
        path: '/api/logged',
      });

      await request(app).get('/api/logged');

      const logsResponse = await request(app).get('/api/admin/logs');

      expect(logsResponse.status).toBe(200);
      expect(logsResponse.body).toBeInstanceOf(Array);
      expect(logsResponse.body.length).toBeGreaterThan(0);

      const log = logsResponse.body[0];
      expect(log.method).toBe('GET');
      expect(log.path).toBe('/api/logged');
      expect(log.statusCode).toBe(200);
      expect(log.duration).toBeDefined();
      expect(log.scenario).toBe('default');
    });

    it('should log 404 for unmatched routes', async () => {
      await request(app).get('/api/notfound');

      const logsResponse = await request(app).get('/api/admin/logs');
      const log = logsResponse.body[0];

      expect(log.statusCode).toBe(404);
    });

    it('should track header-based scenario selection', async () => {
      const resource = createResource(projectId, {
        method: 'GET',
        path: '/api/header-test',
      });

      addScenario(projectId, resource.id, {
        name: 'custom',
        statusCode: 200,
        body: { test: true },
      });

      await request(app)
        .get('/api/header-test')
        .set('X-MockMate-Scenario', 'custom');

      const logsResponse = await request(app).get('/api/admin/logs');
      const log = logsResponse.body[0];

      expect(log.scenario).toBe('custom');
      expect(log.scenarioFromHeader).toBe(true);
    });

    it('should clear logs', async () => {
      createResource(projectId, {
        method: 'GET',
        path: '/api/test',
      });

      await request(app).get('/api/test');

      let logsResponse = await request(app).get('/api/admin/logs');
      expect(logsResponse.body.length).toBeGreaterThan(0);

      await request(app).delete('/api/admin/logs');

      logsResponse = await request(app).get('/api/admin/logs');
      expect(logsResponse.body.length).toBe(0);
    });
  });

  describe('Admin API', () => {
    it('should return server status', async () => {
      const response = await request(app).get('/api/admin/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('running');
      expect(response.body.activeProject).toBeDefined();
      expect(response.body.activeProject.id).toBe(projectId);
    });

    it('should list projects', async () => {
      const response = await request(app).get('/api/admin/projects');

      expect(response.status).toBe(200);
      expect(response.body.projects).toBeInstanceOf(Array);
      expect(response.body.activeProjectId).toBe(projectId);
    });

    it('should create project via API', async () => {
      const response = await request(app)
        .post('/api/admin/projects')
        .send({
          name: 'API Test Project',
          description: 'Created via API',
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('API Test Project');
      expect(response.body.id).toBeDefined();

      // Cleanup
      deleteProject(response.body.id);
    });

    it('should list resources for project', async () => {
      createResource(projectId, {
        method: 'GET',
        path: '/api/test',
      });

      const response = await request(app).get(`/api/admin/projects/${projectId}/resources`);

      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body.length).toBe(1);
    });

    it('should create resource via API', async () => {
      const response = await request(app)
        .post(`/api/admin/projects/${projectId}/resources`)
        .send({
          method: 'POST',
          path: '/api/users',
          description: 'Create user',
        });

      expect(response.status).toBe(201);
      expect(response.body.method).toBe('POST');
      expect(response.body.path).toBe('/api/users');
      expect(response.body.scenarios).toHaveLength(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON in request body', async () => {
      const response = await request(app)
        .post('/api/admin/projects')
        .set('Content-Type', 'application/json')
        .send('invalid json');

      expect(response.status).toBe(400);
    });

    it('should handle missing required fields', async () => {
      const response = await request(app)
        .post('/api/admin/projects')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('should handle non-existent project', async () => {
      const response = await request(app).get('/api/admin/projects/nonexistent');

      expect(response.status).toBe(404);
    });
  });
});
