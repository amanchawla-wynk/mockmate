import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import type { BodyAsset, EndpointDetail, ResponseVariant } from '../api/types';
import { VariantEditor } from './VariantEditor';

const api = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
  update: vi.fn(),
}));

const worker = vi.hoisted(() => ({
  validate: vi.fn().mockResolvedValue({ id: 1, ok: true }),
  format: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    bodiesApi: { download: api.download, upload: api.upload },
    variantsApi: { update: api.update },
  };
});

vi.mock('../workers/json-worker-client', () => ({
  createBrowserJsonWorkerClient: () => worker,
}));

const variant: ResponseVariant = {
  id: 'var_1',
  endpointId: 'ep_1',
  name: 'OK',
  description: 'Success',
  status: 200,
  responseHeaders: { 'x-test': 'yes' },
  bodyAssetId: 'a'.repeat(64),
  delayMs: 10,
  revision: 3,
};

const endpoint: EndpointDetail = {
  schemaVersion: 4,
  id: 'ep_1',
  projectId: 'prj_1',
  name: 'Users',
  baseUrl: 'https://api.example.test',
  matcher: { method: 'GET', path: '/users' },
  mode: 'mock',
  defaultVariantId: variant.id,
  variants: [variant],
  revision: 5,
};

const otherVariant: ResponseVariant = {
  ...variant,
  id: 'var_2',
  endpointId: 'ep_2',
  bodyAssetId: 'c'.repeat(64),
};

const otherEndpoint: EndpointDetail = {
  ...endpoint,
  id: 'ep_2',
  variants: [otherVariant],
  defaultVariantId: otherVariant.id,
};

const pendingAsset: BodyAsset = {
  schemaVersion: 4,
  id: 'b'.repeat(64),
  mediaType: 'text/plain',
  size: 16,
  createdAt: '2026-08-28T00:00:00.000Z',
};

describe('Variant ownership', () => {
  it('does not expose Endpoint request-matching fields', () => {
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);

    expect(screen.queryByLabelText('Endpoint base URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Endpoint path')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Method')).not.toBeInTheDocument();
  });

  it('renders immutable traffic provenance without editable controls', () => {
    const captured = {
      ...variant,
      trafficProvenance: [{
        type: 'traffic' as const,
        trafficId: 'traffic_1',
        trafficGeneration: 'capture_7',
        capturedAt: '2026-08-31T10:00:00.000Z',
        requestOrigin: 'https://api.example.test',
        responseIdentity: 'response_sha256',
        endpointTarget: 'reuse' as const,
        endpointId: endpoint.id,
        endpointCreated: false,
        variantId: variant.id,
        variantCreated: true,
        endpointModeChanged: false,
        stateTarget: 'bound' as const,
        stateId: 'state_1',
        bindingChanged: true,
      }],
    };

    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={captured} onSaved={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Traffic provenance' })).toHaveTextContent('traffic_1');
    expect(screen.getByRole('region', { name: 'Traffic provenance' })).toHaveTextContent('response_sha256');
    expect(screen.queryByRole('textbox', { name: /traffic|provenance|response identity/i })).not.toBeInTheDocument();
  });
});

function bodyResponse(text = '{"server":true}', mediaType = 'text/plain') {
  return new Response(text, { headers: { 'Content-Type': mediaType } });
}

function withoutBody(candidate: ResponseVariant): ResponseVariant {
  const copy = { ...candidate };
  delete copy.bodyAssetId;
  return copy;
}

function deferredUpload() {
  let resolve!: (asset: BodyAsset) => void;
  const promise = new Promise<BodyAsset>(next => { resolve = next; });
  return { promise, resolve, signal: undefined as AbortSignal | undefined };
}

function deferredVariant() {
  let resolve!: (saved: ResponseVariant) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ResponseVariant>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function revisionConflict(currentRevision: number) {
  return new ApiClientError(
    409,
    'REVISION_CONFLICT',
    'Variant changed',
    'req_1',
    undefined,
    { currentRevision },
  );
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

async function openBodyAndReplace(text: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
  await screen.findByLabelText('Response body');
  replaceBody(text);
}

function bodyView(): EditorView {
  const editor = EditorView.findFromDOM(screen.getByLabelText('Response body'));
  if (!editor) throw new Error('CodeMirror view not found');
  return editor;
}

function replaceBody(text: string) {
  act(() => {
    const editor = bodyView();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  });
}

function expectBodyText(text: string) {
  expect(bodyView().state.doc.toString()).toBe(text);
}

describe('VariantEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.download.mockResolvedValue(bodyResponse());
    api.upload.mockResolvedValue(pendingAsset);
    api.update.mockResolvedValue(variant);
    worker.validate.mockResolvedValue({ id: 1, ok: true });
  });

  it('owns and disables every Variant mutation control until save completes', async () => {
    const user = userEvent.setup();
    const pendingSave = deferredVariant();
    api.update.mockReturnValue(pendingSave.promise);
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText('Variant name'));
    await user.type(screen.getByLabelText('Variant name'), 'Local Variant');

    await user.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Variant name')).toBeDisabled();
    expect(screen.getByLabelText('Response status')).toBeDisabled();
    expect(screen.getByPlaceholderText('Content-Type')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit response body' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeDisabled();
    await user.type(screen.getByLabelText('Variant name'), ' must not survive');
    expect(screen.getByLabelText('Variant name')).toHaveValue('Local Variant');

    await act(async () => pendingSave.resolve({ ...variant, name: 'Local Variant', revision: 4 }));

    await waitFor(() => expect(screen.getByLabelText('Variant name')).toBeEnabled());
  });

  it('initializes ordered header rows from scalar and repeated response values', () => {
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={{
          ...variant,
          responseHeaders: {
            'Content-Type': 'application/json',
            'Set-Cookie': ['session=one', 'theme=dark'],
          },
        }}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getAllByPlaceholderText('Content-Type').map(input => input.getAttribute('value')))
      .toEqual(['Content-Type', 'Set-Cookie', 'Set-Cookie']);
    expect(screen.getAllByPlaceholderText('application/json').map(input => input.getAttribute('value')))
      .toEqual(['application/json', 'session=one', 'theme=dark']);
  });

  it('omits responseHeaders from a patch when ordered rows are unchanged', async () => {
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Renamed' } });

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      'prj_1', endpoint.id, variant.id, variant.revision, { name: 'Renamed' },
    ));
    expect(api.update.mock.calls[0]?.[4]).not.toHaveProperty('responseHeaders');
  });

  it('serializes changed rows with ordered case-insensitive repeated values', async () => {
    const headerVariant: ResponseVariant = {
      ...variant,
      responseHeaders: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=one',
      },
    };
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={headerVariant}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add Header' }));
    const nameInputs = screen.getAllByPlaceholderText('Content-Type');
    const valueInputs = screen.getAllByPlaceholderText('application/json');
    await userEvent.type(nameInputs.at(-1)!, 'set-cookie');
    await userEvent.type(valueInputs.at(-1)!, 'theme=dark');

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      'prj_1',
      'ep_1',
      'var_1',
      3,
      expect.objectContaining({
        responseHeaders: {
          'Content-Type': 'application/json',
          'Set-Cookie': ['session=one', 'theme=dark'],
        },
      }),
    ));
  });

  it('blocks save and keeps a temporary blank header row when its name is empty', async () => {
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Header' }));

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    expect(await screen.findByText('Header name is required')).toBeVisible();
    expect(api.update).not.toHaveBeenCalled();
    expect(screen.getAllByPlaceholderText('Content-Type')).toHaveLength(2);
    expect(screen.getAllByPlaceholderText('Content-Type')[1]).toHaveValue('');
  });

  it('preserves edited response header rows after a revision conflict', async () => {
    api.update.mockRejectedValue(revisionConflict(4));
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('application/json'), {
      target: { value: 'local-value' },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    expect(await screen.findByText('Server revision 4')).toBeVisible();
    expect(screen.getByPlaceholderText('application/json')).toHaveValue('local-value');
  });

  it('restores server response header rows when the dirty draft is discarded', async () => {
    const onDirtyChange = vi.fn();
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add Header' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(
      expect.any(String), true, expect.any(Function),
    ));
    const discard = onDirtyChange.mock.calls.at(-1)?.[2] as () => void;

    act(() => discard());

    expect(screen.getAllByPlaceholderText('Content-Type')).toHaveLength(1);
    expect(screen.getByPlaceholderText('Content-Type')).toHaveValue('x-test');
    expect(screen.getByPlaceholderText('application/json')).toHaveValue('yes');
  });

  it('resets local Variant fields when its canonical revision changes', async () => {
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Local name' } });
    fireEvent.change(screen.getByPlaceholderText('application/json'), { target: { value: 'local-value' } });
    await userEvent.click(screen.getByRole('button', { name: 'Remove response body' }));
    const revisedVariant: ResponseVariant = {
      ...variant,
      name: 'Canonical name',
      responseHeaders: { 'x-revised': 'canonical-value' },
      revision: 4,
    };

    rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={{ ...endpoint, variants: [revisedVariant], revision: 6 }}
        variant={revisedVariant}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('Variant name')).toHaveValue('Canonical name'));
    expect(screen.getByPlaceholderText('Content-Type')).toHaveValue('x-revised');
    expect(screen.getByPlaceholderText('application/json')).toHaveValue('canonical-value');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    expect(api.update).toHaveBeenLastCalledWith('prj_1', 'ep_1', 'var_1', 4, {});
  });

  it('loads the body lazily and preserves exact text after upload failure', async () => {
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    expect(api.download).not.toHaveBeenCalled();

    await openBodyAndReplace('{"local":true}');

    expect(api.download).toHaveBeenCalledWith('prj_1', variant.bodyAssetId, expect.any(AbortSignal));
    api.upload.mockRejectedValueOnce(new Error('offline'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));

    await screen.findByText('offline');
    expect(api.upload).toHaveBeenCalledWith('prj_1', expect.any(Blob), expect.any(AbortSignal));
    const uploadedBlob = api.upload.mock.calls.at(-1)?.[1] as Blob;
    expect(uploadedBlob.type).toBe('text/plain');
    await expect(readBlob(uploadedBlob)).resolves.toBe('{"local":true}');
    expectBodyText('{"local":true}');
  });

  it('keeps unrelated Variant controls interactive while a 10 MiB body opens', async () => {
    api.download.mockResolvedValue(bodyResponse('x'.repeat(10 * 1024 * 1024)));
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    await screen.findByLabelText('Response body');
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Still interactive' } });

    expect(screen.getByLabelText('Variant name')).toHaveValue('Still interactive');
    expect(bodyView().state.doc.length).toBe(10 * 1024 * 1024);
  });

  it('aborts an in-flight body upload on unmount', async () => {
    const upload = deferredUpload();
    api.upload.mockImplementation((_projectId: string, _body: Blob, signal: AbortSignal) => {
      upload.signal = signal;
      return upload.promise;
    });
    const { unmount } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await openBodyAndReplace('{"large":"local"}');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));

    expect(upload.signal).toEqual(expect.any(AbortSignal));
    unmount();

    expect(upload.signal?.aborted).toBe(true);
  });

  it('aborts upload on draft identity change without clearing text or a completed pending asset', async () => {
    const upload = deferredUpload();
    api.upload
      .mockResolvedValueOnce(pendingAsset)
      .mockImplementationOnce((_projectId: string, _body: Blob, signal: AbortSignal) => {
        upload.signal = signal;
        return upload.promise;
      });
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await openBodyAndReplace('{"first":"local"}');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
    await screen.findByText('Pending body uploaded');
    replaceBody('{"second":"local"}');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));

    rerender(
      <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
    );
    expect(upload.signal?.aborted).toBe(true);
    expect(screen.queryByLabelText('Response body')).not.toBeInTheDocument();
    expect(api.download).toHaveBeenCalledOnce();
    rerender(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Response body')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    expectBodyText('{"second":"local"}');
    expect(screen.getByText('Pending body uploaded')).toBeVisible();
  });

  it('keeps each new body identity lazy after another body was open', async () => {
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    await screen.findByLabelText('Response body');
    expect(api.download).toHaveBeenCalledOnce();

    rerender(
      <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
    );

    expect(screen.queryByLabelText('Response body')).not.toBeInTheDocument();
    expect(api.download).toHaveBeenCalledOnce();
  });

  it('opens a bodyless Variant lazily as an empty octet-stream draft', async () => {
    const bodylessVariant = withoutBody(variant);
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={bodylessVariant}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Response body')).not.toBeInTheDocument();
    expect(api.download).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));

    expectBodyText('');
    expect(screen.getByLabelText('Body media type')).toHaveValue('application/octet-stream');
    expect(api.download).not.toHaveBeenCalled();
  });

  it('does not let a stale upload replace the previously completed pending asset', async () => {
    const staleUpload = deferredUpload();
    api.upload.mockImplementation((_projectId: string, _body: Blob, signal: AbortSignal) => {
      staleUpload.signal = signal;
      return staleUpload.promise;
    });
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await openBodyAndReplace('stale local');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());
    rerender(
      <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
    );
    expect(staleUpload.signal?.aborted).toBe(true);
    await act(async () => staleUpload.resolve({ ...pendingAsset, id: 'd'.repeat(64) }));

    rerender(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Response body')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    expect(screen.queryByText('Pending body uploaded')).not.toBeInTheDocument();
    expectBodyText('stale local');
  });

  it('attaches an owned upload without overwriting newer text or media in the keyed draft', async () => {
    const upload = deferredUpload();
    const uploadedAsset = { ...pendingAsset };
    const uploadedAssetId = uploadedAsset.id;
    const onDirtyChange = vi.fn();
    api.upload.mockReturnValue(upload.promise);
    const { rerender } = render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    await openBodyAndReplace('upload A');
    fireEvent.change(screen.getByLabelText('Body media type'), {
      target: { value: 'application/octet-stream' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledOnce());

    replaceBody('current B');
    fireEvent.change(screen.getByLabelText('Body media type'), {
      target: { value: 'text/html' },
    });
    await act(async () => upload.resolve(uploadedAsset));
    uploadedAsset.id = 'd'.repeat(64);

    expect(screen.getByText('Pending body uploaded')).toBeVisible();
    expectBodyText('current B');
    expect(screen.getByLabelText('Body media type')).toHaveValue('text/html');
    expect(api.update).not.toHaveBeenCalled();

    rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={otherEndpoint}
        variant={otherVariant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));

    expectBodyText('current B');
    expect(screen.getByLabelText('Body media type')).toHaveValue('text/html');
    expect(screen.getByText('Pending body uploaded')).toBeVisible();
    expect(onDirtyChange).toHaveBeenLastCalledWith(expect.any(String), true, expect.any(Function));
    expect(api.update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      'prj_1',
      endpoint.id,
      variant.id,
      variant.revision,
      { bodyAssetId: uploadedAssetId },
    ));
  });

  it('aborts an in-flight download when draft identity changes', async () => {
    const downloadSignals: AbortSignal[] = [];
    api.download.mockImplementation((_projectId: string, _assetId: string, signal: AbortSignal) => {
      downloadSignals.push(signal);
      return new Promise<Response>(() => undefined);
    });
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    rerender(
      <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
    );

    expect(downloadSignals[0]?.aborted).toBe(true);
  });

  it('omits bodyAssetId from metadata-only saves with or without an existing body', async () => {
    const bodylessVariant = withoutBody(variant);
    for (const candidate of [variant, bodylessVariant]) {
      api.update.mockResolvedValue(candidate);
      const { unmount } = render(
        <VariantEditor projectId="prj_1" endpoint={endpoint} variant={candidate} onSaved={vi.fn()} />,
      );
      const renamed = candidate.bodyAssetId ? 'Renamed with body' : 'Renamed bodyless';
      await userEvent.clear(screen.getByLabelText('Variant name'));
      await userEvent.type(screen.getByLabelText('Variant name'), renamed);
      await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

      await waitFor(() => expect(api.update).toHaveBeenLastCalledWith(
        'prj_1', endpoint.id, candidate.id, candidate.revision, { name: renamed },
      ));
      expect(api.update.mock.calls.at(-1)?.[4]).not.toHaveProperty('bodyAssetId');
      unmount();
    }
  });

  it('sends an explicit body detach only after the remove-body action', async () => {
    const detachedVariant = withoutBody(variant);
    api.update.mockResolvedValue(detachedVariant);
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove response body' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      'prj_1', endpoint.id, variant.id, variant.revision, { bodyAssetId: null },
    ));
  });

  it('preserves local text and a pending uploaded asset after revision conflict', async () => {
    api.upload.mockResolvedValue(pendingAsset);
    api.update.mockRejectedValue(revisionConflict(4));
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    await openBodyAndReplace('{"local":true}');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
    await screen.findByText('Pending body uploaded');
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    expectBodyText('{"local":true}');
    expect(screen.getByText('Pending body uploaded')).toBeVisible();
    expect(await screen.findByText('Server revision 4')).toBeVisible();
  });

  it('preserves cache-owned selection and undo history after a revision conflict', async () => {
    api.update.mockRejectedValue(revisionConflict(4));
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    await openBodyAndReplace('local body');
    act(() => bodyView().dispatch({ selection: { anchor: 5 } }));

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    expect(await screen.findByText('Server revision 4')).toBeVisible();
    expect(bodyView().state.selection.main.anchor).toBe(5);
    act(() => { expect(undo(bodyView())).toBe(true); });
    expectBodyText('{"server":true}');
  });

  it('attaches a completed pending body only when Save Variant is commanded', async () => {
    render(<VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />);
    await openBodyAndReplace('attached body');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));
    await screen.findByText('Pending body uploaded');
    expect(api.update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      'prj_1',
      endpoint.id,
      variant.id,
      variant.revision,
      { bodyAssetId: pendingAsset.id },
    ));
  });

  it('reports exact draft identity and dirty state to the navigation guard adapter', async () => {
    const onDirtyChange = vi.fn();
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    await openBodyAndReplace('local');

    expect(onDirtyChange).toHaveBeenLastCalledWith(
      JSON.stringify(['prj_1', endpoint.id, variant.id, variant.revision, variant.bodyAssetId]),
      true,
      expect.any(Function),
    );
  });

  it('clears superseded Variant draft keys on revision and identity changes and unmount', async () => {
    const onDirtyChange = vi.fn();
    const revisedVariant = { ...variant, name: 'Revised', revision: 4 };
    const revisedEndpoint = { ...endpoint, variants: [revisedVariant], revision: 6 };
    const originalKey = JSON.stringify(['prj_1', endpoint.id, variant.id, 3, variant.bodyAssetId]);
    const revisedKey = JSON.stringify(['prj_1', endpoint.id, variant.id, 4, variant.bodyAssetId]);
    const otherKey = JSON.stringify([
      'prj_1', otherEndpoint.id, otherVariant.id, otherVariant.revision, otherVariant.bodyAssetId,
    ]);
    const view = render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Original draft' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(
      originalKey, true, expect.any(Function),
    ));
    onDirtyChange.mockClear();

    view.rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={revisedEndpoint}
        variant={revisedVariant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(originalKey, false));
    expect(onDirtyChange).toHaveBeenCalledWith(revisedKey, false);
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Revised draft' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(
      revisedKey, true, expect.any(Function),
    ));
    onDirtyChange.mockClear();

    view.rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={otherEndpoint}
        variant={otherVariant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(revisedKey, false));
    expect(onDirtyChange).toHaveBeenCalledWith(otherKey, false);
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Other draft' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(
      otherKey, true, expect.any(Function),
    ));
    onDirtyChange.mockClear();
    view.unmount();
    expect(onDirtyChange).toHaveBeenCalledWith(otherKey, false);
  });

  it('stores media-type-only changes in the keyed dirty draft', async () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    await screen.findByLabelText('Response body');
    fireEvent.change(screen.getByLabelText('Body media type'), {
      target: { value: 'application/octet-stream' },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(expect.any(String), true, expect.any(Function));

    rerender(
      <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
    );
    rerender(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit response body' }));
    expect(screen.getByLabelText('Body media type')).toHaveValue('application/octet-stream');
  });

  it('ignores stale Variant-save success after identity change', async () => {
    const firstSave = deferredVariant();
    const secondSave = deferredVariant();
    const firstOnSaved = vi.fn();
    const secondOnSaved = vi.fn();
    const onDirtyChange = vi.fn();
    api.update
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { rerender } = render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={firstOnSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'First local' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={otherEndpoint}
        variant={otherVariant}
        onDirtyChange={onDirtyChange}
        onSaved={secondOnSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Second local' } });
    await userEvent.click(screen.getByRole('button', { name: 'Remove response body' }));
    onDirtyChange.mockClear();

    await act(async () => firstSave.resolve({ ...variant, name: 'First local', revision: 4 }));

    expect(screen.getByLabelText('Variant name')).toHaveValue('Second local');
    expect(firstOnSaved).not.toHaveBeenCalled();
    expect(secondOnSaved).not.toHaveBeenCalled();
    expect(onDirtyChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    expect(api.update).toHaveBeenLastCalledWith(
      'prj_1',
      otherEndpoint.id,
      otherVariant.id,
      otherVariant.revision,
      { name: 'Second local', bodyAssetId: null },
    );
    await act(async () => secondSave.resolve({
      ...otherVariant,
      name: 'Second local',
      bodyAssetId: undefined,
      revision: 4,
    }));
  });

  it.each([
    ['conflict', revisionConflict(4), 'Server revision 4'],
    ['error', new Error('stale save failure'), 'stale save failure'],
  ] as const)('ignores stale Variant-save %s after identity change', async (_case, failure, text) => {
    const save = deferredVariant();
    api.update.mockReturnValueOnce(save.promise);
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    rerender(
      <VariantEditor projectId="prj_1" endpoint={otherEndpoint} variant={otherVariant} onSaved={vi.fn()} />,
    );

    await act(async () => save.reject(failure));

    expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeEnabled();
  });

  it('does not let stale Variant-save finally clear a newer save', async () => {
    const firstSave = deferredVariant();
    const secondSave = deferredVariant();
    const firstOnSaved = vi.fn();
    const secondOnSaved = vi.fn();
    api.update
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { rerender } = render(
      <VariantEditor projectId="prj_1" endpoint={endpoint} variant={variant} onSaved={firstOnSaved} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    rerender(
      <VariantEditor
        projectId="prj_1"
        endpoint={otherEndpoint}
        variant={otherVariant}
        onSaved={secondOnSaved}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeDisabled();

    await act(async () => firstSave.resolve({ ...variant, revision: 4 }));

    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeDisabled();
    expect(firstOnSaved).not.toHaveBeenCalled();
    expect(secondOnSaved).not.toHaveBeenCalled();
    await act(async () => secondSave.resolve({ ...otherVariant, revision: 4 }));
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeEnabled();
    expect(secondOnSaved).toHaveBeenCalledOnce();
  });

  it('ignores Variant-save completion after unmount', async () => {
    const save = deferredVariant();
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    api.update.mockReturnValueOnce(save.promise);
    const { unmount } = render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    onDirtyChange.mockClear();
    unmount();

    await act(async () => save.resolve({ ...variant, revision: 4 }));

    expect(onSaved).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenCalledOnce();
    expect(onDirtyChange).toHaveBeenCalledWith(
      JSON.stringify(['prj_1', endpoint.id, variant.id, variant.revision, variant.bodyAssetId]),
      false,
    );
  });

  it('can become dirty again after a successful Variant save', async () => {
    const onDirtyChange = vi.fn();
    api.update.mockResolvedValue({ ...variant, name: 'Renamed', revision: 4 });
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Renamed' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(expect.any(String), false));

    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Edited again' } });

    expect(onDirtyChange).toHaveBeenLastCalledWith(expect.any(String), true, expect.any(Function));
  });

  it('does not classify parent canonical reload failure as a Variant update failure', async () => {
    const onDirtyChange = vi.fn();
    const onSaved = vi.fn().mockRejectedValue(new Error('Reload unavailable'));
    api.update.mockResolvedValue({ ...variant, name: 'Saved Variant', revision: 4 });
    render(
      <VariantEditor
        projectId="prj_1"
        endpoint={endpoint}
        variant={variant}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText('Variant name'), { target: { value: 'Saved Variant' } });

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.update).toHaveBeenCalledOnce();
    expect(onDirtyChange).toHaveBeenCalledWith(expect.any(String), false);
    expect(screen.queryByText('Reload unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Variant' })).toBeEnabled();
  });

  it('keeps save ownership and an undisposed lazy worker after the Strict Mode probe', async () => {
    const onSaved = vi.fn();
    render(
      <StrictMode>
        <VariantEditor
          projectId="prj_1"
          endpoint={endpoint}
          variant={variant}
          onSaved={onSaved}
        />
      </StrictMode>,
    );
    expect(worker.dispose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save Variant' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });
});
