import { useLayoutEffect, useRef, useState } from 'react';
import { ApiClientError, trafficApi } from '../api/client';
import type {
  AppStateSummary,
  TrafficDetail,
  TrafficPromotionInput,
  TrafficPromotionResult,
} from '../api/types';
import { Modal } from './Modal';

export type MockThisChoice = Pick<TrafficPromotionInput, 'endpoint' | 'state'>;

export interface MockThisOwner {
  projectId: string;
  trafficId: string;
  trafficGeneration: string;
  responseIdentity: string;
  requestGeneration: number;
}

type MockThisRecovery =
  | { kind: 'known'; result: TrafficPromotionResult }
  | { kind: 'reconcile' };

export interface MockThisDialogProps {
  open: boolean;
  projectId: string;
  detail: TrafficDetail;
  states: AppStateSummary[];
  defaultStateId?: string;
  onClose(): void;
  onPromoted(result: TrafficPromotionResult): void;
  refreshCanonical(result?: TrafficPromotionResult): Promise<TrafficDetail | null | undefined>;
}

const blockedCopy: Record<Extract<
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

function reviewIdentity(
  projectId: string,
  detail: TrafficDetail,
  states: readonly AppStateSummary[],
  defaultStateId: string | undefined,
): string {
  const stateRevisions = states.map(state => [state.id, state.revision]);
  return detail.promotion.state === 'eligible'
    ? JSON.stringify([
      projectId,
      detail.id,
      detail.generation,
      detail.promotion.review.expectedResponseIdentity,
      detail.promotion.review.endpoint,
      detail.promotion.review.variant,
      stateRevisions,
      defaultStateId,
    ])
    : JSON.stringify([
      projectId, detail.id, detail.generation, detail.promotion.state, stateRevisions, defaultStateId,
    ]);
}

function initialStateChoice(detail: TrafficDetail, defaultStateId?: string): string {
  if (detail.promotion.state !== 'eligible') return '__unbound';
  if (detail.promotion.review.state.action === 'bind') return detail.promotion.review.state.stateId;
  return defaultStateId ?? detail.promotion.review.defaultStateId ?? '__unbound';
}

function HeaderEvidence({ headers }: { headers: Array<readonly [string, string]> }) {
  return (
    <div className="space-y-1 font-mono text-xs">
      {headers.map(([name, value], index) => (
        <p key={`${name}:${index}`} className="break-all"><span className="font-semibold">{name}:</span> {value}</p>
      ))}
    </div>
  );
}

export function MockThisDialog({
  open,
  projectId,
  detail,
  states,
  defaultStateId,
  onClose,
  onPromoted,
  refreshCanonical,
}: MockThisDialogProps) {
  const identity = reviewIdentity(projectId, detail, states, defaultStateId);
  const identityRef = useRef(identity);
  const operation = useRef<{
    owner: MockThisOwner;
    controller: AbortController;
  } | undefined>(undefined);
  const requestGeneration = useRef(0);
  const [stateChoice, setStateChoice] = useState(() => initialStateChoice(detail, defaultStateId));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [recovery, setRecovery] = useState<MockThisRecovery>();

  useLayoutEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    requestGeneration.current += 1;
    operation.current?.controller.abort();
    operation.current = undefined;
    setSubmitting(false);
    setError(undefined);
    setRecovery(undefined);
    setStateChoice(initialStateChoice(detail, defaultStateId));
  }, [defaultStateId, detail, identity]);

  useLayoutEffect(() => () => {
    requestGeneration.current += 1;
    operation.current?.controller.abort();
    operation.current = undefined;
  }, []);

  const promote = async () => {
    if (operation.current !== undefined || detail.promotion.state !== 'eligible') return;
    const review = detail.promotion.review;
    const state = stateChoice === '__unbound'
      ? { action: 'unbound' as const }
      : states.find(candidate => candidate.id === stateChoice);
    if (state === undefined) {
      setError('The selected App State is no longer available. Refresh and review again.');
      return;
    }
    const commandState: TrafficPromotionInput['state'] = 'action' in state
      ? state
      : { action: 'bind', stateId: state.id, expectedRevision: state.revision };
    const endpoint: TrafficPromotionInput['endpoint'] = review.endpoint.action === 'create'
      ? { action: 'create' }
      : {
        action: 'reuse',
        endpointId: review.endpoint.endpointId,
        expectedRevision: review.endpoint.expectedRevision,
      };
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const owner: MockThisOwner = {
      projectId,
      trafficId: detail.id,
      trafficGeneration: detail.generation,
      responseIdentity: review.expectedResponseIdentity,
      requestGeneration: generation,
    };
    const controller = new AbortController();
    const current = { owner, controller };
    operation.current = current;
    const owns = () => operation.current === current
      && identityRef.current === identity
      && requestGeneration.current === generation;
    setSubmitting(true);
    setError(undefined);
    try {
      if (recovery) {
        try {
          const reconciled = await refreshCanonical(
            recovery.kind === 'known' ? recovery.result : undefined,
          );
          if (!owns()) return;
          if (recovery.kind === 'known') {
            onPromoted(recovery.result);
          } else if (reconciled?.promotion.state === 'promoted') {
            onPromoted(reconciled.promotion.result);
          } else {
            setRecovery(undefined);
            setError('Canonical data was refreshed and no promotion receipt was observed. Review before confirming a new attempt.');
          }
        } catch {
          if (owns()) {
            setError('Canonical refresh failed. Retry canonical refresh; the promotion POST will not be repeated.');
          }
        }
        return;
      }

      let result: TrafficPromotionResult;
      try {
        result = await trafficApi.promote(projectId, detail.id, {
          expectedTrafficGeneration: review.expectedTrafficGeneration,
          expectedResponseIdentity: review.expectedResponseIdentity,
          endpoint,
          state: commandState,
        }, controller.signal);
      } catch (caught) {
        if (!owns() || (caught instanceof Error && caught.name === 'AbortError')) return;
        if (caught instanceof ApiClientError && caught.status === 409) {
          try {
            await refreshCanonical();
            if (owns()) setError('Promotion targets changed. Review the refreshed canonical targets before trying again.');
          } catch {
            if (owns()) {
              setRecovery({ kind: 'reconcile' });
              setError('Promotion targets changed, and canonical refresh failed. Retry canonical refresh before reviewing again.');
            }
          }
          return;
        }
        if (caught instanceof ApiClientError && caught.status > 0 && caught.status < 500) {
          setError(caught.message);
          return;
        }
        try {
          const reconciled = await refreshCanonical();
          if (!owns()) return;
          if (reconciled?.promotion.state === 'promoted') {
            onPromoted(reconciled.promotion.result);
          } else {
            setError('Promotion outcome is unknown. Canonical reads found no receipt; the POST was not repeated.');
          }
        } catch {
          if (owns()) {
            setRecovery({ kind: 'reconcile' });
            setError('Promotion outcome is unknown and canonical refresh failed. Retry canonical refresh; the POST will not be repeated.');
          }
        }
        return;
      }
      if (!owns()) return;
      try {
        await refreshCanonical(result);
      } catch {
        if (owns()) {
          setRecovery({ kind: 'known', result });
          setError('Promotion committed, but canonical refresh failed. Retry canonical refresh without repeating the POST.');
        }
        return;
      }
      if (owns()) onPromoted(result);
    } finally {
      if (owns()) {
        operation.current = undefined;
        setSubmitting(false);
      }
    }
  };

  const promotion = detail.promotion;
  return (
    <Modal
      isOpen={open}
      label="Mock This review"
      loading={submitting}
      onCancel={onClose}
      className="w-full max-w-3xl rounded-lg bg-white p-5 shadow-xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Review Mock This</h2>
          <p className="mt-1 text-sm text-gray-600">Confirm the captured evidence and exact canonical targets.</p>
        </div>
        <button type="button" disabled={submitting} onClick={onClose} aria-label="Close Mock This">Close</button>
      </div>

      {promotion.state === 'blocked' ? (
        <p className="mt-5 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {blockedCopy[promotion.reason]}
        </p>
      ) : null}

      {promotion.state === 'promoted' ? (
        <p className="mt-5 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Traffic already promoted to Endpoint {promotion.result.endpointId}, Variant {promotion.result.variantId}.
        </p>
      ) : null}

      {promotion.state === 'eligible' ? (
        <div className="mt-5 space-y-4">
          <section className="rounded border border-gray-200 p-3">
            <h3 className="text-sm font-semibold">Captured request</h3>
            <p className="mt-2 font-mono text-xs">{promotion.review.request.origin}</p>
            <p className="font-mono text-xs">{promotion.review.request.method} {promotion.review.request.path}</p>
            <div className="mt-2 space-y-1 font-mono text-xs">
              {promotion.review.request.query.map((entry, index) => (
                <p key={`${entry.name}:${index}`}>{entry.name}={entry.value}</p>
              ))}
            </div>
            <HeaderEvidence headers={promotion.review.request.headers} />
            {promotion.review.request.sensitiveQueryNames.length > 0 ? (
              <p className="mt-2 text-xs text-amber-800">
                Hidden query values will become local canonical matcher configuration from the trusted Traffic snapshot.
              </p>
            ) : null}
          </section>

          <section className="rounded border border-gray-200 p-3">
            <h3 className="text-sm font-semibold">Captured response</h3>
            <p className="mt-2 text-xs">Status {promotion.review.response.status}</p>
            <HeaderEvidence headers={promotion.review.response.headers} />
            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div><dt>Media type</dt><dd className="font-mono">{promotion.review.response.mediaType}</dd></div>
              <div><dt>Content encoding</dt><dd className="font-mono">{promotion.review.response.contentEncoding ?? 'None'}</dd></div>
              <div><dt>Size</dt><dd>{promotion.review.response.byteCount} bytes</dd></div>
              <div><dt>SHA-256</dt><dd className="break-all font-mono">{promotion.review.response.sha256}</dd></div>
            </dl>
            {promotion.review.response.sensitiveHeaderNames.includes('set-cookie') ? (
              <p className="mt-2 text-xs text-amber-800">Set-Cookie values will be stored exactly in the canonical Variant.</p>
            ) : null}
          </section>

          <section className="rounded border border-gray-200 p-3 text-sm">
            <h3 className="font-semibold">Canonical targets</h3>
            {promotion.review.endpoint.action === 'create' ? (
              <p className="mt-2">Create a Mock Endpoint.</p>
            ) : (
              <p className="mt-2">Reuse Endpoint {promotion.review.endpoint.endpointId}, revision {promotion.review.endpoint.expectedRevision}; mode becomes Mock.</p>
            )}
            <p>
              {promotion.review.variant.action === 'create'
                ? `Create Variant ${promotion.review.variant.deterministicName}.`
                : `Reuse Variant ${promotion.review.variant.variantId}.`}
            </p>
            <label className="mt-3 block text-sm font-medium">
              App State
              <select
                aria-label="Promotion App State"
                value={stateChoice}
                onChange={event => setStateChoice(event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              >
                <option value="__unbound">Leave unbound</option>
                {states.map(state => <option key={state.id} value={state.id}>{state.name} (revision {state.revision})</option>)}
              </select>
            </label>
            {detail.appState.mode === 'disabled' ? (
              <p className="mt-2 text-xs text-gray-600">App States are disabled; this binding remains dormant until mode is enabled.</p>
            ) : null}
          </section>
        </div>
      ) : null}

      {error ? <p className="mt-4 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" disabled={submitting} onClick={onClose} className="rounded border px-3 py-2 text-sm">Cancel</button>
        {promotion.state === 'eligible' ? (
          <button
            type="button"
            data-modal-initial-focus
            disabled={submitting}
            onClick={() => void promote()}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
              {submitting
                ? (recovery ? 'Refreshing canonical data...' : 'Promoting...')
                : (recovery ? 'Retry canonical refresh' : 'Confirm Mock This')}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
