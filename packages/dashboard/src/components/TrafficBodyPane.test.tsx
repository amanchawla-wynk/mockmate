import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trafficApi } from '../api/client';
import type { TrafficBodyDescriptor } from '../api/types';
import { createBodyDocumentCache } from '../state/bodyDocumentCache';
import { TrafficBodyPane } from './TrafficBodyPane';

const digest = 'c'.repeat(64);
const descriptor: TrafficBodyDescriptor = {
  side: 'response',
  state: 'available',
  mediaType: 'text/plain',
  observedSize: 5,
  retainedSize: 5,
  sha256: digest,
};

function response(text: string, sha256 = digest): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, { headers: {
    'Content-Type': 'text/plain',
    'Content-Length': String(bytes.byteLength),
    'X-MockMate-Sha256': sha256,
  } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function pane(
  cache = createBodyDocumentCache(),
  body: TrafficBodyDescriptor = descriptor,
  trafficId = 'trf_1',
  mode: 'inspector' | 'legacy' = 'inspector',
) {
  return (
    <TrafficBodyPane
      projectId="prj_1"
      trafficId={trafficId}
      side={body.side}
      descriptor={body}
      preview={{ encoding: 'utf8', value: 'hello', truncated: false }}
      cache={cache}
      mode={mode}
    />
  );
}

describe('TrafficBodyPane', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('inspector mode shows a spinner without the bounded preview while exact loads', async () => {
    const loading = deferred<Response>();
    vi.spyOn(trafficApi, 'body').mockReturnValue(loading.promise);
    render(pane());

    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Response exact body progress')).toBeVisible();
    expect(screen.getByText('Loading exact body...')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Response exact body' })).not.toBeInTheDocument();

    loading.resolve(response('hello'));

    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByText('hello')).toBeVisible();
  });

  it('legacy mode keeps the bounded preview while exact text streams', async () => {
    const loading = deferred<Response>();
    vi.spyOn(trafficApi, 'body').mockReturnValue(loading.promise);
    render(pane(createBodyDocumentCache(), descriptor, 'trf_1', 'legacy'));

    expect(screen.getAllByText('hello')[0]).toBeVisible();
    expect(screen.getByLabelText('Response exact body progress')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Response exact body' })).not.toBeInTheDocument();

    loading.resolve(response('hello'));

    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toHaveAttribute('contenteditable', 'false');
  });

  it('revisits a cached exact document without another fetch or full-panel loader', async () => {
    const cache = createBodyDocumentCache();
    const body = vi.spyOn(trafficApi, 'body').mockResolvedValue(response('hello'));
    const first = render(pane(cache));
    await screen.findByRole('textbox', { name: 'Response exact body' });
    first.unmount();

    render(pane(cache));

    expect(screen.getByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    expect(screen.queryByLabelText('Response exact body progress')).not.toBeInTheDocument();
    expect(body).toHaveBeenCalledOnce();
  });

  it('retries an owned text failure while preserving Download', async () => {
    const body = vi.spyOn(trafficApi, 'body')
      .mockRejectedValueOnce(new Error('body offline'))
      .mockResolvedValueOnce(response('hello'));
    render(pane());

    expect(await screen.findByText('body offline')).toBeVisible();
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download response body' })).toHaveAttribute(
      'href',
      trafficApi.bodyDownloadUrl('prj_1', 'trf_1', 'response'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry exact body' }));

    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    expect(body).toHaveBeenCalledTimes(2);
  });

  it('keeps request and response identities independent in the shared cache', async () => {
    const requestDigest = 'd'.repeat(64);
    const body = vi.spyOn(trafficApi, 'body').mockImplementation(async (_project, _traffic, side) => (
      response(side === 'request' ? 'request' : 'hello', side === 'request' ? requestDigest : digest)
    ));
    const cache = createBodyDocumentCache();
    render(
      <>
        {pane(cache, {
          side: 'request', state: 'available', mediaType: 'text/plain', observedSize: 7,
          retainedSize: 7, sha256: requestDigest,
        })}
        {pane(cache)}
      </>,
    );

    expect(await screen.findByRole('textbox', { name: 'Request exact body' })).toBeVisible();
    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    expect(body).toHaveBeenCalledWith('prj_1', 'trf_1', 'request', expect.any(AbortSignal));
    expect(body).toHaveBeenCalledWith('prj_1', 'trf_1', 'response', expect.any(AbortSignal));
  });

  it('aborts and suppresses stale exact work after rapid row replacement', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    vi.spyOn(trafficApi, 'body').mockImplementation((_project, _traffic, _side, signal) => {
      signals.push(signal!);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const cache = createBodyDocumentCache();
    const rendered = render(pane(cache, descriptor, 'trf_1'));
    expect(screen.getByLabelText('Response exact body progress')).toBeVisible();

    rendered.rerender(pane(cache, descriptor, 'trf_2'));
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await act(async () => {
      first.reject(new Error('stale exact failure'));
      second.resolve(response('hello'));
    });

    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    expect(screen.queryByText('stale exact failure')).not.toBeInTheDocument();
  });

  it('renders binary download without preview chrome or an editor', () => {
    const body = vi.spyOn(trafficApi, 'body');
    render(pane(createBodyDocumentCache(), {
      ...descriptor,
      mediaType: 'image/png',
    }));

    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download response body' })).toHaveAttribute(
      'href',
      trafficApi.bodyDownloadUrl('prj_1', 'trf_1', 'response'),
    );
    expect(screen.queryByRole('textbox', { name: 'Response exact body' })).not.toBeInTheDocument();
    expect(body).not.toHaveBeenCalled();
  });

  it('loads decoded view for content-encoded JSON and keeps encoded Download', async () => {
    const plain = '{\n  "ok": true\n}';
    const bytes = new TextEncoder().encode(plain);
    const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
    const decodedDigest = [...new Uint8Array(digestBytes)]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    vi.spyOn(trafficApi, 'body').mockResolvedValue(new Response(bytes, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(bytes.byteLength),
        'X-MockMate-View': 'decoded',
        'X-MockMate-Decoded-Sha256': decodedDigest,
        'X-MockMate-Original-Content-Encoding': 'gzip',
      },
    }));

    render(pane(createBodyDocumentCache(), {
      ...descriptor,
      mediaType: 'application/json',
      contentEncoding: 'gzip',
      retainedSize: 12,
      observedSize: 12,
    }, 'trf_encoded'));

    expect(await screen.findByRole('textbox', { name: 'Response exact body' })).toBeVisible();
    expect(screen.getByText(/Showing decoded view/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download response body' })).toHaveAttribute(
      'href',
      trafficApi.bodyDownloadUrl('prj_1', 'trf_encoded', 'response'),
    );
    expect(trafficApi.body).toHaveBeenCalledWith(
      'prj_1',
      'trf_encoded',
      'response',
      expect.any(AbortSignal),
      { view: 'decoded' },
    );
  });

  it.each([
    ['unavailable', 'Exact body was not retained. Showing bounded preview.'],
    ['truncated', 'Exact body exceeded the capture limit and cannot be promoted. Showing bounded preview.'],
    ['evicted', 'Exact body was evicted from the ephemeral cache and cannot be reloaded. Showing bounded preview.'],
  ] as const)('shows distinct %s recovery with inspector preview and without an exact load', async (state, copy) => {
    const body = vi.spyOn(trafficApi, 'body');
    const blocked: TrafficBodyDescriptor = state === 'unavailable'
      ? { side: 'request', state, observedSize: 1, reason: 'body_unobservable' }
      : state === 'truncated'
        ? { side: 'request', state, observedSize: 51 * 1024 * 1024, reason: 'body_limit_exceeded' }
        : {
          side: 'request', state, observedSize: 1, retainedSize: 1, sha256: digest,
          reason: 'retention_evicted',
        };

    render(pane(createBodyDocumentCache(), blocked));

    expect(screen.getByText(copy)).toBeVisible();
    expect(screen.getByText('hello')).toBeVisible();
    expect(body).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });
});
