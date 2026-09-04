import { describe, expect, it } from 'vitest';
import { HttpError, serializeApiError } from './api-errors';

describe('serializeApiError', () => {
  it('sanitizes unexpected admin failures', () => {
    const response = serializeApiError(
      new Error('/Users/example/.mockmate/secret'),
      'req-test',
    );

    expect(response).toEqual({
      status: 500,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'req-test',
      },
    });
    expect(JSON.stringify(response)).not.toContain('/Users/example');
  });

  it('serializes typed errors with recovery metadata', () => {
    const response = serializeApiError(
      new HttpError(409, 'PROJECT_ALREADY_EXISTS', 'Project already exists', {
        path: 'name',
        details: { name: 'Example' },
        recovery: 'Choose another project name',
      }),
      'req-test',
    );

    expect(response).toEqual({
      status: 409,
      body: {
        code: 'PROJECT_ALREADY_EXISTS',
        message: 'Project already exists',
        path: 'name',
        details: { name: 'Example' },
        recovery: 'Choose another project name',
        requestId: 'req-test',
      },
    });
  });

  it.each([
    [422, 'IMPORT_SOURCE_INVALID'],
    [422, 'IMPORT_VARIABLES_REQUIRED'],
    [422, 'IMPORT_SELECTION_INVALID'],
    [422, 'IMPORT_NO_CHANGES'],
    [422, 'IMPORT_LIMIT_EXCEEDED'],
    [409, 'IMPORT_PREVIEW_STALE'],
    [409, 'ID_COLLISION'],
    [409, 'ASSET_METADATA_CONFLICT'],
  ])('serializes documented import error %s %s without changing its contract', (status, code) => {
    expect(serializeApiError(
      new HttpError(status, code, `Public ${code} message`),
      'import-request',
    )).toEqual({
      status,
      body: {
        code,
        message: `Public ${code} message`,
        requestId: 'import-request',
      },
    });
  });

  it('maps internal stable ID exhaustion to the public ID_COLLISION contract', () => {
    expect(serializeApiError(
      new HttpError(409, 'ID_GENERATION_EXHAUSTED', 'Internal allocation detail'),
      'import-request',
    )).toEqual({
      status: 409,
      body: {
        code: 'ID_COLLISION',
        message: 'A unique stable ID could not be allocated',
        requestId: 'import-request',
      },
    });
  });

  it('translates unsupported parser encodings without exposing parser details', () => {
    const error = Object.assign(new Error('/Users/example/raw-parser-secret'), {
      status: 415,
      type: 'encoding.unsupported',
    });

    const response = serializeApiError(error, 'req-test');

    expect(response).toEqual({
      status: 415,
      body: {
        code: 'STATIC_CONTENT_ENCODING_UNSUPPORTED',
        message: 'Static uploads require an absent or identity Content-Encoding',
        requestId: 'req-test',
      },
    });
    expect(JSON.stringify(response)).not.toContain('raw-parser-secret');
  });

  it('does not expose unrecognized raw parser errors', () => {
    const error = Object.assign(new Error('/Users/example/raw-parser-secret'), {
      status: 400,
      type: 'stream.not.readable',
    });

    const response = serializeApiError(error, 'req-test');

    expect(response).toEqual({
      status: 500,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'req-test',
      },
    });
    expect(JSON.stringify(response)).not.toContain('raw-parser-secret');
  });
});
