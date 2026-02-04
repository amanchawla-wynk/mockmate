import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createResource,
  listResources,
  getResource,
  updateResource,
  deleteResource,
  addScenario,
  updateScenario,
  deleteScenario,
  duplicateScenario,
  getScenario,
} from './resources';
import { createProject, deleteProject } from './projects';
import { initializeStorage } from './storage';

let testProjectId: string;
let createdResourceIds: string[] = [];

beforeEach(() => {
  initializeStorage();
  // Create a test project for each test
  const project = createProject({ name: 'Test Project ' + Date.now() });
  testProjectId = project.id;
  createdResourceIds = [];
});

afterEach(() => {
  // Clean up test project and all its resources
  try {
    deleteProject(testProjectId);
  } catch (e) {
    // Ignore cleanup errors
  }
});

describe('createResource', () => {
  it('should create a new resource with default scenario', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
      description: 'Get all users',
    });

    createdResourceIds.push(resource.id);

    expect(resource.id).toMatch(/^res_\d+_[a-z0-9]+$/);
    expect(resource.method).toBe('GET');
    expect(resource.path).toBe('/api/users');
    expect(resource.description).toBe('Get all users');
    expect(resource.scenarios).toHaveLength(1);
    expect(resource.scenarios[0].name).toBe('default');
    expect(resource.scenarios[0].statusCode).toBe(200);
    expect(resource.createdAt).toBeDefined();
    expect(resource.updatedAt).toBeDefined();
  });

  it('should create resource without description', () => {
    const resource = createResource(testProjectId, {
      method: 'POST',
      path: '/api/users',
    });

    createdResourceIds.push(resource.id);

    expect(resource.description).toBeUndefined();
  });

  it('should handle path parameters', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users/:id',
    });

    createdResourceIds.push(resource.id);

    expect(resource.path).toBe('/api/users/:id');
  });

  it('should throw error if path does not start with /', () => {
    expect(() =>
      createResource(testProjectId, {
        method: 'GET',
        path: 'api/users',
      })
    ).toThrow('Path must start with /');
  });

  it('should throw error if method or path is missing', () => {
    expect(() =>
      createResource(testProjectId, {
        method: '' as any,
        path: '/api/users',
      })
    ).toThrow('Method and path are required');
  });

  it('should throw error if resource with same method and path exists', () => {
    createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      createResource(testProjectId, {
        method: 'GET',
        path: '/api/users',
      })
    ).toThrow('already exists');
  });

  it('should allow same path with different methods', () => {
    const get = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const post = createResource(testProjectId, {
      method: 'POST',
      path: '/api/users',
    });

    createdResourceIds.push(get.id, post.id);

    expect(get.method).toBe('GET');
    expect(post.method).toBe('POST');
  });
});

describe('listResources', () => {
  it('should return empty array when no resources exist', () => {
    const resources = listResources(testProjectId);
    expect(resources).toEqual([]);
  });

  it('should list all resources', () => {
    const res1 = createResource(testProjectId, { method: 'GET', path: '/api/users' });
    const res2 = createResource(testProjectId, { method: 'POST', path: '/api/users' });
    const res3 = createResource(testProjectId, { method: 'GET', path: '/api/posts' });

    const resources = listResources(testProjectId);

    expect(resources).toHaveLength(3);
    expect(resources.map(r => r.id)).toContain(res1.id);
    expect(resources.map(r => r.id)).toContain(res2.id);
    expect(resources.map(r => r.id)).toContain(res3.id);
  });
});

describe('getResource', () => {
  it('should get resource by ID', () => {
    const created = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const retrieved = getResource(testProjectId, created.id);

    expect(retrieved.id).toBe(created.id);
    expect(retrieved.method).toBe('GET');
    expect(retrieved.path).toBe('/api/users');
  });

  it('should throw error if resource not found', () => {
    expect(() => getResource(testProjectId, 'non-existing-id')).toThrow('not found');
  });
});

describe('updateResource', () => {
  it('should update resource method', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const updated = updateResource(testProjectId, resource.id, {
      method: 'POST',
    });

    expect(updated.method).toBe('POST');
    expect(updated.path).toBe('/api/users');
  });

  it('should update resource path', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const updated = updateResource(testProjectId, resource.id, {
      path: '/api/v2/users',
    });

    expect(updated.path).toBe('/api/v2/users');
  });

  it('should update resource description', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const updated = updateResource(testProjectId, resource.id, {
      description: 'New description',
    });

    expect(updated.description).toBe('New description');
  });

  it('should throw error if updated path does not start with /', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      updateResource(testProjectId, resource.id, { path: 'api/users' })
    ).toThrow('Path must start with /');
  });

  it('should throw error if updated resource conflicts with existing', () => {
    createResource(testProjectId, { method: 'GET', path: '/api/users' });
    const res2 = createResource(testProjectId, { method: 'POST', path: '/api/posts' });

    expect(() =>
      updateResource(testProjectId, res2.id, { method: 'GET', path: '/api/users' })
    ).toThrow('already exists');
  });
});

describe('deleteResource', () => {
  it('should delete resource', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    deleteResource(testProjectId, resource.id);

    expect(() => getResource(testProjectId, resource.id)).toThrow('not found');
  });

  it('should throw error if resource not found', () => {
    expect(() => deleteResource(testProjectId, 'non-existing')).toThrow('not found');
  });
});

describe('addScenario', () => {
  it('should add scenario to resource', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const updated = addScenario(testProjectId, resource.id, {
      name: 'empty',
      statusCode: 200,
      body: [],
    });

    expect(updated.scenarios).toHaveLength(2);
    expect(updated.scenarios.map(s => s.name)).toContain('default');
    expect(updated.scenarios.map(s => s.name)).toContain('empty');

    const emptyScenario = updated.scenarios.find(s => s.name === 'empty');
    expect(emptyScenario?.statusCode).toBe(200);
    expect(emptyScenario?.body).toEqual([]);
  });

  it('should use defaults for optional scenario fields', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const updated = addScenario(testProjectId, resource.id, {
      name: 'error',
    });

    const errorScenario = updated.scenarios.find(s => s.name === 'error');
    expect(errorScenario?.statusCode).toBe(200);
    expect(errorScenario?.body).toEqual({});
    expect(errorScenario?.headers).toEqual({});
    expect(errorScenario?.delay).toBe(0);
  });

  it('should throw error if scenario name is empty', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      addScenario(testProjectId, resource.id, { name: '' })
    ).toThrow('Scenario name is required');
  });

  it('should throw error if scenario already exists', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    addScenario(testProjectId, resource.id, { name: 'empty' });

    expect(() =>
      addScenario(testProjectId, resource.id, { name: 'empty' })
    ).toThrow('already exists');
  });
});

describe('updateScenario', () => {
  it('should update scenario properties', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const updated = updateScenario(testProjectId, resource.id, 'default', {
      statusCode: 404,
      body: { error: 'Not found' },
      headers: { 'X-Custom': 'value' },
      delay: 1000,
    });

    const scenario = updated.scenarios.find(s => s.name === 'default');
    expect(scenario?.statusCode).toBe(404);
    expect(scenario?.body).toEqual({ error: 'Not found' });
    expect(scenario?.headers).toEqual({ 'X-Custom': 'value' });
    expect(scenario?.delay).toBe(1000);
  });

  it('should throw error if scenario not found', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      updateScenario(testProjectId, resource.id, 'non-existing', {})
    ).toThrow('not found');
  });
});

describe('deleteScenario', () => {
  it('should delete scenario', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    addScenario(testProjectId, resource.id, { name: 'empty' });

    const updated = deleteScenario(testProjectId, resource.id, 'empty');

    expect(updated.scenarios).toHaveLength(1);
    expect(updated.scenarios[0].name).toBe('default');
  });

  it('should throw error when trying to delete default scenario', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      deleteScenario(testProjectId, resource.id, 'default')
    ).toThrow('Cannot delete the "default" scenario');
  });

  it('should throw error if scenario not found', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      deleteScenario(testProjectId, resource.id, 'non-existing')
    ).toThrow('not found');
  });
});

describe('duplicateScenario', () => {
  it('should duplicate scenario with all properties', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    // Update default scenario
    updateScenario(testProjectId, resource.id, 'default', {
      statusCode: 404,
      body: { error: 'Not found' },
      headers: { 'X-Custom': 'value' },
      delay: 500,
    });

    const updated = duplicateScenario(
      testProjectId,
      resource.id,
      'default',
      'copy-of-default'
    );

    expect(updated.scenarios).toHaveLength(2);

    const duplicated = updated.scenarios.find(s => s.name === 'copy-of-default');
    expect(duplicated?.statusCode).toBe(404);
    expect(duplicated?.body).toEqual({ error: 'Not found' });
    expect(duplicated?.headers).toEqual({ 'X-Custom': 'value' });
    expect(duplicated?.delay).toBe(500);
  });

  it('should throw error if source scenario not found', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    expect(() =>
      duplicateScenario(testProjectId, resource.id, 'non-existing', 'copy')
    ).toThrow('not found');
  });

  it('should throw error if new name already exists', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    addScenario(testProjectId, resource.id, { name: 'existing' });

    expect(() =>
      duplicateScenario(testProjectId, resource.id, 'default', 'existing')
    ).toThrow('already exists');
  });
});

describe('getScenario', () => {
  it('should return requested scenario', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    addScenario(testProjectId, resource.id, {
      name: 'error',
      statusCode: 500,
    });

    const updatedResource = getResource(testProjectId, resource.id);
    const scenario = getScenario(updatedResource, 'error');

    expect(scenario.name).toBe('error');
    expect(scenario.statusCode).toBe(500);
  });

  it('should fallback to default scenario if requested not found', () => {
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
    });

    const scenario = getScenario(resource, 'non-existing');

    expect(scenario.name).toBe('default');
  });

  it('should provide safe fallback if no scenarios exist', () => {
    const resource: any = {
      scenarios: [],
    };

    const scenario = getScenario(resource, 'any');

    expect(scenario.name).toBe('default');
    expect(scenario.statusCode).toBe(200);
  });
});

describe('Full resource lifecycle', () => {
  it('should handle complete resource and scenario lifecycle', () => {
    // Create resource
    const resource = createResource(testProjectId, {
      method: 'GET',
      path: '/api/users',
      description: 'Get users',
    });

    expect(resource.scenarios).toHaveLength(1);

    // Add scenarios
    let updated = addScenario(testProjectId, resource.id, {
      name: 'empty',
      statusCode: 200,
      body: [],
    });

    updated = addScenario(testProjectId, resource.id, {
      name: 'error',
      statusCode: 500,
      body: { error: 'Server error' },
    });

    expect(updated.scenarios).toHaveLength(3);

    // Update scenario
    updated = updateScenario(testProjectId, resource.id, 'error', {
      statusCode: 503,
    });

    const errorScenario = updated.scenarios.find(s => s.name === 'error');
    expect(errorScenario?.statusCode).toBe(503);

    // Duplicate scenario
    updated = duplicateScenario(testProjectId, resource.id, 'error', 'error-copy');
    expect(updated.scenarios).toHaveLength(4);

    // Delete scenario
    updated = deleteScenario(testProjectId, resource.id, 'error-copy');
    expect(updated.scenarios).toHaveLength(3);

    // List resources
    const resources = listResources(testProjectId);
    expect(resources).toHaveLength(1);

    // Delete resource
    deleteResource(testProjectId, resource.id);
    expect(listResources(testProjectId)).toHaveLength(0);
  });
});
