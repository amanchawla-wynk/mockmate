import { describe, expect, it } from 'vitest';

import {
  createImportSnapshotTokenCodec,
} from './snapshot-token';

const INPUT = {
  projectId: 'prj_1',
  sourceType: 'postman' as const,
  canonicalDigest: 'canonical-a',
  planDigest: 'plan-a',
};

function replacePayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [encoded, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Record<string, unknown>;
  mutate(payload);
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
}

describe('import snapshot tokens', () => {
  it('authenticates and returns only the bound public snapshot values', () => {
    const codec = createImportSnapshotTokenCodec(Buffer.alloc(32, 7));
    const token = codec.issue(INPUT);
    expect(codec.verify(token)).toEqual({ version: 1, ...INPUT });
    expect(codec.issue(INPUT)).toBe(token);
  });

  it('allowlists signed fields from structurally wider runtime input', () => {
    const codec = createImportSnapshotTokenCodec(Buffer.alloc(32, 7));
    const widerInput = {
      ...INPUT,
      version: 99,
      issuedAt: -1,
      extra: 'must-not-be-signed',
    } as unknown as Parameters<typeof codec.issue>[0];

    const token = codec.issue(widerInput);
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as object;
    expect(payload).toEqual({ version: 1, ...INPUT });
    expect(codec.verify(token)).toEqual({ version: 1, ...INPUT });
  });

  it('invalidates tokens under a different repository key', () => {
    const token = createImportSnapshotTokenCodec(Buffer.alloc(32, 7)).issue(INPUT);
    expect(() => createImportSnapshotTokenCodec(Buffer.alloc(32, 8)).verify(token))
      .toThrowError(expect.objectContaining({ code: 'IMPORT_PREVIEW_STALE' }));
  });

  it.each([
    ['payload bytes', (token: string) => replacePayload(token, payload => { payload.planDigest = 'edited'; })],
    ['Project binding', (token: string) => replacePayload(token, payload => { payload.projectId = 'prj_2'; })],
    ['source binding', (token: string) => replacePayload(token, payload => { payload.sourceType = 'curl'; })],
    ['signature bytes', (token: string) => `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`],
    ['missing signature', (token: string) => token.split('.')[0]],
    ['extra envelope segment', (token: string) => `${token}.extra`],
  ])('rejects edited or malformed %s', (_name, edit) => {
    const codec = createImportSnapshotTokenCodec(Buffer.alloc(32, 7));
    expect(() => codec.verify(edit(codec.issue(INPUT))))
      .toThrowError(expect.objectContaining({
        status: 409,
        code: 'IMPORT_PREVIEW_STALE',
        message: 'Import preview is stale; refresh the preview',
      }));
  });

  it('issues the same token for equivalent previews regardless of elapsed time', () => {
    const first = createImportSnapshotTokenCodec(Buffer.alloc(32, 7)).issue(INPUT);
    const originalNow = Date.now;
    Date.now = () => originalNow() + (365 * 24 * 60 * 60 * 1_000);
    try {
      const second = createImportSnapshotTokenCodec(Buffer.alloc(32, 7)).issue(INPUT);
      expect(second).toBe(first);
      expect(createImportSnapshotTokenCodec(Buffer.alloc(32, 7)).verify(first))
        .toEqual({ version: 1, ...INPUT });
    } finally {
      Date.now = originalNow;
    }
  });

  it('contains no source, secret, or private planned response bytes', () => {
    const codec = createImportSnapshotTokenCodec(Buffer.alloc(32, 7));
    const token = codec.issue(INPUT);
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as object;
    expect(payload).toEqual({ version: 1, ...INPUT });
    expect(JSON.stringify(payload)).not.toContain('super-secret');
    expect(JSON.stringify(payload)).not.toContain('response body');
  });
});
