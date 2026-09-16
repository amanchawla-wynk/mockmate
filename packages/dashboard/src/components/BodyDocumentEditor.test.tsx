import { syntaxTree } from '@codemirror/language';
import { findNext, openSearchPanel } from '@codemirror/search';
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createBodyDocumentCache, type BodyDocumentHandle } from '../state/bodyDocumentCache';
import { BodyDocumentEditor, LARGE_BODY_MODE_BYTES } from './BodyDocumentEditor';

function Harness({
  handle,
  mode = 'editable',
  mediaType = 'application/json',
  searchLabel,
}: {
  handle: BodyDocumentHandle;
  mode?: 'editable' | 'readonly';
  mediaType?: string;
  searchLabel?: string;
}) {
  const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
  if (snapshot.state !== 'ready' || snapshot.editorState === undefined) return <span>Loading</span>;
  return (
    <BodyDocumentEditor
      ariaLabel="Body document"
      handle={handle}
      snapshot={{ ...snapshot, state: 'ready', editorState: snapshot.editorState }}
      mode={mode}
      mediaType={mediaType}
      searchLabel={searchLabel}
    />
  );
}

async function readyHandle(value: string, byteCount = new TextEncoder().encode(value).byteLength) {
  const cache = createBodyDocumentCache();
  const handle = cache.acquire({
    identity: {
      kind: 'mock', projectId: 'prj_1', endpointId: 'ep_1', variantId: 'var_1',
      variantRevision: 1,
    },
    active: true,
    dirty: true,
    async load() { return { text: Text.of([value]), byteCount }; },
  });
  await vi.waitFor(() => expect(handle.getSnapshot().state).toBe('ready'));
  return handle;
}

describe('BodyDocumentEditor', () => {
  it('routes consecutive edits through the cache and preserves undo and complete-document search', async () => {
    const user = userEvent.setup();
    const handle = await readyHandle('{"first":"needle","second":"needle"}');
    render(<Harness handle={handle} />);
    const textbox = await screen.findByRole('textbox', { name: 'Body document' });
    const view = EditorView.findFromDOM(textbox);
    expect(view).toBeDefined();
    const generation = handle.getSnapshot().documentGeneration;

    act(() => {
      view!.dispatch({ changes: { from: 0, insert: 'a' } });
      view!.dispatch({ changes: { from: 1, insert: 'b' } });
    });
    expect(handle.getSnapshot().editorState?.doc.sliceString(0, 2)).toBe('ab');
    expect(handle.getSnapshot().documentGeneration).toBe(generation + 2);

    act(() => { expect(undo(view!)).toBe(true); });
    expect(handle.getSnapshot().editorState?.doc.sliceString(0, 1)).toBe('{');
    act(() => { openSearchPanel(view!); });
    const find = screen.getByRole('textbox', { name: 'Find' });
    await user.type(find, 'needle');
    act(() => { expect(findNext(view!)).toBe(true); });
    const firstMatch = view!.state.selection.main.from;
    act(() => { expect(findNext(view!)).toBe(true); });
    expect(view!.state.selection.main.from).toBeGreaterThan(firstMatch);
  });

  it('enforces read-only editing while retaining keyboard-search ownership', async () => {
    const handle = await readyHandle('read only needle');
    render(<Harness handle={handle} mode="readonly" mediaType="text/plain" />);
    const textbox = await screen.findByRole('textbox', { name: 'Body document' });
    const view = EditorView.findFromDOM(textbox)!;

    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    act(() => { openSearchPanel(view); });
    expect(screen.getByRole('textbox', { name: 'Find' })).toBeVisible();
  });

  it('shows visible case-insensitive search with match count and wrapping navigation', async () => {
    const user = userEvent.setup();
    const handle = await readyHandle('{"first":"Needle","second":"needle"}');
    render(
      <Harness
        handle={handle}
        mode="readonly"
        searchLabel="Find in response JSON"
      />,
    );

    const find = await screen.findByRole('searchbox', { name: 'Find in response JSON' });
    expect(screen.getByText('0 matches')).toBeVisible();

    await user.type(find, 'needle');
    expect(screen.getByText('2 matches')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Next JSON match' }));
    expect(screen.getByText('1 of 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next JSON match' }));
    expect(screen.getByText('2 of 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next JSON match' }));
    expect(screen.getByText('1 of 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Previous JSON match' }));
    expect(screen.getByText('2 of 2')).toBeVisible();

    await user.clear(find);
    await user.type(find, 'missing');
    expect(screen.getByText('0 matches')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next JSON match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous JSON match' })).toBeDisabled();
  });

  it('keeps the visible toolbar open when Escape is pressed in the editor', async () => {
    const user = userEvent.setup();
    const handle = await readyHandle('{"value":"needle"}');
    render(<Harness handle={handle} mode="readonly" searchLabel="Find in response JSON" />);

    const textbox = await screen.findByRole('textbox', { name: 'Body document' });
    expect(screen.getByRole('searchbox', { name: 'Find in response JSON' })).toBeVisible();
    textbox.focus();
    await user.keyboard('{Escape}');

    expect(screen.getByRole('searchbox', { name: 'Find in response JSON' })).toBeVisible();
  });

  it('does not add visible search unless the caller opts in', async () => {
    const handle = await readyHandle('{"ok":true}');
    render(<Harness handle={handle} />);

    await screen.findByRole('textbox', { name: 'Body document' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('uses JSON and wrapping through exactly 1 MiB and disables both only above it', async () => {
    const atLimit = await readyHandle('{}', LARGE_BODY_MODE_BYTES);
    const first = render(<Harness handle={atLimit} />);
    const firstView = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Body document' }))!;
    expect(screen.queryByText(/Large body mode/)).not.toBeInTheDocument();
    expect(firstView.contentDOM).toHaveClass('cm-lineWrapping');
    expect(syntaxTree(firstView.state).type.name).not.toBe('Document');
    first.unmount();

    const aboveLimit = await readyHandle('{}', LARGE_BODY_MODE_BYTES + 1);
    render(<Harness handle={aboveLimit} />);
    const largeView = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Body document' }))!;
    expect(screen.getByText(/Large body mode/)).toBeVisible();
    expect(largeView.contentDOM).not.toHaveClass('cm-lineWrapping');
    expect(syntaxTree(largeView.state).type.name).toBe('');
  });

  it('destroys one view per document identity without recreating it for cache publications', async () => {
    const handle = await readyHandle('hello');
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    const rendered = render(<Harness handle={handle} mediaType="text/plain" />);
    const textbox = await screen.findByRole('textbox', { name: 'Body document' });
    const view = EditorView.findFromDOM(textbox)!;
    act(() => { view.dispatch({ changes: { from: 5, insert: '!' } }); });
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Body document' }))).toBe(view);

    rendered.rerender(<Harness handle={handle} mediaType="application/json" />);
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Body document' }))).toBe(view);

    rendered.unmount();
    expect(destroy).toHaveBeenCalledOnce();
    destroy.mockRestore();
  });
});
