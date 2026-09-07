import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense, startTransition } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrafficDetail, TrafficSummary } from '../api/types';
import { trafficApi } from '../api/client';
import { TrafficView } from './TrafficView';

const props = {
  onSelectTraffic: vi.fn(), paused: false, onTogglePaused: vi.fn(), onClear: vi.fn(), onRefresh: vi.fn(),
  states: [{
    id: 'state_reviewed', projectId: 'prj_1', name: 'Reviewed State', tags: [], revision: 4,
    boundEndpointCount: 1, totalEndpointCount: 1,
  }],
};

const summary: TrafficSummary = {
  id: 'traffic_1', generation: 'generation-1', projectId: 'prj_1', requestId: 'req_1',
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.005Z', durationMs: 5,
  transport: 'direct', allowlistPattern: 'api.example.test', origin: 'https://api.example.test',
  method: 'GET', path: '/playback', queryNames: [], decision: 'mock', status: 200, responseBytes: 2,
  requestBodyState: 'unavailable', responseBodyState: 'unavailable',
};

const detail: TrafficDetail = {
  ...summary,
  request: {
    query: [],
    headers: [],
    body: { side: 'request', state: 'unavailable', observedSize: 0, reason: 'body_unobservable' },
  },
  response: {
    headers: [],
    body: { side: 'response', state: 'unavailable', observedSize: 0, reason: 'body_unobservable' },
  },
  appState: {
    mode: 'disabled', resolutionSource: 'endpoint_default',
    fallbackReasons: ['app_state_mode_disabled'],
  },
  variantId: 'var_default',
  captureState: 'complete',
  promotion: { state: 'blocked', reason: 'body_unavailable' },
};

const promotable: TrafficDetail = {
  ...detail,
  promotion: {
    state: 'eligible',
    review: {
      expectedTrafficGeneration: 'generation-reviewed',
      expectedResponseIdentity: 'response-reviewed',
      request: {
        origin: detail.origin,
        method: detail.method,
        path: detail.path,
        query: [],
        headers: [],
        sensitiveQueryNames: [],
      },
      response: {
        status: detail.status,
        headers: [],
        mediaType: 'application/json',
        byteCount: 2,
        sha256: 'ab'.repeat(32),
        sensitiveHeaderNames: [],
      },
      endpoint: {
        action: 'reuse',
        endpointId: 'ep_reviewed',
        expectedRevision: 7,
        currentMode: 'passthrough',
        targetMode: 'mock',
      },
      variant: { action: 'reuse', variantId: 'var_reviewed' },
      state: { action: 'bind', stateId: 'state_reviewed', expectedRevision: 4 },
      defaultStateId: 'state_reviewed',
      warnings: [],
    },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clickMockThis() {
  fireEvent.click(screen.getByRole('button', { name: 'Mock This' }));
}

const promotionResult = {
  endpointId: 'ep_reviewed',
  endpointCreated: false,
  variantId: 'var_reviewed',
  variantCreated: false,
  endpointModeChanged: true,
  stateId: 'state_reviewed',
  bindingChanged: true,
};

function SuspendAfterTrafficView({ suspend, suspension }: {
  suspend: boolean;
  suspension: Promise<never>;
}) {
  if (suspend) throw suspension;
  return null;
}

function concurrentTrafficView({
  projectId,
  trafficId = 'traffic_1',
  suspend,
  suspension,
  onMockCreated,
}: {
  projectId: string;
  trafficId?: string;
  suspend: boolean;
  suspension: Promise<never>;
  onMockCreated: () => void;
}) {
  const currentSummary = projectId === 'prj_1' && trafficId === 'traffic_1'
    ? summary
    : { ...summary, projectId, id: trafficId, path: '/other-scope' };
  return (
    <Suspense fallback={<span>Suspended Traffic</span>}>
      <TrafficView
        {...props}
        traffic={[currentSummary]}
        selectedTraffic={{ ...promotable, ...currentSummary }}
        projectId={projectId}
        onMockCreated={onMockCreated}
      />
      <SuspendAfterTrafficView suspend={suspend} suspension={suspension} />
    </Suspense>
  );
}

describe('TrafficView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders sticky overview fields without the metadata workspace', () => {
    render(<TrafficView {...props} traffic={[summary]} selectedTraffic={detail} projectId="prj_1" />);
    fireEvent.click(screen.getByText('/playback'));

    expect(screen.getByText('https://api.example.test/playback')).toBeVisible();
    expect(screen.getAllByText('mock').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2 B').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Mock This' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mock This' }))
      .toHaveAttribute('title', expect.stringContaining('unavailable'));
    expect(screen.queryByText('endpoint_default')).not.toBeInTheDocument();
    expect(screen.queryByText('app_state_mode_disabled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'query' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'body' })).not.toBeInTheDocument();
  });

  it('omits absent request query and keeps response body when retained', () => {
    const richSummary: TrafficSummary = {
      ...summary,
      path: '/metadata',
      durationMs: 12,
      decision: 'endpoint_passthrough',
      responseBytes: 1536,
      requestBodyState: 'available',
      responseBodyState: 'evicted',
    };
    const richDetail: TrafficDetail = {
      ...detail,
      ...richSummary,
      request: {
        query: [{ name: 'token', value: '[REDACTED]' }],
        headers: [
          ['authorization', '[REDACTED]'],
          ['x-repeat', 'one'],
          ['x-repeat', 'two'],
        ],
        preview: { encoding: 'utf8', value: 'request preview', truncated: false },
        body: {
          side: 'request', state: 'available', mediaType: 'application/json',
          contentEncoding: 'gzip', observedSize: 24, retainedSize: 24, sha256: 'a'.repeat(64),
        },
      },
      response: {
        headers: [
          ['set-cookie', '[REDACTED]'],
          ['set-cookie', '[REDACTED]'],
        ],
        preview: { encoding: 'utf8', value: 'response preview', truncated: true },
        body: {
          side: 'response', state: 'evicted', mediaType: 'application/json',
          observedSize: 1536, retainedSize: 1536, sha256: 'b'.repeat(64),
          reason: 'retention_evicted',
        },
      },
      promotion: { state: 'blocked', reason: 'body_evicted' },
    };
    render(<TrafficView {...props} traffic={[richSummary]} selectedTraffic={richDetail} projectId="prj_1" />);
    fireEvent.click(screen.getByText('/metadata'));

    expect(screen.getByText('https://api.example.test/metadata?token=%5BREDACTED%5D')).toBeVisible();
    expect(screen.getByText('endpoint passthrough')).toBeVisible();
    expect(screen.getAllByText('12 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.5 KB').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'query' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'body' })).toHaveLength(2);
    expect(screen.queryByText('request preview')).not.toBeInTheDocument();
    expect(screen.queryByText('response preview')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'query' }));
    expect(screen.getAllByText('[REDACTED]').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'headers' })[1]!);
    expect(screen.getAllByText('[REDACTED]').length).toBeGreaterThanOrEqual(2);
  });

  it('requests detail only when a row is selected', () => {
    render(<TrafficView {...props} traffic={[summary]} selectedTraffic={null} projectId="prj_1" />);
    expect(props.onSelectTraffic).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('/playback'));
    expect(props.onSelectTraffic).toHaveBeenCalledWith('traffic_1');
  });

  it('keeps Traffic rows interactive while an exact response body is pending', async () => {
    const body = deferred<Response>();
    const signal: AbortSignal[] = [];
    vi.spyOn(trafficApi, 'body').mockImplementation((_project, _traffic, _side, owner) => {
      signal.push(owner!);
      return body.promise;
    });
    const exactSummary: TrafficSummary = {
      ...summary,
      responseBodyState: 'available',
    };
    const exactDetail: TrafficDetail = {
      ...detail,
      ...exactSummary,
      response: {
        ...detail.response,
        preview: { encoding: 'utf8', value: 'immediate body preview', truncated: true },
        body: {
          side: 'response', state: 'available', mediaType: 'text/plain', observedSize: 5,
          retainedSize: 5, sha256: 'e'.repeat(64),
        },
      },
    };
    const second = { ...summary, id: 'traffic_2', path: '/still-interactive' };
    render(<TrafficView
      {...props}
      traffic={[exactSummary, second]}
      selectedTraffic={exactDetail}
      projectId="prj_1"
    />);
    fireEvent.click(screen.getByText('/playback'));
    fireEvent.click(screen.getByRole('button', { name: 'body' }));

    expect(screen.queryByText('immediate body preview')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Response exact body progress')).toBeVisible();
    fireEvent.click(screen.getByText('/still-interactive'));

    expect(props.onSelectTraffic).toHaveBeenLastCalledWith('traffic_2');
    await waitFor(() => expect(signal[0]?.aborted).toBe(true));
  });

  it('replaces rejected detail loading with an unavailable error state', () => {
    render(<TrafficView
      {...props}
      traffic={[summary]}
      selectedTraffic={null}
      projectId="prj_1"
      detailLoading={false}
      detailError="Traffic detail unavailable"
    />);
    fireEvent.click(screen.getByText('/playback'));

    expect(screen.getByText('Traffic detail unavailable')).toBeVisible();
    expect(screen.queryByText('Request detail unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading request detail...')).not.toBeInTheDocument();
  });

  it('renders repeated response headers as separate rows in order', () => {
    const cookies: TrafficDetail = {
      ...detail,
      response: {
        ...detail.response,
        headers: [
          ['set-cookie', 'session=one; Path=/'],
          ['set-cookie', 'theme=dark; Path=/'],
        ],
      },
    };
    render(<TrafficView {...props} traffic={[summary]} selectedTraffic={cookies} projectId="prj_1" />);
    fireEvent.click(screen.getByText('/playback'));

    const first = screen.getByText('session=one; Path=/');
    const second = screen.getByText('theme=dark; Path=/');
    expect(first.closest('tr')).not.toBe(second.closest('tr'));
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('one-click Mock This posts unbound with reviewed endpoint reuse', async () => {
    const promote = vi.spyOn(trafficApi, 'promote').mockResolvedValue(promotionResult);
    render(<TrafficView {...props} traffic={[summary]} selectedTraffic={promotable} projectId="prj_1" />);
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();

    await waitFor(() => expect(promote).toHaveBeenCalledWith('prj_1', 'traffic_1', {
      expectedTrafficGeneration: 'generation-reviewed',
      expectedResponseIdentity: 'response-reviewed',
      endpoint: { action: 'reuse', endpointId: 'ep_reviewed', expectedRevision: 7 },
      state: { action: 'unbound' },
    }, expect.any(AbortSignal)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Mock created')).toBeVisible();
  });

  it('one-click Mock This creates an endpoint when review says create', async () => {
    const createDetail: TrafficDetail = {
      ...promotable,
      promotion: {
        state: 'eligible',
        review: {
          ...promotable.promotion.state === 'eligible' ? promotable.promotion.review : ({} as never),
          endpoint: { action: 'create', targetMode: 'mock' },
        },
      },
    };
    const promote = vi.spyOn(trafficApi, 'promote').mockResolvedValue({
      ...promotionResult,
      endpointCreated: true,
      endpointId: 'ep_new',
    });
    render(<TrafficView {...props} traffic={[summary]} selectedTraffic={createDetail} projectId="prj_1" />);
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();

    await waitFor(() => expect(promote).toHaveBeenCalledWith('prj_1', 'traffic_1', expect.objectContaining({
      endpoint: { action: 'create' },
      state: { action: 'unbound' },
    }), expect.any(AbortSignal)));
  });

  it('keeps a committed promotion success valid through an interrupted scope render', async () => {
    const pending = deferred<typeof promotionResult>();
    const suspension = new Promise<never>(() => undefined);
    vi.spyOn(trafficApi, 'promote').mockReturnValue(pending.promise);
    const onMockCreated = vi.fn();
    const { rerender } = render(concurrentTrafficView({
      projectId: 'prj_1', suspend: false, suspension, onMockCreated,
    }));
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();

    act(() => {
      startTransition(() => rerender(concurrentTrafficView({
        projectId: 'prj_1', trafficId: 'traffic_2', suspend: true, suspension, onMockCreated,
      })));
    });
    expect(screen.queryByText('Suspended Traffic')).not.toBeInTheDocument();
    await act(async () => pending.resolve(promotionResult));

    expect(onMockCreated).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed promotion failure valid through an interrupted scope render', async () => {
    const pending = deferred<typeof promotionResult>();
    const suspension = new Promise<never>(() => undefined);
    vi.spyOn(trafficApi, 'promote').mockReturnValue(pending.promise);
    const onMockCreated = vi.fn();
    const { rerender } = render(concurrentTrafficView({
      projectId: 'prj_1', suspend: false, suspension, onMockCreated,
    }));
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();

    act(() => {
      startTransition(() => rerender(concurrentTrafficView({
        projectId: 'prj_2', suspend: true, suspension, onMockCreated,
      })));
    });
    await act(async () => pending.reject(new Error('committed promotion failure')));

    expect(await screen.findByText(/Promotion outcome is unknown/)).toBeVisible();
    expect(onMockCreated).not.toHaveBeenCalled();
  });

  it('ignores an old promotion rejection after switching Projects', async () => {
    const pending = deferred<typeof promotionResult>();
    const promote = vi.spyOn(trafficApi, 'promote').mockReturnValue(pending.promise);
    const onMockCreated = vi.fn();
    const { rerender } = render(
      <TrafficView
        {...props}
        traffic={[summary]}
        selectedTraffic={promotable}
        projectId="prj_1"
        onMockCreated={onMockCreated}
      />,
    );
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();

    const currentSummary = {
      ...summary,
      id: 'traffic_current',
      generation: 'generation-current',
      projectId: 'prj_2',
      path: '/current-project',
    };
    rerender(<TrafficView
      {...props}
      traffic={[currentSummary]}
      selectedTraffic={{ ...promotable, ...currentSummary }}
      projectId="prj_2"
      onMockCreated={onMockCreated}
    />);
    expect(promote.mock.calls[0]?.[3]?.aborted).toBe(true);
    fireEvent.click(screen.getByText('/current-project'));
    await act(async () => pending.reject(new Error('stale Project promotion failure')));

    expect(screen.queryByText('stale Project promotion failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mock This' })).toBeEnabled();
    expect(onMockCreated).not.toHaveBeenCalled();
  });

  it('ignores an old promotion success after selecting another Traffic detail', async () => {
    const pending = deferred<typeof promotionResult>();
    const promote = vi.spyOn(trafficApi, 'promote').mockReturnValue(pending.promise);
    const onMockCreated = vi.fn();
    const secondSummary = { ...summary, id: 'traffic_2', path: '/second' };
    const secondDetail = { ...promotable, ...secondSummary };
    const { rerender } = render(
      <TrafficView
        {...props}
        traffic={[summary, secondSummary]}
        selectedTraffic={promotable}
        projectId="prj_1"
        onMockCreated={onMockCreated}
      />,
    );
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();
    fireEvent.click(screen.getByText('/second'));
    expect(promote.mock.calls[0]?.[3]?.aborted).toBe(true);
    rerender(<TrafficView
      {...props}
      traffic={[summary, secondSummary]}
      selectedTraffic={secondDetail}
      projectId="prj_1"
      onMockCreated={onMockCreated}
    />);

    await act(async () => pending.resolve(promotionResult));

    expect(onMockCreated).not.toHaveBeenCalled();
  });

  it('publishes a current promotion error and clears it for a successful retry', async () => {
    const first = deferred<typeof promotionResult>();
    const second = deferred<typeof promotionResult>();
    const promote = vi.spyOn(trafficApi, 'promote')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onMockCreated = vi.fn();
    render(<TrafficView
      {...props}
      traffic={[summary]}
      selectedTraffic={promotable}
      projectId="prj_1"
      onMockCreated={onMockCreated}
    />);
    fireEvent.click(screen.getByText('/playback'));
    clickMockThis();
    await act(async () => first.reject(new Error('current promotion failure')));
    await waitFor(() => expect(screen.getByText(/Promotion outcome is unknown/)).toBeVisible());

    clickMockThis();
    expect(screen.queryByText(/Promotion outcome is unknown/)).not.toBeInTheDocument();
    await act(async () => second.resolve(promotionResult));
    await waitFor(() => expect(onMockCreated).toHaveBeenCalledTimes(1));
    expect(promote).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Promotion outcome is unknown/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mock This' })).toBeEnabled();
  });
});
