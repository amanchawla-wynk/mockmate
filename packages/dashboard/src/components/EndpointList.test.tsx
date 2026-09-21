import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EndpointSummary } from '../api/types';
import { EndpointList } from './EndpointList';

export const endpointSummary: EndpointSummary = {
  schemaVersion: 4,
  id: 'ep_playback',
  projectId: 'prj_1',
  name: 'Playback authorization',
  baseUrl: 'https://api.example.test',
  mode: 'passthrough',
  method: 'GET',
  path: '/playback',
  queryConstraintCount: 3,
  headerConstraintCount: 2,
  variantCount: 5,
  mockReady: false,
  revision: 4,
};

function endpoint(overrides: Partial<EndpointSummary>): EndpointSummary {
  return { ...endpointSummary, ...overrides };
}

describe('EndpointList', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('loads one Endpoint detail after selection', async () => {
    const onSelect = vi.fn();
    render(
      <EndpointList
        endpoints={[endpointSummary]}
        selectedEndpointId={undefined}
        onSelect={onSelect}
        onImport={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText('Playback authorization'));
    expect(onSelect).toHaveBeenCalledWith('ep_playback');
    expect(screen.getByText('5 variants')).toBeVisible();
    expect(screen.getByText('Passthrough')).toBeVisible();
    expect(screen.getByText('Mock not ready')).toBeVisible();
    expect(screen.getByText('3 query expressions')).toBeVisible();
    expect(screen.getByText('2 header constraints')).toBeVisible();
  });

  it('keeps Import and New Endpoint as distinct authoring actions', async () => {
    const onImport = vi.fn();
    const onCreate = vi.fn();
    render(
      <EndpointList
        endpoints={[endpointSummary]}
        selectedEndpointId={undefined}
        onSelect={vi.fn()}
        onImport={onImport}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();

    onImport.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'New Endpoint' }));
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByText('GET https://api.example.test/playback')).toBeVisible();
    expect(screen.getByText('5 variants')).toBeVisible();
  });

  it('derives sorted origin and literal path folders without colliding leaves', async () => {
    window.localStorage.setItem('mockmate.endpoint-view.v1', 'tree');
    const endpoints = [
      endpoint({ id: 'ep_root', name: 'Root', method: 'POST', path: '/' }),
      endpoint({ id: 'ep_constraint_b', name: 'Constrained B', path: '/users/{id}/' }),
      endpoint({ id: 'ep_constraint_a', name: 'Constrained A', path: '/users/{id}' }),
      endpoint({ id: 'ep_literal', name: 'Literal user', path: '/users/123' }),
      endpoint({ id: 'ep_encoded', name: 'Encoded glob', path: '/files/%2F/*/:id' }),
      endpoint({
        id: 'ep_other_origin',
        name: 'Other origin',
        baseUrl: 'http://admin.example.test:8080',
        path: '/health',
      }),
    ];
    const onSelect = vi.fn();
    render(
      <EndpointList
        endpoints={endpoints}
        selectedEndpointId="ep_constraint_b"
        onSelect={onSelect}
        onImport={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    const tree = screen.getByRole('tree', { name: 'Endpoints by origin and path' });
    const items = screen.getAllByRole('treeitem');
    expect(tree).toBeVisible();
    expect(items[0]).toHaveTextContent('http://admin.example.test:8080');
    expect(items[1]).toHaveTextContent('https://api.example.test');
    expect(screen.getByRole('treeitem', { name: /users/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: /\{id\}/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: /Constrained A/ })).toBeVisible();
    expect(screen.getByRole('treeitem', { name: /Constrained B/ })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('treeitem', { name: /Constrained A/ }));
    expect(onSelect).toHaveBeenCalledWith('ep_constraint_a');

    await userEvent.click(screen.getByRole('treeitem', { name: /files/ }));
    await userEvent.click(screen.getByRole('treeitem', { name: /%2F/ }));
    await userEvent.click(screen.getByRole('treeitem', { name: '*' }));
    await userEvent.click(screen.getByRole('treeitem', { name: /:id/ }));
    await userEvent.click(screen.getByRole('treeitem', { name: '123' }));
    await userEvent.click(screen.getByRole('treeitem', { name: 'http://admin.example.test:8080' }));
    await userEvent.click(screen.getByRole('treeitem', { name: 'health' }));

    for (const name of ['Root', 'Constrained A', 'Constrained B', 'Literal user', 'Encoded glob', 'Other origin']) {
      expect(screen.getAllByRole('treeitem', { name: new RegExp(name) })).toHaveLength(1);
    }
    expect(screen.getByRole('treeitem', { name: /Constrained A/ })
      .compareDocumentPosition(screen.getByRole('treeitem', { name: /Constrained B/ }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(screen.getByRole('treeitem', { name: '{id}' }));
    expect(screen.queryByRole('treeitem', { name: /Constrained B/ })).not.toBeInTheDocument();
  });

  it('persists the view locally and keeps selection across view switches', async () => {
    const onSelect = vi.fn();
    const renderResult = render(
      <EndpointList
        endpoints={[endpointSummary]}
        selectedEndpointId="ep_playback"
        onSelect={onSelect}
        onImport={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(window.localStorage.getItem('mockmate.endpoint-view.v1')).toBe('tree');
    expect(screen.getByRole('treeitem', { name: /Playback authorization/ }))
      .toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByText('Playback authorization').closest('button'))
      .toHaveClass('border-blue-300');

    await userEvent.click(screen.getByRole('button', { name: 'Tree' }));
    renderResult.unmount();
    render(
      <EndpointList
        endpoints={[endpointSummary]}
        selectedEndpointId="ep_playback"
        onSelect={onSelect}
        onImport={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Tree' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('treeitem', { name: /Playback authorization/ })).toBeVisible();
  });

  it('supports tree arrow navigation and expand/collapse semantics', async () => {
    window.localStorage.setItem('mockmate.endpoint-view.v1', 'tree');
    render(
      <EndpointList
        endpoints={[endpointSummary]}
        selectedEndpointId={undefined}
        onSelect={vi.fn()}
        onImport={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    const origin = screen.getByRole('treeitem', { name: /https:\/\/api\.example\.test/ });
    expect(origin).toHaveAttribute('aria-expanded', 'false');
    act(() => origin.focus());
    fireEvent.keyDown(origin, { key: 'ArrowRight' });
    expect(origin).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(origin, { key: 'ArrowRight' });
    const path = screen.getByRole('treeitem', { name: /playback/ });
    expect(path).toHaveFocus();
    fireEvent.keyDown(path, { key: 'ArrowLeft' });
    expect(origin).toHaveFocus();
    fireEvent.keyDown(origin, { key: 'ArrowLeft' });
    expect(origin).toHaveAttribute('aria-expanded', 'false');
  });

  it('defaults safely when browser storage is invalid or inaccessible', async () => {
    window.localStorage.setItem('mockmate.endpoint-view.v1', 'invalid');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    getItem.mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    render(
      <EndpointList
        endpoints={[endpointSummary]}
        selectedEndpointId={undefined}
        onSelect={vi.fn()}
        onImport={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(screen.getByRole('tree')).toBeVisible();
  });
});
