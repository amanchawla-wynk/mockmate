import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

describe('EndpointList', () => {
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
});
