import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { TrafficJsonSearchResult, TrafficJsonSearchSkipped } from '../api/types';
import { TrafficSearchPanel } from './TrafficSearchPanel';

function skipped(patch: Partial<TrafficJsonSearchSkipped> = {}): TrafficJsonSearchSkipped {
  return {
    unavailable: 0, truncated: 0, evicted: 0, unsupportedEncoding: 0,
    invalidUtf8: 0, notJson: 0, changedDuringSearch: 0, searchBudgetExceeded: 0,
    ...patch,
  };
}

const sampleResult: TrafficJsonSearchResult = {
  traffic: {
    id: 'trf_1', generation: 'g1', projectId: 'prj_1', requestId: 'req_1',
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1, transport: 'https_mitm', allowlistPattern: 'api.example.com',
    origin: 'https://api.example.com', method: 'POST', path: '/users', queryNames: [],
    decision: 'endpoint_passthrough', status: 200, responseBytes: 2,
    requestBodyState: 'unavailable', responseBodyState: 'available',
  },
  side: 'response',
  matchCount: 3,
  matches: [{ jsonPointer: '/user', kind: 'value', occurrence: 1, snippet: 'needle' }],
};

function panelProps(overrides: Partial<React.ComponentProps<typeof TrafficSearchPanel>> = {}) {
  return {
    query: '',
    onQueryChange: vi.fn(),
    results: [],
    skipped: skipped(),
    activeQuery: '',
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    onLoadMore: vi.fn(),
    onOpenResult: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('TrafficSearchPanel', () => {
  it('renders results with match counts and opens a result on click', async () => {
    const onOpenResult = vi.fn();
    render(<TrafficSearchPanel {...panelProps({
      results: [sampleResult],
      activeQuery: 'needle',
      onOpenResult,
    })} />);

    expect(screen.getByText('3 matches')).toBeVisible();
    expect(screen.getByText('https://api.example.com/users')).toBeVisible();
    await userEvent.click(screen.getByText('https://api.example.com/users'));
    expect(onOpenResult).toHaveBeenCalledWith(sampleResult);
  });

  it('summarizes skipped bodies', () => {
    render(<TrafficSearchPanel {...panelProps({
      activeQuery: 'needle',
      skipped: skipped({ notJson: 2, evicted: 1 }),
    })} />);

    expect(screen.getByText('3 bodies skipped: evicted 1, not valid JSON 2')).toBeVisible();
  });

  it('shows an empty state only after an active query returns nothing', () => {
    const { rerender } = render(<TrafficSearchPanel {...panelProps()} />);
    expect(screen.queryByText('No JSON matches')).not.toBeInTheDocument();

    rerender(<TrafficSearchPanel {...panelProps({ activeQuery: 'needle', results: [] })} />);
    expect(screen.getByText('No JSON matches')).toBeVisible();
  });

  it('loads more and closes through their callbacks', async () => {
    const onLoadMore = vi.fn();
    const onClose = vi.fn();
    render(<TrafficSearchPanel {...panelProps({
      results: [sampleResult],
      activeQuery: 'needle',
      hasMore: true,
      onLoadMore,
      onClose,
    })} />);

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close JSON search' }));
    expect(onClose).toHaveBeenCalled();
  });
});
