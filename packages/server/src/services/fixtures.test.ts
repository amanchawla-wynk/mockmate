import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';

import { ensureProjectDirectory } from './storage';
import { writeHttpResponseFixture, readHttpResponseFixture, resolveFixturePath } from './fixtures';

describe('fixtures', () => {
  let slug: string;

  beforeEach(() => {
    slug = `test-fixtures-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    ensureProjectDirectory(slug);
  });

  it('should write and read a raw HTTP response fixture', () => {
    const body = Buffer.from('hello\n\x00\x01\x02', 'binary');
    const written = writeHttpResponseFixture(
      slug,
      'fixtures/test/response.http',
      201,
      { 'content-type': 'application/octet-stream', 'x-test': 'abc' },
      body,
    );

    const abs = resolveFixturePath(slug, written.relPath);
    expect(fs.existsSync(abs)).toBe(true);
    expect(written.size).toBeGreaterThan(body.length);

    const read = readHttpResponseFixture(slug, written.relPath);
    expect(read.statusCode).toBe(201);
    expect(read.headers['content-type']).toBe('application/octet-stream');
    expect(read.headers['x-test']).toBe('abc');
    expect(read.body.equals(body)).toBe(true);
  });

  it('should reject unsafe paths', () => {
    expect(() => resolveFixturePath(slug, '../secrets.txt')).toThrow();
    expect(() => resolveFixturePath(slug, 'fixtures/../../secrets.txt')).toThrow();
  });
});
