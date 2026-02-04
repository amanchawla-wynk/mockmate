import { describe, it, expect } from 'vitest';
import {
  pathToRegex,
  extractParams,
  matchRequest,
  resolveScenario,
  buildResponse,
  handleRequest,
} from './matcher';
import type { Resource, Scenario, HttpMethod } from '../types';

describe('pathToRegex', () => {
  it('should convert simple path to regex', () => {
    const { regex, paramNames } = pathToRegex('/api/users');
    expect(regex.test('/api/users')).toBe(true);
    expect(regex.test('/api/posts')).toBe(false);
    expect(paramNames).toEqual([]);
  });

  it('should convert path with single parameter', () => {
    const { regex, paramNames } = pathToRegex('/api/users/:id');
    expect(regex.test('/api/users/123')).toBe(true);
    expect(regex.test('/api/users/abc')).toBe(true);
    expect(regex.test('/api/users')).toBe(false);
    expect(regex.test('/api/users/123/posts')).toBe(false);
    expect(paramNames).toEqual(['id']);
  });

  it('should convert path with multiple parameters', () => {
    const { regex, paramNames } = pathToRegex('/api/users/:userId/posts/:postId');
    expect(regex.test('/api/users/123/posts/456')).toBe(true);
    expect(regex.test('/api/users/abc/posts/xyz')).toBe(true);
    expect(regex.test('/api/users/123')).toBe(false);
    expect(paramNames).toEqual(['userId', 'postId']);
  });

  it('should handle root path', () => {
    const { regex, paramNames } = pathToRegex('/');
    expect(regex.test('/')).toBe(true);
    expect(regex.test('/api')).toBe(false);
    expect(paramNames).toEqual([]);
  });

  it('should handle special regex characters in path', () => {
    const { regex } = pathToRegex('/api/search.json');
    expect(regex.test('/api/search.json')).toBe(true);
    expect(regex.test('/api/searchXjson')).toBe(false);
  });

  it('should not match partial paths', () => {
    const { regex } = pathToRegex('/api/users');
    expect(regex.test('/api/users/123')).toBe(false);
    expect(regex.test('/api')).toBe(false);
  });
});

describe('extractParams', () => {
  it('should extract single parameter', () => {
    const params = extractParams('/api/users/123', '/api/users/:id');
    expect(params).toEqual({ id: '123' });
  });

  it('should extract multiple parameters', () => {
    const params = extractParams(
      '/api/users/123/posts/456',
      '/api/users/:userId/posts/:postId'
    );
    expect(params).toEqual({ userId: '123', postId: '456' });
  });

  it('should return empty object for path without parameters', () => {
    const params = extractParams('/api/users', '/api/users');
    expect(params).toEqual({});
  });

  it('should return empty object for non-matching path', () => {
    const params = extractParams('/api/posts', '/api/users/:id');
    expect(params).toEqual({});
  });

  it('should handle URL-encoded values', () => {
    const params = extractParams('/api/users/user%20name', '/api/users/:id');
    expect(params).toEqual({ id: 'user%20name' });
  });
});

describe('matchRequest', () => {
  const mockResources: Resource[] = [
    {
      id: 'res_1',
      method: 'GET',
      path: '/api/users',
      scenarios: [
        { name: 'default', statusCode: 200, body: [] },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'res_2',
      method: 'GET',
      path: '/api/users/:id',
      scenarios: [
        { name: 'default', statusCode: 200, body: { id: '{{id}}' } },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'res_3',
      method: 'POST',
      path: '/api/users',
      scenarios: [
        { name: 'default', statusCode: 201, body: { created: true } },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'res_4',
      method: 'GET',
      path: '/api/users/:userId/posts/:postId',
      scenarios: [
        { name: 'default', statusCode: 200, body: {} },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ];

  it('should match exact path with GET method', () => {
    const result = matchRequest('GET', '/api/users', mockResources);
    expect(result).not.toBeNull();
    expect(result?.resource.id).toBe('res_1');
    expect(result?.params).toEqual({});
  });

  it('should match path with single parameter', () => {
    const result = matchRequest('GET', '/api/users/123', mockResources);
    expect(result).not.toBeNull();
    expect(result?.resource.id).toBe('res_2');
    expect(result?.params).toEqual({ id: '123' });
  });

  it('should match path with multiple parameters', () => {
    const result = matchRequest('GET', '/api/users/123/posts/456', mockResources);
    expect(result).not.toBeNull();
    expect(result?.resource.id).toBe('res_4');
    expect(result?.params).toEqual({ userId: '123', postId: '456' });
  });

  it('should differentiate between HTTP methods', () => {
    const getResult = matchRequest('GET', '/api/users', mockResources);
    const postResult = matchRequest('POST', '/api/users', mockResources);

    expect(getResult?.resource.id).toBe('res_1');
    expect(postResult?.resource.id).toBe('res_3');
  });

  it('should return null for unmatched path', () => {
    const result = matchRequest('GET', '/api/posts', mockResources);
    expect(result).toBeNull();
  });

  it('should return null for unmatched method', () => {
    const result = matchRequest('DELETE', '/api/users', mockResources);
    expect(result).toBeNull();
  });

  it('should handle trailing slash normalization', () => {
    const result = matchRequest('GET', '/api/users/', mockResources);
    expect(result).not.toBeNull();
    expect(result?.resource.id).toBe('res_1');
  });

  it('should match root path correctly', () => {
    const rootResources: Resource[] = [
      {
        id: 'res_root',
        method: 'GET',
        path: '/',
        scenarios: [{ name: 'default', statusCode: 200, body: {} }],
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ];

    const result = matchRequest('GET', '/', rootResources);
    expect(result).not.toBeNull();
    expect(result?.resource.id).toBe('res_root');
  });
});

describe('resolveScenario', () => {
  const mockResource: Resource = {
    id: 'res_1',
    method: 'GET',
    path: '/api/users',
    scenarios: [
      { name: 'default', statusCode: 200, body: [{ id: 1 }, { id: 2 }] },
      { name: 'empty', statusCode: 200, body: [] },
      { name: 'error', statusCode: 500, body: { error: 'Server error' } },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };

  it('should return default scenario when no scenario specified', () => {
    const scenario = resolveScenario(mockResource);
    expect(scenario.name).toBe('default');
    expect(scenario.statusCode).toBe(200);
  });

  it('should return requested scenario when it exists', () => {
    const scenario = resolveScenario(mockResource, 'empty');
    expect(scenario.name).toBe('empty');
    expect(scenario.body).toEqual([]);
  });

  it('should fallback to default when requested scenario not found', () => {
    const scenario = resolveScenario(mockResource, 'nonexistent');
    expect(scenario.name).toBe('default');
  });

  it('should return first scenario when no default exists', () => {
    const resourceNoDefault: Resource = {
      ...mockResource,
      scenarios: [
        { name: 'custom', statusCode: 200, body: {} },
      ],
    };

    const scenario = resolveScenario(resourceNoDefault);
    expect(scenario.name).toBe('custom');
  });

  it('should provide safe fallback when resource has no scenarios', () => {
    const resourceNoScenarios: Resource = {
      ...mockResource,
      scenarios: [],
    };

    const scenario = resolveScenario(resourceNoScenarios);
    expect(scenario.name).toBe('default');
    expect(scenario.statusCode).toBe(200);
    expect(scenario.body).toEqual({});
  });
});

describe('buildResponse', () => {
  it('should build response with all scenario fields', () => {
    const scenario: Scenario = {
      name: 'success',
      statusCode: 200,
      body: { data: 'test' },
      headers: { 'X-Custom': 'value' },
      delay: 100,
    };

    const response = buildResponse(scenario);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ data: 'test' });
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['X-Custom']).toBe('value');
    expect(response.delay).toBe(100);
    expect(response.scenario).toBe('success');
  });

  it('should use default delay of 0 when not specified', () => {
    const scenario: Scenario = {
      name: 'test',
      statusCode: 200,
      body: {},
    };

    const response = buildResponse(scenario);
    expect(response.delay).toBe(0);
  });

  it('should include default Content-Type header', () => {
    const scenario: Scenario = {
      name: 'test',
      statusCode: 200,
      body: {},
    };

    const response = buildResponse(scenario);
    expect(response.headers['Content-Type']).toBe('application/json');
  });

  it('should allow overriding Content-Type header', () => {
    const scenario: Scenario = {
      name: 'test',
      statusCode: 200,
      body: 'plain text',
      headers: { 'Content-Type': 'text/plain' },
    };

    const response = buildResponse(scenario);
    expect(response.headers['Content-Type']).toBe('text/plain');
  });

  it('should accept path parameters', () => {
    const scenario: Scenario = {
      name: 'test',
      statusCode: 200,
      body: { id: '{{id}}' },
    };

    const params = { id: '123' };
    const response = buildResponse(scenario, params);

    // Note: Currently we don't do template substitution
    // This is just to ensure params are accepted
    expect(response.body).toEqual({ id: '{{id}}' });
  });
});

describe('handleRequest', () => {
  const mockResources: Resource[] = [
    {
      id: 'res_1',
      method: 'GET',
      path: '/api/users',
      scenarios: [
        { name: 'default', statusCode: 200, body: [{ id: 1 }, { id: 2 }] },
        { name: 'empty', statusCode: 200, body: [] },
        { name: 'slow', statusCode: 200, body: [{ id: 1 }], delay: 2000 },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'res_2',
      method: 'GET',
      path: '/api/users/:id',
      scenarios: [
        { name: 'default', statusCode: 200, body: { id: 1, name: 'John' } },
        { name: 'error', statusCode: 404, body: { error: 'Not found' } },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ];

  it('should return null for unmatched request', () => {
    const response = handleRequest(
      'GET',
      '/api/posts',
      mockResources,
      'default'
    );
    expect(response).toBeNull();
  });

  it('should use active scenario by default', () => {
    const response = handleRequest(
      'GET',
      '/api/users',
      mockResources,
      'empty'
    );

    expect(response).not.toBeNull();
    expect(response?.scenario).toBe('empty');
    expect(response?.body).toEqual([]);
  });

  it('should prioritize header scenario over active scenario', () => {
    const response = handleRequest(
      'GET',
      '/api/users',
      mockResources,
      'empty',
      'slow'
    );

    expect(response).not.toBeNull();
    expect(response?.scenario).toBe('slow');
    expect(response?.delay).toBe(2000);
  });

  it('should fallback to default when active scenario not found', () => {
    const response = handleRequest(
      'GET',
      '/api/users',
      mockResources,
      'nonexistent'
    );

    expect(response).not.toBeNull();
    expect(response?.scenario).toBe('default');
  });

  it('should match path parameters and build response', () => {
    const response = handleRequest(
      'GET',
      '/api/users/123',
      mockResources,
      'default'
    );

    expect(response).not.toBeNull();
    expect(response?.statusCode).toBe(200);
    expect(response?.body).toEqual({ id: 1, name: 'John' });
  });

  it('should handle error scenarios', () => {
    const response = handleRequest(
      'GET',
      '/api/users/999',
      mockResources,
      'error'
    );

    expect(response).not.toBeNull();
    expect(response?.statusCode).toBe(404);
    expect(response?.body).toEqual({ error: 'Not found' });
  });

  it('should include proper headers in response', () => {
    const response = handleRequest(
      'GET',
      '/api/users',
      mockResources,
      'default'
    );

    expect(response).not.toBeNull();
    expect(response?.headers['Content-Type']).toBe('application/json');
  });
});

describe('Scenario Fallback Logic', () => {
  it('should follow priority: header → active → default', () => {
    const resource: Resource = {
      id: 'res_1',
      method: 'GET',
      path: '/api/test',
      scenarios: [
        { name: 'default', statusCode: 200, body: { scenario: 'default' } },
        { name: 'active', statusCode: 200, body: { scenario: 'active' } },
        { name: 'header', statusCode: 200, body: { scenario: 'header' } },
      ],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };

    const resources = [resource];

    // No header, uses active scenario
    const response1 = handleRequest('GET', '/api/test', resources, 'active');
    expect(response1?.body).toEqual({ scenario: 'active' });

    // Header specified, uses header scenario
    const response2 = handleRequest('GET', '/api/test', resources, 'active', 'header');
    expect(response2?.body).toEqual({ scenario: 'header' });

    // Invalid active scenario, falls back to default
    const response3 = handleRequest('GET', '/api/test', resources, 'invalid');
    expect(response3?.body).toEqual({ scenario: 'default' });

    // Invalid header scenario, falls back to default
    const response4 = handleRequest('GET', '/api/test', resources, 'active', 'invalid');
    expect(response4?.body).toEqual({ scenario: 'default' });
  });
});

describe('Method Matching', () => {
  const resources: Resource[] = [
    {
      id: 'get_users',
      method: 'GET',
      path: '/api/users',
      scenarios: [{ name: 'default', statusCode: 200, body: { method: 'GET' } }],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'post_users',
      method: 'POST',
      path: '/api/users',
      scenarios: [{ name: 'default', statusCode: 201, body: { method: 'POST' } }],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'put_users',
      method: 'PUT',
      path: '/api/users/:id',
      scenarios: [{ name: 'default', statusCode: 200, body: { method: 'PUT' } }],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ];

  it('should match GET request', () => {
    const response = handleRequest('GET', '/api/users', resources, 'default');
    expect(response?.body.method).toBe('GET');
    expect(response?.statusCode).toBe(200);
  });

  it('should match POST request', () => {
    const response = handleRequest('POST', '/api/users', resources, 'default');
    expect(response?.body.method).toBe('POST');
    expect(response?.statusCode).toBe(201);
  });

  it('should match PUT request with parameters', () => {
    const response = handleRequest('PUT', '/api/users/123', resources, 'default');
    expect(response?.body.method).toBe('PUT');
  });

  it('should not match unsupported method', () => {
    const response = handleRequest('DELETE', '/api/users', resources, 'default');
    expect(response).toBeNull();
  });
});
