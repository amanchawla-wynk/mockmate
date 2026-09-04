import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBodyDocumentCache } from '../state/bodyDocumentCache';
import type {
  JsonWorkerClient,
  JsonWorkerOperation,
  JsonWorkerResponse,
} from '../workers/json-worker-client';
import { BodyEditor, type BodyEditorProps } from './BodyEditor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function response(
  owner: JsonWorkerOperation,
  result: { ok: true; formatted?: string } | { ok: false; message: string },
  id = 1,
): JsonWorkerResponse {
  return { id, ...owner, ...result };
}

function successfulWorker(formatted = '{\n  "a": 1\n}'): JsonWorkerClient {
  return {
    validate: vi.fn(async owner => response(owner, { ok: true })),
    format: vi.fn(async owner => response(owner, { ok: true, formatted }, 2)),
    dispose: vi.fn(),
  };
}

async function renderEditor(input: {
  text?: string;
  mediaType?: string;
  workerClient?: JsonWorkerClient;
  onChange?: BodyEditorProps['onChange'];
  onSaveBody?: BodyEditorProps['onSaveBody'];
  wrap?: (editor: ReactElement) => ReactElement;
} = {}) {
  const text = input.text ?? '{}';
  const editorState = EditorState.create({ doc: text });
  const cache = createBodyDocumentCache();
  const handle = cache.acquire({
    identity: {
      kind: 'mock',
      projectId: 'prj_1',
      endpointId: 'ep_1',
      variantId: 'var_1',
      variantRevision: 3,
    },
    active: true,
    dirty: false,
    load: async () => ({
      text: editorState.doc,
      byteCount: new TextEncoder().encode(text).byteLength,
      editorState,
    }),
  });
  const editor = (
    <BodyEditor
      handle={handle}
      initialMediaType={input.mediaType ?? 'application/json'}
      workerClient={input.workerClient ?? successfulWorker()}
      onChange={input.onChange ?? vi.fn()}
      onSaveBody={input.onSaveBody ?? vi.fn()}
    />
  );
  const rendered = render(input.wrap ? input.wrap(editor) : editor);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  screen.getByRole('textbox', { name: 'Response body' });
  return { ...rendered, handle };
}

function view(): EditorView {
  const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Response body' }));
  if (!editor) throw new Error('CodeMirror view not found');
  return editor;
}

function replaceBody(text: string) {
  act(() => {
    const editor = view();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  });
}

function bodyText(): string {
  return view().state.doc.toString();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BodyEditor', () => {
  it('blocks invalid JSON after a 300 ms debounce without a controlled textarea', async () => {
    vi.useFakeTimers();
    const validation = deferred<JsonWorkerResponse>();
    let validationOwner!: JsonWorkerOperation;
    const workerClient: JsonWorkerClient = {
      validate: vi.fn(owner => {
        validationOwner = owner;
        return validation.promise;
      }),
      format: vi.fn(),
      dispose: vi.fn(),
    };
    const onChange = vi.fn();
    await renderEditor({ workerClient, onChange });

    expect(screen.getByRole('textbox', { name: 'Response body' }).tagName).not.toBe('TEXTAREA');
    replaceBody('{bad');
    expect(workerClient.validate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Body' })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(workerClient.validate).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(workerClient.validate).toHaveBeenCalledWith(expect.objectContaining({
      documentIdentity: expect.any(String),
      documentGeneration: expect.any(Number),
      operationGeneration: expect.any(Number),
      text: '{bad',
    }));
    await act(async () => validation.resolve(response(validationOwner, {
      ok: false,
      message: 'Invalid JSON',
    })));

    expect(screen.getByText('Invalid JSON')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save Body' })).toBeDisabled();
    expect(workerClient.format).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(
      'application/json',
      'invalid',
      'Invalid JSON',
      true,
    );
  });

  it('formats JSON only when commanded and uploads the cache-owned formatted text', async () => {
    const workerClient = successfulWorker();
    const onSaveBody = vi.fn().mockResolvedValue(undefined);
    await renderEditor({ text: '{"a":1}', workerClient, onSaveBody });

    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(bodyText()).toBe('{\n  "a": 1\n}');
    await userEvent.click(screen.getByRole('button', { name: 'Save Body' }));

    expect(onSaveBody).toHaveBeenCalledWith('{\n  "a": 1\n}', 'application/json');
  });

  it('treats non-JSON edits as immediately valid without Worker materialization', async () => {
    const workerClient = successfulWorker();
    const onChange = vi.fn();
    await renderEditor({ text: 'plain', mediaType: 'text/plain', workerClient, onChange });

    replaceBody('changed');

    expect(onChange).toHaveBeenLastCalledWith('text/plain', 'valid', undefined, true);
    expect(workerClient.validate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Body' })).toBeEnabled();
  });

  it('reports media-type-only changes without materializing the document', async () => {
    const workerClient = successfulWorker();
    const onChange = vi.fn();
    await renderEditor({ text: 'plain', mediaType: 'text/plain', workerClient, onChange });

    await userEvent.clear(screen.getByLabelText('Body media type'));
    await userEvent.type(screen.getByLabelText('Body media type'), 'application/octet-stream');

    expect(onChange).toHaveBeenLastCalledWith(
      'application/octet-stream',
      'valid',
      undefined,
      false,
    );
    expect(workerClient.validate).not.toHaveBeenCalled();
  });

  it('ignores a stale format success after the document changes', async () => {
    const formatting = deferred<JsonWorkerResponse>();
    let formatOwner!: JsonWorkerOperation;
    const workerClient: JsonWorkerClient = {
      validate: vi.fn(async owner => response(owner, { ok: true })),
      format: vi.fn(owner => {
        formatOwner = owner;
        return formatting.promise;
      }),
      dispose: vi.fn(),
    };
    await renderEditor({ text: '{"old":true}', workerClient });
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    replaceBody('{"new":true}');

    await act(async () => formatting.resolve(response(formatOwner, {
      ok: true,
      formatted: '{\n  "old": true\n}',
    })));

    expect(bodyText()).toBe('{"new":true}');
  });

  it('ignores stale format failure and finally while a newer format is pending', async () => {
    const first = deferred<JsonWorkerResponse>();
    const second = deferred<JsonWorkerResponse>();
    const owners: JsonWorkerOperation[] = [];
    const workerClient: JsonWorkerClient = {
      validate: vi.fn(async owner => response(owner, { ok: true })),
      format: vi.fn(owner => {
        owners.push(owner);
        return owners.length === 1 ? first.promise : second.promise;
      }),
      dispose: vi.fn(),
    };
    await renderEditor({ text: '{"old":true}', workerClient });
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    replaceBody('{"new":true}');
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));

    await act(async () => first.resolve(response(owners[0]!, {
      ok: false,
      message: 'stale failure',
    })));
    expect(screen.queryByText('stale failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Format JSON' })).toBeDisabled();

    await act(async () => second.resolve(response(owners[1]!, {
      ok: true,
      formatted: '{\n  "new": true\n}',
    })));
    expect(bodyText()).toBe('{\n  "new": true\n}');
    expect(screen.getByRole('button', { name: 'Format JSON' })).toBeEnabled();
  });

  it('does not publish a stale format after unmount', async () => {
    const formatting = deferred<JsonWorkerResponse>();
    let formatOwner!: JsonWorkerOperation;
    const onChange = vi.fn();
    const workerClient: JsonWorkerClient = {
      validate: vi.fn(),
      format: vi.fn(owner => {
        formatOwner = owner;
        return formatting.promise;
      }),
      dispose: vi.fn(),
    };
    const rendered = await renderEditor({ text: '{"old":true}', workerClient, onChange });
    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    rendered.unmount();

    await act(async () => formatting.resolve(response(formatOwner, {
      ok: true,
      formatted: '{\n  "old": true\n}',
    })));
    expect(onChange).not.toHaveBeenCalledWith('application/json', 'valid', undefined, true);
  });

  it('keeps current format ownership after the Strict Mode lifecycle probe', async () => {
    await renderEditor({
      text: '{"strict":true}',
      workerClient: successfulWorker('{\n  "strict": true\n}'),
      wrap: editor => <StrictMode>{editor}</StrictMode>,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Format JSON' }));

    expect(bodyText()).toBe('{\n  "strict": true\n}');
  });
});
