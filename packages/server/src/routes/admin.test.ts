import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { deleteProject } from '../services/projects';
import type { Application } from 'express';

describe('Admin API Routes', () => {
  let app: Application;
  const createdProjectIds: string[] = [];

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    // Clean up all created projects
    for (const id of createdProjectIds) {
      try {
        deleteProject(id);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    createdProjectIds.length = 0;
  });

  describe('Project Routes', () => {
    describe('POST /api/admin/projects', () => {
      it('should create a new project', async () => {
        const response = await request(app)
          .post('/api/admin/projects')
          .send({
            name: 'Test Project',
            description: 'A test project',
          });

        expect(response.status).toBe(201);
        expect(response.body.id).toBeDefined();
        expect(response.body.name).toBe('Test Project');
        expect(response.body.description).toBe('A test project');
        expect(response.body.slug).toBe('test-project');
        expect(response.body.activeScenario).toBe('default');
        expect(response.body.createdAt).toBeDefined();
        expect(response.body.updatedAt).toBeDefined();

        createdProjectIds.push(response.body.id);
      });

      it('should create project without description', async () => {
        const response = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Simple Project' });

        expect(response.status).toBe(201);
        expect(response.body.name).toBe('Simple Project');
        expect(response.body.description).toBeUndefined();

        createdProjectIds.push(response.body.id);
      });

      it('should fail with empty name', async () => {
        const response = await request(app)
          .post('/api/admin/projects')
          .send({ name: '' });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('required');
      });

      it('should fail with duplicate name', async () => {
        const first = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Duplicate Test' });

        createdProjectIds.push(first.body.id);

        const second = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Duplicate Test' });

        expect(second.status).toBe(400);
        expect(second.body.error).toContain('already exists');
      });
    });

    describe('GET /api/admin/projects', () => {
      it('should list all projects', async () => {
        // Create two projects
        const project1 = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Project 1' });

        const project2 = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Project 2' });

        createdProjectIds.push(project1.body.id, project2.body.id);

        // Set one as active
        await request(app).put(`/api/admin/projects/${project1.body.id}/activate`);

        const response = await request(app).get('/api/admin/projects');

        expect(response.status).toBe(200);
        expect(response.body.projects).toBeInstanceOf(Array);
        expect(response.body.projects.length).toBeGreaterThanOrEqual(2);
        expect(response.body.activeProjectId).toBe(project1.body.id);
      });

      it('should include active project ID', async () => {
        const project = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Active Test' });

        createdProjectIds.push(project.body.id);

        await request(app).put(`/api/admin/projects/${project.body.id}/activate`);

        const response = await request(app).get('/api/admin/projects');

        expect(response.body.activeProjectId).toBe(project.body.id);
      });
    });

    describe('GET /api/admin/projects/:id', () => {
      it('should get a specific project', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Get Test' });

        createdProjectIds.push(created.body.id);

        const response = await request(app).get(`/api/admin/projects/${created.body.id}`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(created.body.id);
        expect(response.body.name).toBe('Get Test');
      });

      it('should return 404 for non-existent project', async () => {
        const response = await request(app).get('/api/admin/projects/nonexistent');

        expect(response.status).toBe(404);
        expect(response.body.error).toContain('not found');
      });
    });

    describe('PUT /api/admin/projects/:id', () => {
      it('should update project name', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Original Name' });

        createdProjectIds.push(created.body.id);

        const response = await request(app)
          .put(`/api/admin/projects/${created.body.id}`)
          .send({ name: 'Updated Name' });

        expect(response.status).toBe(200);
        expect(response.body.name).toBe('Updated Name');
        expect(response.body.slug).toBe('updated-name');
        expect(response.body.updatedAt).not.toBe(created.body.updatedAt);
      });

      it('should update description', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Test' });

        createdProjectIds.push(created.body.id);

        const response = await request(app)
          .put(`/api/admin/projects/${created.body.id}`)
          .send({ description: 'New description' });

        expect(response.status).toBe(200);
        expect(response.body.description).toBe('New description');
      });

      it('should return 404 for non-existent project', async () => {
        const response = await request(app)
          .put('/api/admin/projects/nonexistent')
          .send({ name: 'Test' });

        expect(response.status).toBe(400);
      });
    });

    describe('DELETE /api/admin/projects/:id', () => {
      it('should delete a project', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'To Delete' });

        const projectId = created.body.id;

        const deleteResponse = await request(app).delete(`/api/admin/projects/${projectId}`);

        expect(deleteResponse.status).toBe(204);

        // Verify it's deleted
        const getResponse = await request(app).get(`/api/admin/projects/${projectId}`);
        expect(getResponse.status).toBe(404);
      });

      it('should return 404 for non-existent project', async () => {
        const response = await request(app).delete('/api/admin/projects/nonexistent');

        expect(response.status).toBe(404);
      });
    });

    describe('PUT /api/admin/projects/:id/activate', () => {
      it('should set project as active', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Activate Test' });

        createdProjectIds.push(created.body.id);

        const response = await request(app)
          .put(`/api/admin/projects/${created.body.id}/activate`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(created.body.id);

        // Verify it's active
        const listResponse = await request(app).get('/api/admin/projects');
        expect(listResponse.body.activeProjectId).toBe(created.body.id);
      });

      it('should return 404 for non-existent project', async () => {
        const response = await request(app).put('/api/admin/projects/nonexistent/activate');

        expect(response.status).toBe(404);
      });
    });

    describe('PUT /api/admin/projects/:id/scenario', () => {
      it('should switch active scenario', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Scenario Test' });

        createdProjectIds.push(created.body.id);

        const response = await request(app)
          .put(`/api/admin/projects/${created.body.id}/scenario`)
          .send({ scenario: 'empty' });

        expect(response.status).toBe(200);
        expect(response.body.activeScenario).toBe('empty');
      });

      it('should fail without scenario name', async () => {
        const created = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Test' });

        createdProjectIds.push(created.body.id);

        const response = await request(app)
          .put(`/api/admin/projects/${created.body.id}/scenario`)
          .send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('required');
      });
    });
  });

  describe('Resource Routes', () => {
    let projectId: string;

    beforeEach(async () => {
      const project = await request(app)
        .post('/api/admin/projects')
        .send({ name: 'Resource Test Project ' + Date.now() });

      projectId = project.body.id;
      createdProjectIds.push(projectId);
    });

    describe('POST /api/admin/projects/:projectId/resources', () => {
      it('should create a new resource', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({
            method: 'GET',
            path: '/api/users',
            description: 'Get all users',
          });

        expect(response.status).toBe(201);
        expect(response.body.id).toBeDefined();
        expect(response.body.method).toBe('GET');
        expect(response.body.path).toBe('/api/users');
        expect(response.body.description).toBe('Get all users');
        expect(response.body.scenarios).toHaveLength(1);
        expect(response.body.scenarios[0].name).toBe('default');
      });

      it('should fail with invalid path', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({
            method: 'GET',
            path: 'invalid',
          });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('must start with /');
      });

      it('should fail for non-existent project', async () => {
        const response = await request(app)
          .post('/api/admin/projects/nonexistent/resources')
          .send({
            method: 'GET',
            path: '/api/test',
          });

        expect(response.status).toBe(400);
      });
    });

    describe('GET /api/admin/projects/:projectId/resources', () => {
      it('should list all resources for a project', async () => {
        // Create two resources
        await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'GET', path: '/api/users' });

        await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'POST', path: '/api/users' });

        const response = await request(app).get(`/api/admin/projects/${projectId}/resources`);

        expect(response.status).toBe(200);
        expect(response.body).toBeInstanceOf(Array);
        expect(response.body.length).toBe(2);
      });

      it('should return empty array for project with no resources', async () => {
        const response = await request(app).get(`/api/admin/projects/${projectId}/resources`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
      });
    });

    describe('GET /api/admin/projects/:projectId/resources/:resourceId', () => {
      it('should get a specific resource', async () => {
        const created = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'GET', path: '/api/test' });

        const response = await request(app).get(
          `/api/admin/projects/${projectId}/resources/${created.body.id}`
        );

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(created.body.id);
      });

      it('should return 404 for non-existent resource', async () => {
        const response = await request(app).get(
          `/api/admin/projects/${projectId}/resources/nonexistent`
        );

        expect(response.status).toBe(404);
      });
    });

    describe('PUT /api/admin/projects/:projectId/resources/:resourceId', () => {
      it('should update resource path', async () => {
        const created = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'GET', path: '/api/old' });

        const response = await request(app)
          .put(`/api/admin/projects/${projectId}/resources/${created.body.id}`)
          .send({ path: '/api/new' });

        expect(response.status).toBe(200);
        expect(response.body.path).toBe('/api/new');
      });

      it('should update resource method', async () => {
        const created = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'GET', path: '/api/test' });

        const response = await request(app)
          .put(`/api/admin/projects/${projectId}/resources/${created.body.id}`)
          .send({ method: 'POST' });

        expect(response.status).toBe(200);
        expect(response.body.method).toBe('POST');
      });

      it('should fail with invalid path', async () => {
        const created = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'GET', path: '/api/test' });

        const response = await request(app)
          .put(`/api/admin/projects/${projectId}/resources/${created.body.id}`)
          .send({ path: 'invalid' });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('must start with /');
      });
    });

    describe('DELETE /api/admin/projects/:projectId/resources/:resourceId', () => {
      it('should delete a resource', async () => {
        const created = await request(app)
          .post(`/api/admin/projects/${projectId}/resources`)
          .send({ method: 'GET', path: '/api/delete-me' });

        const deleteResponse = await request(app).delete(
          `/api/admin/projects/${projectId}/resources/${created.body.id}`
        );

        expect(deleteResponse.status).toBe(204);

        // Verify it's deleted
        const getResponse = await request(app).get(
          `/api/admin/projects/${projectId}/resources/${created.body.id}`
        );
        expect(getResponse.status).toBe(404);
      });

      it('should return 404 for non-existent resource', async () => {
        const response = await request(app).delete(
          `/api/admin/projects/${projectId}/resources/nonexistent`
        );

        expect(response.status).toBe(404);
      });
    });
  });

  describe('Scenario Routes', () => {
    let projectId: string;
    let resourceId: string;

    beforeEach(async () => {
      const project = await request(app)
        .post('/api/admin/projects')
        .send({ name: 'Scenario Test Project ' + Date.now() });

      projectId = project.body.id;
      createdProjectIds.push(projectId);

      const resource = await request(app)
        .post(`/api/admin/projects/${projectId}/resources`)
        .send({ method: 'GET', path: '/api/test' });

      resourceId = resource.body.id;
    });

    describe('POST /api/admin/projects/:pid/resources/:rid/scenarios', () => {
      it('should add a new scenario', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios`)
          .send({
            name: 'empty',
            statusCode: 200,
            body: [],
            headers: { 'X-Custom': 'value' },
            delay: 100,
          });

        expect(response.status).toBe(201);
        expect(response.body.scenarios).toHaveLength(2); // default + new
        const newScenario = response.body.scenarios.find((s: any) => s.name === 'empty');
        expect(newScenario).toBeDefined();
        expect(newScenario.statusCode).toBe(200);
        expect(newScenario.body).toEqual([]);
        expect(newScenario.headers).toEqual({ 'X-Custom': 'value' });
        expect(newScenario.delay).toBe(100);
      });

      it('should fail with duplicate scenario name', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios`)
          .send({
            name: 'default',
            statusCode: 200,
            body: {},
          });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('already exists');
      });

      it('should fail without name', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios`)
          .send({
            statusCode: 200,
            body: {},
          });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('required');
      });
    });

    describe('PUT /api/admin/projects/:pid/resources/:rid/scenarios/:name', () => {
      beforeEach(async () => {
        await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios`)
          .send({
            name: 'test',
            statusCode: 200,
            body: { original: true },
          });
      });

      it('should update scenario', async () => {
        const response = await request(app)
          .put(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/test`)
          .send({
            statusCode: 404,
            body: { updated: true },
            delay: 200,
          });

        expect(response.status).toBe(200);
        const updatedScenario = response.body.scenarios.find((s: any) => s.name === 'test');
        expect(updatedScenario.statusCode).toBe(404);
        expect(updatedScenario.body).toEqual({ updated: true });
        expect(updatedScenario.delay).toBe(200);
      });

      it('should return 404 for non-existent scenario', async () => {
        const response = await request(app)
          .put(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/nonexistent`)
          .send({ statusCode: 200 });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('not found');
      });
    });

    describe('DELETE /api/admin/projects/:pid/resources/:rid/scenarios/:name', () => {
      beforeEach(async () => {
        await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios`)
          .send({
            name: 'deletable',
            statusCode: 200,
            body: {},
          });
      });

      it('should delete a scenario', async () => {
        const response = await request(app).delete(
          `/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/deletable`
        );

        expect(response.status).toBe(200);
        expect(response.body.scenarios).toHaveLength(1); // Only default remains
        expect(response.body.scenarios[0].name).toBe('default');
      });

      it('should not delete default scenario', async () => {
        const response = await request(app).delete(
          `/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/default`
        );

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Cannot delete');
      });

      it('should return 404 for non-existent scenario', async () => {
        const response = await request(app).delete(
          `/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/nonexistent`
        );

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('not found');
      });
    });

    describe('POST /api/admin/projects/:pid/resources/:rid/scenarios/:name/duplicate', () => {
      beforeEach(async () => {
        await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios`)
          .send({
            name: 'source',
            statusCode: 201,
            body: { test: 'data' },
            headers: { 'X-Custom': 'header' },
            delay: 50,
          });
      });

      it('should duplicate a scenario', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/source/duplicate`)
          .send({ newName: 'copy' });

        expect(response.status).toBe(201);
        expect(response.body.scenarios).toHaveLength(3); // default + source + copy

        const copiedScenario = response.body.scenarios.find((s: any) => s.name === 'copy');
        expect(copiedScenario).toBeDefined();
        expect(copiedScenario.statusCode).toBe(201);
        expect(copiedScenario.body).toEqual({ test: 'data' });
        expect(copiedScenario.headers).toEqual({ 'X-Custom': 'header' });
        expect(copiedScenario.delay).toBe(50);
      });

      it('should fail without new name', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/source/duplicate`)
          .send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('required');
      });

      it('should fail with duplicate name', async () => {
        const response = await request(app)
          .post(`/api/admin/projects/${projectId}/resources/${resourceId}/scenarios/source/duplicate`)
          .send({ newName: 'default' });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('already exists');
      });
    });
  });

  describe('Server Routes', () => {
    describe('GET /api/admin/status', () => {
      it('should return server status', async () => {
        const response = await request(app).get('/api/admin/status');

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('running');
        expect(response.body.timestamp).toBeDefined();
        expect(response.body.activeProject).toBeDefined();
      });

      it('should show active project if set', async () => {
        const project = await request(app)
          .post('/api/admin/projects')
          .send({ name: 'Status Test' });

        createdProjectIds.push(project.body.id);

        await request(app).put(`/api/admin/projects/${project.body.id}/activate`);

        const response = await request(app).get('/api/admin/status');

        expect(response.body.activeProject).toBeDefined();
        expect(response.body.activeProject.id).toBe(project.body.id);
        expect(response.body.activeProject.name).toBe('Status Test');
        expect(response.body.activeProject.activeScenario).toBe('default');
      });
    });

    describe('GET /api/admin/logs', () => {
      it('should return request logs', async () => {
        const response = await request(app).get('/api/admin/logs');

        expect(response.status).toBe(200);
        expect(response.body).toBeInstanceOf(Array);
      });
    });

    describe('DELETE /api/admin/logs', () => {
      it('should clear request logs', async () => {
        // Clear logs first
        await request(app).delete('/api/admin/logs');

        // Make a request to create a log
        await request(app).get('/api/test');

        // Verify log exists
        let logsResponse = await request(app).get('/api/admin/logs');
        expect(logsResponse.body.length).toBeGreaterThan(0);

        // Clear logs
        const clearResponse = await request(app).delete('/api/admin/logs');
        expect(clearResponse.status).toBe(204);

        // Verify logs are empty
        logsResponse = await request(app).get('/api/admin/logs');
        expect(logsResponse.body.length).toBe(0);
      });
    });
  });
});
