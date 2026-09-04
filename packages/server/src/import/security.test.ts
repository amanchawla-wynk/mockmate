import { describe, expect, it } from 'vitest';

import type { ImportRequestSummary } from './contracts';
import {
  canonicalJson,
  digestVariables,
  redactRequestSummary,
  sha256Bytes,
  sha256Identity,
} from './security';

describe('import security primitives', () => {
  it('sorts object keys while preserving array order', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: 'value' } })).toBe(
      '{"a":{"x":"value","y":true},"z":[2,1]}',
    );
  });

  it('sorts non-ASCII object keys by code unit', () => {
    expect(canonicalJson({ '\u00e4': 3, z: 2, a: 1 })).toBe(
      '{"a":1,"z":2,"\u00e4":3}',
    );
  });

  it('sorts integer-index object keys by code unit', () => {
    expect(canonicalJson({ 2: 'two', 10: 'ten' })).toBe(
      '{"10":"ten","2":"two"}',
    );
  });

  it('uses versioned namespaces and distinguishes no body from empty bytes', () => {
    expect(sha256Identity('import-response-v1', { body: { kind: 'none' } }))
      .not.toBe(sha256Identity('import-response-v1', {
        body: { kind: 'sha256', value: sha256Bytes(Buffer.alloc(0)) },
      }));
  });

  it('separates equal values hashed under different namespaces', () => {
    expect(sha256Identity('import-response-v1', { value: 'same' }))
      .not.toBe(sha256Identity('import-item-v1', { value: 'same' }));
  });

  it('keys variable digests and never returns plaintext values', () => {
    const first = digestVariables({ token: 'secret-token', host: 'api.example.test' }, Buffer.alloc(32, 1));
    const second = digestVariables({ host: 'api.example.test', token: 'secret-token' }, Buffer.alloc(32, 1));
    expect(first).toBe(second);
    expect(first).not.toContain('secret-token');
    expect(first).not.toBe(digestVariables({ token: 'secret-token', host: 'api.example.test' }, Buffer.alloc(32, 2)));
  });

  it('masks credential headers, sensitive names, URL user information, auth, and body content', () => {
    const summary: ImportRequestSummary = {
      scheme: 'https',
      hostname: 'api.example.test',
      port: '8443',
      userInfo: 'mobile:password',
      query: [
        { name: 'page', value: '2' },
        { name: 'apiKey', value: 'query-secret' },
      ],
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer header-secret' },
        { name: 'X-Session-Token', value: 'session-secret' },
      ],
      auth: { type: 'bearer', fields: [{ name: 'token', value: 'postman-secret' }] },
      body: { mediaType: 'application/json', byteCount: 31, omitted: true },
    };

    const redacted = redactRequestSummary(summary);
    expect(redacted).toMatchObject({
      userInfo: '[REDACTED]',
      query: [
        { name: 'page', value: '2' },
        { name: 'apiKey', value: '[REDACTED]' },
      ],
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: '[REDACTED]' },
        { name: 'X-Session-Token', value: '[REDACTED]' },
      ],
      auth: { type: 'bearer', fields: [{ name: 'token', value: '[REDACTED]' }] },
      body: { mediaType: 'application/json', byteCount: 31, omitted: true },
    });
    expect(JSON.stringify(redacted)).not.toMatch(/password|header-secret|query-secret|session-secret|postman-secret/);
  });

  it.each([
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'Set-Cookie',
  ])('masks the %s credential header', headerName => {
    const redacted = redactRequestSummary({
      query: [],
      headers: [{ name: headerName, value: 'credential-secret' }],
    });

    expect(redacted.headers).toEqual([
      { name: headerName, value: '[REDACTED]' },
    ]);
  });

  it('drops undeclared properties from structurally wider summaries', () => {
    const summary = {
      scheme: 'https',
      hostname: 'api.example.test',
      query: [
        { name: 'page', value: '2', provenance: 'query-provenance-secret' },
      ],
      headers: [
        { name: 'Accept', value: 'application/json', source: 'header-source-secret' },
      ],
      auth: {
        type: 'bearer',
        fields: [{ name: 'token', value: 'auth-secret', source: 'auth-source-secret' }],
        raw: 'raw-auth-secret',
      },
      body: {
        mediaType: 'application/json',
        byteCount: 16,
        omitted: true,
        content: 'raw-body-secret',
      },
      source: 'raw-source-secret',
      variables: { token: 'variable-secret' },
      provenance: 'request-provenance-secret',
    } as ImportRequestSummary;

    const redacted = redactRequestSummary(summary);

    expect(redacted).toEqual({
      scheme: 'https',
      hostname: 'api.example.test',
      query: [{ name: 'page', value: '2' }],
      headers: [{ name: 'Accept', value: 'application/json' }],
      auth: {
        type: 'bearer',
        fields: [{ name: 'token', value: '[REDACTED]' }],
      },
      body: {
        mediaType: 'application/json',
        byteCount: 16,
        omitted: true,
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('secret');
  });
});
