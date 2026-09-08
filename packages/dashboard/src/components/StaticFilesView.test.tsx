import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { staticFilesApi } from '../api/client';
import { StaticFilesView } from './StaticFilesView';

describe('StaticFilesView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('copies the complete LAN HTTPS URL for a static file', async () => {
    vi.spyOn(staticFilesApi, 'list').mockResolvedValue({
      files: [{
        path: 'movie/master.m3u8',
        size: 7,
        mediaType: 'application/vnd.apple.mpegurl',
      }],
      baseUrl: 'https://192.168.1.20:3457',
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<StaticFilesView projectId="prj_1" />);

    expect(await screen.findByText('master.m3u8')).toBeVisible();
    expect(screen.getByText('https://192.168.1.20:3457/static_files/...')).toBeVisible();
    fireEvent.click(screen.getByTitle('Copy URL'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      'https://192.168.1.20:3457/static_files/movie/master.m3u8',
    ));
  });
});
