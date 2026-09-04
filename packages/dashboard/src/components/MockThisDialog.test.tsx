import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, trafficApi } from '../api/client';
import type { TrafficDetail, TrafficPromotionResult } from '../api/types';
import { MockThisDialog } from './MockThisDialog';

const result: TrafficPromotionResult = {
  endpointId: 'ep_1', endpointCreated: false,
  variantId: 'var_1', variantCreated: true,
  endpointModeChanged: true, stateId: 'state_active', bindingChanged: true,
};

const detail: TrafficDetail = {
  id: 'trf_1', generation: 'tg_1', projectId: 'prj_1', requestId: 'req_1',
  startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:00.010Z',
  durationMs: 10, transport: 'https_mitm', allowlistPattern: '*.example.test',
  origin: 'https://api.example.test', method: 'GET', path: '/users',
  queryNames: [{ name: 'token', occurrenceCount: 1, sensitive: true }], decision: 'endpoint_passthrough',
  status: 200, responseBytes: 5, requestBodyState: 'unavailable', responseBodyState: 'available',
  request: {
    query: [{ name: 'token', value: '[REDACTED]' }],
    headers: [['authorization', '[REDACTED]']],
    body: { side: 'request', state: 'unavailable', observedSize: 0, reason: 'body_unobservable' },
  },
  response: {
    headers: [['set-cookie', 'session=one'], ['set-cookie', 'theme=dark']],
    body: {
      side: 'response', state: 'available', mediaType: 'application/json', observedSize: 5,
      retainedSize: 5, sha256: 'a'.repeat(64),
    },
  },
  appState: { mode: 'enabled', activeStateId: 'state_active', fallbackReasons: [] },
  captureState: 'complete',
  promotion: {
    state: 'eligible',
    review: {
      expectedTrafficGeneration: 'tg_1', expectedResponseIdentity: 'resp_1',
      request: {
        origin: 'https://api.example.test', method: 'GET', path: '/users',
        query: [{ name: 'token', value: '[REDACTED]' }],
        headers: [['authorization', '[REDACTED]']], sensitiveQueryNames: ['token'],
      },
      response: {
        status: 200,
        headers: [['set-cookie', 'session=one'], ['set-cookie', 'theme=dark']],
        mediaType: 'application/json', byteCount: 5, sha256: 'a'.repeat(64),
        sensitiveHeaderNames: ['set-cookie'],
      },
      endpoint: {
        action: 'reuse', endpointId: 'ep_1', expectedRevision: 7,
        currentMode: 'passthrough', targetMode: 'mock',
      },
      variant: { action: 'create', deterministicName: 'Captured 200' },
      state: { action: 'bind', stateId: 'state_active', expectedRevision: 4 },
      defaultStateId: 'state_active',
      warnings: ['sensitive_query_values_persisted', 'sensitive_response_headers_persisted'],
    },
  },
};

const states = [
  {
    id: 'state_active', projectId: 'prj_1', name: 'Signed in', tags: [], revision: 4,
    boundEndpointCount: 1, totalEndpointCount: 1, missingEndpointIds: [],
  },
  {
    id: 'state_other', projectId: 'prj_1', name: 'Signed out', tags: [], revision: 6,
    boundEndpointCount: 0, totalEndpointCount: 1, missingEndpointIds: ['ep_1'],
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function props(overrides: Partial<React.ComponentProps<typeof MockThisDialog>> = {}) {
  return {
    open: true,
    projectId: 'prj_1',
    detail,
    states,
    defaultStateId: 'state_active',
    onClose: vi.fn(),
    onPromoted: vi.fn(),
    refreshCanonical: vi.fn().mockResolvedValue(detail),
    ...overrides,
  };
}

describe('MockThisDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reviews redacted evidence and submits only trusted target identities', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockResolvedValue(result);
    const owner = props();
    render(<MockThisDialog {...owner} />);

    expect(screen.getByText('https://api.example.test')).toBeVisible();
    expect(screen.getByText('token=[REDACTED]')).toBeVisible();
    expect(screen.getByText(/hidden query values will become local canonical matcher configuration/i)).toBeVisible();
    expect(screen.getByText(/Set-Cookie values will be stored/i)).toBeVisible();
    expect(screen.getAllByText(/session=one|theme=dark/)).toHaveLength(2);
    expect(screen.getByText(/ep_1.*revision 7/i)).toBeVisible();
    expect(screen.getByText(/Captured 200/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));

    expect(promote).toHaveBeenCalledWith('prj_1', 'trf_1', {
      expectedTrafficGeneration: 'tg_1', expectedResponseIdentity: 'resp_1',
      endpoint: { action: 'reuse', endpointId: 'ep_1', expectedRevision: 7 },
      state: { action: 'bind', stateId: 'state_active', expectedRevision: 4 },
    }, expect.any(AbortSignal));
    await waitFor(() => expect(owner.onPromoted).toHaveBeenCalledWith(result));
  });

  it('supports another reviewed State or an unbound promotion', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockResolvedValue(result);
    render(<MockThisDialog {...props()} />);
    await userEvent.selectOptions(screen.getByLabelText('Promotion App State'), 'state_other');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));
    expect(promote.mock.calls[0]?.[2].state).toEqual({
      action: 'bind', stateId: 'state_other', expectedRevision: 6,
    });
  });

  it('allows only one in-flight promotion owner', async () => {
    const pending = deferred<TrafficPromotionResult>();
    const promote = vi.spyOn(trafficApi, 'promote').mockReturnValue(pending.promise);
    render(<MockThisDialog {...props()} />);
    const confirm = screen.getByRole('button', { name: 'Confirm Mock This' });
    await userEvent.dblClick(confirm);
    expect(promote).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(result));
  });

  it('invalidates an in-flight owner when the default State target changes', async () => {
    const pending = deferred<TrafficPromotionResult>();
    const promote = vi.spyOn(trafficApi, 'promote').mockReturnValue(pending.promise);
    const owner = props();
    const { rerender } = render(<MockThisDialog {...owner} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));
    const signal = promote.mock.calls[0]?.[3];

    rerender(<MockThisDialog {...owner} defaultStateId="state_other" />);

    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Confirm Mock This' })).toBeEnabled();
  });

  it('preserves choices and performs GET-only refresh after a revision conflict', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockRejectedValue(new ApiClientError(
      409, 'REVISION_CONFLICT', 'stale target', 'req_2', undefined, { currentRevision: 8 },
    ));
    const owner = props();
    render(<MockThisDialog {...owner} />);
    await userEvent.selectOptions(screen.getByLabelText('Promotion App State'), 'state_other');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));

    await waitFor(() => expect(owner.refreshCanonical).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Promotion App State')).toHaveValue('state_other');
    expect(screen.getByText(/targets changed.*review/i)).toBeVisible();
    expect(promote).toHaveBeenCalledOnce();
  });

  it('reconciles an unknown POST outcome through GET only and never retries', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockRejectedValue(new Error('connection lost'));
    const promoted = { ...detail, promotion: { state: 'promoted' as const, result } };
    const owner = props({ refreshCanonical: vi.fn().mockResolvedValue(promoted) });
    render(<MockThisDialog {...owner} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));

    await waitFor(() => expect(owner.onPromoted).toHaveBeenCalledWith(result));
    expect(promote).toHaveBeenCalledOnce();
  });

  it('retries only canonical GET after a committed promotion refresh fails', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockResolvedValue(result);
    const refreshCanonical = vi.fn()
      .mockRejectedValueOnce(new Error('GET failed'))
      .mockResolvedValueOnce(detail);
    const owner = props({ refreshCanonical });
    render(<MockThisDialog {...owner} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Retry canonical refresh' }));

    expect(promote).toHaveBeenCalledOnce();
    expect(refreshCanonical).toHaveBeenCalledTimes(2);
    expect(owner.onPromoted).toHaveBeenCalledWith(result);
  });

  it('retries only canonical GET while an unknown outcome remains unreconciled', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockRejectedValue(new Error('connection lost'));
    const promoted = { ...detail, promotion: { state: 'promoted' as const, result } };
    const refreshCanonical = vi.fn()
      .mockRejectedValueOnce(new Error('GET failed'))
      .mockResolvedValueOnce(promoted);
    const owner = props({ refreshCanonical });
    render(<MockThisDialog {...owner} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Mock This' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Retry canonical refresh' }));

    expect(promote).toHaveBeenCalledOnce();
    expect(refreshCanonical).toHaveBeenCalledTimes(2);
    expect(owner.onPromoted).toHaveBeenCalledWith(result);
  });

  it.each([
    ['query_parse_invalid', 'request cannot become a canonical matcher'],
    ['invalid_content_encoding', 'captured entity cannot be reproduced safely'],
    ['body_truncated', 'exact response body is truncated'],
    ['body_evicted', 'exact response body was evicted'],
  ] as const)('blocks %s without rendering or submitting a review', (reason, copy) => {
    const promote = vi.spyOn(trafficApi, 'promote');
    render(<MockThisDialog {...props({
      detail: { ...detail, promotion: { state: 'blocked', reason } },
    })} />);
    expect(screen.getByText(new RegExp(copy, 'i'))).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm Mock This' })).not.toBeInTheDocument();
    expect(promote).not.toHaveBeenCalled();
  });
});
