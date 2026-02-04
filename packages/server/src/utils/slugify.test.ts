import { describe, it, expect } from 'vitest';
import { slugify, generateResourceFilename, parseResourceFilename, generateId } from './slugify';

describe('slugify', () => {
  it('should convert name to lowercase slug', () => {
    expect(slugify('Xstream Play')).toBe('xstream-play');
  });

  it('should remove special characters', () => {
    expect(slugify('My App! @#$%')).toBe('my-app');
  });

  it('should replace spaces with hyphens', () => {
    expect(slugify('Multiple   Spaces')).toBe('multiple-spaces');
  });

  it('should remove leading and trailing hyphens', () => {
    expect(slugify('  -Test Project-  ')).toBe('test-project');
  });

  it('should handle underscores', () => {
    expect(slugify('my_project_name')).toBe('my-project-name');
  });

  it('should handle empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('should handle single word', () => {
    expect(slugify('Project')).toBe('project');
  });
});

describe('generateResourceFilename', () => {
  it('should generate filename from method and path', () => {
    expect(generateResourceFilename('GET', '/api/users')).toBe('GET_api_users.json');
  });

  it('should handle path parameters', () => {
    expect(generateResourceFilename('GET', '/api/users/:id')).toBe('GET_api_users_id.json');
  });

  it('should handle nested paths', () => {
    expect(generateResourceFilename('POST', '/api/v1/users/:id/posts')).toBe('POST_api_v1_users_id_posts.json');
  });

  it('should handle root path', () => {
    expect(generateResourceFilename('GET', '/')).toBe('GET_.json');
  });

  it('should replace special characters with underscores', () => {
    expect(generateResourceFilename('GET', '/api/search?query=test')).toBe('GET_api_search_query_test.json');
  });
});

describe('parseResourceFilename', () => {
  it('should parse valid filename', () => {
    const result = parseResourceFilename('GET_api_users.json');
    expect(result).toEqual({ method: 'GET', path: 'api_users' });
  });

  it('should parse filename with path parameters', () => {
    const result = parseResourceFilename('POST_api_users_id_posts.json');
    expect(result).toEqual({ method: 'POST', path: 'api_users_id_posts' });
  });

  it('should return null for invalid filename', () => {
    const result = parseResourceFilename('invalid.json');
    expect(result).toBeNull();
  });

  it('should handle filename without extension', () => {
    const result = parseResourceFilename('GET_api_users');
    expect(result).toEqual({ method: 'GET', path: 'api_users' });
  });
});

describe('generateId', () => {
  it('should generate ID with correct prefix', () => {
    const id = generateId('proj');
    expect(id).toMatch(/^proj_\d+_[a-z0-9]+$/);
  });

  it('should generate unique IDs', () => {
    const id1 = generateId('proj');
    const id2 = generateId('proj');
    expect(id1).not.toBe(id2);
  });

  it('should work with different prefixes', () => {
    expect(generateId('res')).toMatch(/^res_\d+_[a-z0-9]+$/);
    expect(generateId('log')).toMatch(/^log_\d+_[a-z0-9]+$/);
  });
});
