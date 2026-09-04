import { describe, expect, it } from 'vitest';
import {
  bodyDraftKey,
  createBodyDraft,
  discardBodyDraft,
  updateBodyDraft,
  type BodyDraftKey,
} from './bodyDrafts';

const base: BodyDraftKey = {
  projectId: 'prj_1',
  endpointId: 'ep_1',
  variantId: 'var_1',
  baseVariantRevision: 3,
  assetId: 'a'.repeat(64),
};

describe('body drafts', () => {
  it('keys drafts by Project, Endpoint, Variant, revision, and asset', () => {
    const keys = [
      bodyDraftKey(base),
      bodyDraftKey({ ...base, projectId: 'prj_2' }),
      bodyDraftKey({ ...base, endpointId: 'ep_2' }),
      bodyDraftKey({ ...base, variantId: 'var_2' }),
      bodyDraftKey({ ...base, baseVariantRevision: 4 }),
      bodyDraftKey({ ...base, assetId: 'b'.repeat(64) }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('clones new drafts and updates only the exact immutable map entry', () => {
    const mutableKey = { ...base };
    const first = createBodyDraft(new Map(), mutableKey, 'application/json');
    mutableKey.variantId = 'changed';
    const secondKey = { ...base, variantId: 'var_2' };
    const withSecond = createBodyDraft(first, secondKey, 'text/plain');
    const updated = updateBodyDraft(withSecond, base, { validity: 'valid', dirty: true });

    expect(first.get(bodyDraftKey(base))?.key).toEqual(base);
    expect(first.get(bodyDraftKey(base))).not.toHaveProperty('text');
    expect(updated).not.toBe(withSecond);
    expect(updated.get(bodyDraftKey(base))?.validity).toBe('valid');
    expect(withSecond.get(bodyDraftKey(base))?.validity).toBe('unknown');
    expect(updated.get(bodyDraftKey(secondKey))?.mediaType).toBe('text/plain');
  });

  it('discards only the exact serialized draft key', () => {
    const other = { ...base, baseVariantRevision: 4 };
    const drafts = createBodyDraft(
      createBodyDraft(new Map(), base, 'application/json'),
      other,
      'text/plain',
    );

    const discarded = discardBodyDraft(drafts, base);

    expect(discarded.has(bodyDraftKey(base))).toBe(false);
    expect(discarded.get(bodyDraftKey(other))?.mediaType).toBe('text/plain');
  });
});
