import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type {
  AppStateSummary,
  Project,
  TrafficDetail,
  TrafficSummary,
} from './api/types';
import type { ViewType } from './components/ProjectList';

const projectA: Project = {
  schemaVersion: 4,
  id: 'prj_a',
  name: 'Traffic A',
  appStateMode: 'enabled',
  activeStateId: 'state_reviewed',
  revision: 1,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};
const projectB: Project = { ...projectA, id: 'prj_b', name: 'Traffic B' };
const reviewedState: AppStateSummary = {
  id: 'state_reviewed',
  projectId: projectA.id,
  name: 'Reviewed State',
  tags: [],
  revision: 4,
  boundEndpointCount: 0,
  totalEndpointCount: 0,
  missingEndpointIds: [],
};

function summary(id: string, path: string): TrafficSummary {
  return {
    id,
    generation: `generation-${id}`,
    projectId: projectA.id,
    requestId: `request-${id}`,
    startedAt: '2026-09-02T00:00:00.000Z',
    completedAt: '2026-09-02T00:00:00.005Z',
    durationMs: 5,
    transport: 'https_mitm',
    allowlistPattern: 'api.example.test',
    origin: 'https://api.example.test',
    method: 'GET',
    path,
    queryNames: [],
    decision: 'no_match_passthrough',
    status: 200,
    responseBytes: 5,
    requestBodyState: 'unavailable',
    responseBodyState: 'available',
  };
}

const summaries = [
  summary('trf_1', '/body-one'),
  summary('trf_2', '/body-two'),
  summary('trf_3', '/body-three'),
  summary('trf_binary', '/binary'),
  summary('trf_promote_known', '/promote-known'),
  summary('trf_promote', '/promote'),
];

function detail(item: TrafficSummary, mediaType = 'text/plain'): TrafficDetail {
  return {
    ...item,
    request: {
      query: [],
      headers: [],
      body: { side: 'request', state: 'unavailable', observedSize: 0, reason: 'body_unobservable' },
    },
    response: {
      headers: [['content-type', mediaType]],
      preview: { encoding: 'utf8', value: `preview:${item.path}`, truncated: true },
      body: {
        side: 'response',
        state: 'available',
        mediaType,
        observedSize: 5,
        retainedSize: 5,
        sha256: item.id.padEnd(64, '0').slice(0, 64),
      },
    },
    appState: { mode: 'enabled', fallbackReasons: ['active_state_unbound'] },
    captureState: 'complete',
    promotion: { state: 'blocked', reason: 'body_unavailable' },
  };
}

function promotable(item: TrafficSummary): TrafficDetail {
  return {
    ...detail(item),
    promotion: {
      state: 'eligible',
      review: {
        expectedTrafficGeneration: item.generation,
        expectedResponseIdentity: `response-${item.id}`,
        request: {
          origin: 'https://api.example.test', method: 'GET', path: item.path,
          query: [], headers: [], sensitiveQueryNames: [],
        },
        response: {
          status: 200, headers: [], mediaType: 'text/plain', byteCount: 5,
          sha256: 'a'.repeat(64), sensitiveHeaderNames: [],
        },
        endpoint: { action: 'create', targetMode: 'mock' },
        variant: { action: 'create', deterministicName: 'Captured 200' },
        state: { action: 'bind', stateId: reviewedState.id, expectedRevision: reviewedState.revision },
        defaultStateId: reviewedState.id,
        warnings: [],
      },
    },
  };
}

const promotionResult = {
  endpointId: 'ep_reviewed', endpointCreated: true,
  variantId: 'var_reviewed', variantCreated: true,
  endpointModeChanged: false, stateId: reviewedState.id, bindingChanged: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

let layoutProject = projectA;

vi.mock('./components/Layout', () => {
  function MockLayout({ activeView, onSelectView, children }: {
    activeView: ViewType;
    onSelectView(view: ViewType): void;
    children(project: Project, refresh: () => Promise<void>): ReactNode;
  }) {
    const [, rerenderProject] = useState(0);
    const switchProject = (project: Project) => {
      layoutProject = project;
      rerenderProject(value => value + 1);
    };
    return (
      <div>
        <button role="tab" aria-selected={activeView === 'traffic'} onClick={() => onSelectView('traffic')}>Traffic</button>
        <button type="button" onClick={() => switchProject(projectB)}>Switch Project</button>
        <button type="button" onClick={() => switchProject(projectA)}>Return Project A</button>
        {children(layoutProject, async () => undefined)}
      </div>
    );
  }
  return { default: MockLayout };
});

vi.mock('./hooks/useRepositoryDiagnostics', () => ({
  useRepositoryDiagnostics: () => ({ diagnostics: [], loading: false, refresh: vi.fn() }),
}));

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('App Traffic owner integration', () => {
  const bodyResponses = new Map<string, ReturnType<typeof deferred<Response>>>();
  const bodySignals = new Map<string, AbortSignal>();
  const bodyRequests = new Map<string, number>();
  let failCanonicalRefresh = false;
  let detailRequests = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    layoutProject = projectA;
    bodyResponses.clear();
    bodySignals.clear();
    bodyRequests.clear();
    failCanonicalRefresh = false;
    detailRequests = 0;
    for (const id of ['trf_1', 'trf_2', 'trf_3']) bodyResponses.set(id, deferred<Response>());

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const projectId = url.includes('/projects/prj_b/') ? projectB.id : projectA.id;
      if (url.endsWith(`/projects/${projectId}/endpoints`)) {
        if (failCanonicalRefresh) {
          failCanonicalRefresh = false;
          return Promise.resolve(json({ code: 'FAILED', message: 'canonical refresh failed' }, 500));
        }
        return Promise.resolve(json([]));
      }
      if (url.endsWith(`/projects/${projectId}/states`)) {
        return Promise.resolve(json(projectId === projectA.id ? [reviewedState] : []));
      }
      if (url.includes(`/projects/${projectId}/traffic?`)) {
        return Promise.resolve(json({
          entries: projectId === projectA.id ? summaries : [],
          reset: true,
          latestId: projectId === projectA.id ? 'trf_promote' : undefined,
        }));
      }
      const bodyMatch = /\/traffic\/(trf_[^/]+)\/bodies\/response/.exec(url);
      if (bodyMatch) {
        const trafficId = bodyMatch[1]!;
        const owner = init?.signal;
        if (owner) bodySignals.set(trafficId, owner);
        bodyRequests.set(trafficId, (bodyRequests.get(trafficId) ?? 0) + 1);
        if (trafficId === 'trf_2') {
          return Promise.resolve(new Response('two!!', {
            headers: {
              'Content-Length': '5',
              'Content-Type': 'text/plain',
              'X-MockMate-Sha256': trafficId.padEnd(64, '0').slice(0, 64),
            },
          }));
        }
        return bodyResponses.get(trafficId)?.promise
          ?? Promise.resolve(new Response('binary', { headers: { 'Content-Type': 'application/octet-stream' } }));
      }
      const detailMatch = /\/traffic\/(trf_[^/?]+)$/.exec(url);
      if (detailMatch) {
        detailRequests += 1;
        const item = summaries.find(candidate => candidate.id === detailMatch[1])!;
        if (item.id.startsWith('trf_promote')) return Promise.resolve(json(promotable(item)));
        return Promise.resolve(json(detail(item, item.id === 'trf_binary' ? 'application/octet-stream' : 'text/plain')));
      }
      if (url.endsWith('/traffic/trf_promote_known/mock') && method === 'POST') {
        return Promise.resolve(json(promotionResult));
      }
      if (url.endsWith('/traffic/trf_promote/mock') && method === 'POST') {
        failCanonicalRefresh = true;
        return Promise.reject(new TypeError('promotion response was lost'));
      }
      if (url.endsWith('/endpoints/ep_reviewed')) return Promise.resolve(json({ id: 'ep_reviewed' }));
      if (url.endsWith(`/states/${reviewedState.id}`)) return Promise.resolve(json(reviewedState));
      return Promise.reject(new Error(`Unhandled fetch: ${method} ${url}`));
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('invalidates scoped owners while preserving body cache and one-click Mock This', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('tab', { name: 'Traffic' }));
    await screen.findByText('/body-one');

    await user.click(screen.getByText('/body-one'));
    await user.click(await screen.findByRole('button', { name: 'body' }));
    expect(await screen.findByLabelText('Response exact body progress')).toBeVisible();
    await user.click(screen.getByText('/body-two'));
    await user.click(await screen.findByRole('button', { name: 'body' }));
    expect(screen.queryByText('preview:/body-two')).not.toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    await user.click(screen.getByText('/body-three'));
    await user.click(await screen.findByRole('button', { name: 'body' }));
    await waitFor(() => expect(bodySignals.get('trf_1')?.aborted).toBe(true));
    expect(bodySignals.get('trf_2')?.aborted).toBe(false);
    expect(bodySignals.get('trf_3')?.aborted).toBe(false);

    await user.click(screen.getByText('/body-two'));
    await user.click(await screen.findByRole('button', { name: 'body' }));
    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    expect(bodyRequests.get('trf_2')).toBe(1);

    await user.click(screen.getByText('/binary'));
    await user.click(await screen.findByRole('button', { name: 'body' }));
    expect(await screen.findByText('Binary exact body is available as a download.')).toBeVisible();
    expect(bodySignals.has('trf_binary')).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Response exact body' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download response body' })).toHaveAttribute(
      'href',
      '/api/admin/projects/prj_a/traffic/trf_binary/bodies/response?download=1',
    );

    const pendingDetail = user.click(screen.getByText('/body-one'));
    await pendingDetail;
    await user.click(await screen.findByRole('button', { name: 'body' }));
    await waitFor(() => expect(bodySignals.get('trf_1')?.aborted).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Switch Project' }));
    expect(bodySignals.get('trf_1')?.aborted).toBe(true);
    expect(screen.queryByText('/body-one')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Traffic B.*Traffic/ })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Return Project A' }));
    await screen.findByText('/promote-known');
    await user.click(screen.getByText('/promote-known'));
    await user.click(await screen.findByRole('button', { name: 'Mock This' }));
    expect(await screen.findByText('Mock created')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/endpoints/ep_reviewed'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/states/${reviewedState.id}`))).toBe(true);
    expect(fetchMock.mock.calls.some(([url, init]) => (
      String(url).endsWith('/traffic/trf_promote_known/mock')
      && init?.method === 'POST'
      && String(init.body ?? '').includes('"action":"unbound"')
    ))).toBe(true);

    await screen.findByText('/promote');
    await user.click(screen.getByText('/promote'));
    await screen.findByRole('button', { name: 'Mock This' });
    await user.click(screen.getByRole('button', { name: 'Mock This' }));
    expect(await screen.findByText(/Promotion outcome is unknown and canonical refresh failed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry canonical refresh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Mock This' })).not.toBeInTheDocument();

    expect(fetchMock.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/traffic/trf_promote/mock') && init?.method === 'POST'
    ))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/endpoints'))
      .length).toBeGreaterThan(1);
  });
});
