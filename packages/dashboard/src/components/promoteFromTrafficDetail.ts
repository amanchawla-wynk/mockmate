import { ApiClientError, trafficApi } from '../api/client';
import type { TrafficDetail, TrafficPromotionResult } from '../api/types';

export const blockedCopy: Record<Extract<
  TrafficDetail['promotion'],
  { state: 'blocked' }
>['reason'], string> = {
  query_parse_invalid: 'The captured request cannot become a canonical matcher because its query evidence is malformed.',
  invalid_content_encoding: 'The captured entity cannot be reproduced safely because Content-Encoding is invalid.',
  body_unavailable: 'The exact response body is unavailable and cannot be promoted.',
  body_truncated: 'The exact response body is truncated and cannot be promoted.',
  body_evicted: 'The exact response body was evicted and cannot be promoted.',
  request_failed: 'The captured request failed before a promotable response was available.',
  request_cancelled: 'The captured request was cancelled before a promotable response was available.',
};

export type PromoteFromTrafficResult =
  | { ok: true; result: TrafficPromotionResult }
  | { ok: false; error: string };

/**
 * One-click Mock This: reuse/create endpoint from the Traffic review, always unbound.
 * Preserves GET-only recovery when the POST outcome is unknown.
 */
export async function promoteFromTrafficDetail(input: {
  projectId: string;
  detail: TrafficDetail;
  signal?: AbortSignal;
  refreshCanonical(result?: TrafficPromotionResult): Promise<TrafficDetail | null | undefined>;
}): Promise<PromoteFromTrafficResult> {
  const { projectId, detail, signal, refreshCanonical } = input;
  if (detail.promotion.state !== 'eligible') {
    return {
      ok: false,
      error: detail.promotion.state === 'blocked'
        ? blockedCopy[detail.promotion.reason]
        : 'Traffic already promoted.',
    };
  }

  const review = detail.promotion.review;
  const endpoint = review.endpoint.action === 'create'
    ? { action: 'create' as const }
    : {
      action: 'reuse' as const,
      endpointId: review.endpoint.endpointId,
      expectedRevision: review.endpoint.expectedRevision,
    };

  let result: TrafficPromotionResult;
  try {
    result = await trafficApi.promote(projectId, detail.id, {
      expectedTrafficGeneration: review.expectedTrafficGeneration,
      expectedResponseIdentity: review.expectedResponseIdentity,
      endpoint,
      state: { action: 'unbound' },
    }, signal);
  } catch (caught) {
    if (caught instanceof Error && caught.name === 'AbortError') {
      return { ok: false, error: 'Promotion cancelled.' };
    }
    if (caught instanceof ApiClientError && caught.status === 409) {
      try {
        await refreshCanonical();
        return {
          ok: false,
          error: 'Promotion targets changed. Refresh Traffic and try again.',
        };
      } catch {
        return {
          ok: false,
          error: 'Promotion targets changed, and canonical refresh failed. Retry after refresh.',
        };
      }
    }
    if (caught instanceof ApiClientError && caught.status > 0 && caught.status < 500) {
      return { ok: false, error: caught.message };
    }
    try {
      const reconciled = await refreshCanonical();
      if (reconciled?.promotion.state === 'promoted') {
        return { ok: true, result: reconciled.promotion.result };
      }
      return {
        ok: false,
        error: 'Promotion outcome is unknown. Canonical reads found no receipt; the POST was not repeated.',
      };
    } catch {
      return {
        ok: false,
        error: 'Promotion outcome is unknown and canonical refresh failed. Retry refresh; the POST will not be repeated.',
      };
    }
  }

  try {
    await refreshCanonical(result);
  } catch {
    return {
      ok: false,
      error: 'Promotion committed, but canonical refresh failed. Refresh Traffic without repeating Mock This.',
    };
  }
  return { ok: true, result };
}
