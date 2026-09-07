import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EndpointDetail, ResponseVariant } from '../api/types';
import { EndpointEditor } from './EndpointEditor';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EndpointEditor real client integration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates and selects an atomic first Serving now Variant before switching to mock', async () => {
    const emptyEndpoint: EndpointDetail = {
      schemaVersion: 4,
      id: 'ep_1',
      projectId: 'prj_1',
      name: 'Playback',
      baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/playback' },
      mode: 'passthrough',
      variants: [],
      revision: 4,
    };
    const created: ResponseVariant = {
      id: 'var_first',
      endpointId: 'ep_1',
      name: 'First response',
      status: 200,
      responseHeaders: {},
      revision: 0,
    };
    let canonical: EndpointDetail = emptyEndpoint;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/endpoints/ep_1/variants') && init?.method === 'POST') {
        canonical = {
          ...canonical,
          defaultVariantId: created.id,
          variants: [created],
          revision: 5,
        };
        return jsonResponse(created, 201);
      }
      if (url.endsWith('/endpoints/ep_1') && init?.method === undefined) {
        return jsonResponse(canonical);
      }
      if (url.endsWith('/endpoints/ep_1/mode') && init?.method === 'PUT') {
        canonical = { ...canonical, mode: 'mock', revision: 6 };
        return jsonResponse(canonical);
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetch);

    render(
      <EndpointEditor
        projectId="prj_1"
        endpoint={emptyEndpoint}
        onEndpointSaveStarted={() => () => true}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New Variant' }));
    await userEvent.type(screen.getByLabelText('New Variant name'), created.name);
    await userEvent.click(screen.getByRole('button', { name: 'Create Variant' }));

    expect(await screen.findByLabelText('Variant name')).toHaveValue(created.name);
    expect(screen.getByRole('tab', { name: /First response/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Serving now')).toBeVisible();
    expect(screen.queryByText(/Mock not ready/)).not.toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedEndpointRevision: 4,
      name: created.name,
      status: 200,
      responseHeaders: {},
    });
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET']))
      .toEqual([
        ['/api/admin/projects/prj_1/endpoints/ep_1/variants', 'POST'],
        ['/api/admin/projects/prj_1/endpoints/ep_1', 'GET'],
      ]);

    await userEvent.click(screen.getByRole('button', { name: 'Use mock mode' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      mode: 'mock', expectedRevision: 5,
    });
    expect(canonical).toMatchObject({
      mode: 'mock', defaultVariantId: created.id, variants: [{ id: created.id }], revision: 6,
    });
  });
});
