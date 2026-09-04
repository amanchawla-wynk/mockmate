import type { BodyAsset, ResponseVariant } from '../api/types';

export interface BodyDraftKey {
  projectId: string;
  endpointId: string;
  variantId: string;
  baseVariantRevision: number;
  assetId?: string;
}

export interface BodyDraft {
  key: BodyDraftKey;
  mediaType: string;
  validity: 'unknown' | 'valid' | 'invalid';
  validationMessage?: string;
  pendingAsset?: BodyAsset;
  serverVariant?: ResponseVariant;
  dirty: boolean;
}

export type BodyDrafts = Map<string, BodyDraft>;

export function bodyDraftKey(key: BodyDraftKey): string {
  return JSON.stringify([
    key.projectId,
    key.endpointId,
    key.variantId,
    key.baseVariantRevision,
    key.assetId ?? null,
  ]);
}

export function createBodyDraft(
  drafts: BodyDrafts,
  key: BodyDraftKey,
  mediaType: string,
): BodyDrafts {
  const next = new Map(drafts);
  next.set(bodyDraftKey(key), {
    key: { ...key },
    mediaType,
    validity: 'unknown',
    dirty: false,
  });
  return next;
}

export function updateBodyDraft(
  drafts: BodyDrafts,
  key: BodyDraftKey,
  patch: Partial<Omit<BodyDraft, 'key'>>,
): BodyDrafts {
  const serializedKey = bodyDraftKey(key);
  const draft = drafts.get(serializedKey);
  if (!draft) return drafts;
  const next = new Map(drafts);
  next.set(serializedKey, { ...draft, ...patch, key: { ...draft.key } });
  return next;
}

export function discardBodyDraft(drafts: BodyDrafts, key: BodyDraftKey): BodyDrafts {
  const serializedKey = bodyDraftKey(key);
  if (!drafts.has(serializedKey)) return drafts;
  const next = new Map(drafts);
  next.delete(serializedKey);
  return next;
}
