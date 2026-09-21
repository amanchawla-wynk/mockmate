import {
  defaultKeymap,
  history,
  historyKeymap,
} from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import {
  Compartment,
  EditorState,
  Facet,
  Prec,
  StateEffect,
} from '@codemirror/state';
import { EditorView, keymap, type Panel, type ViewUpdate } from '@codemirror/view';
import { useLayoutEffect, useRef } from 'react';

import type {
  BodyDocumentHandle,
  BodyDocumentSnapshot,
} from '../state/bodyDocumentCache';

export interface BodyDocumentEditorProps {
  ariaLabel: string;
  handle: BodyDocumentHandle;
  snapshot: BodyDocumentSnapshot & {
    state: 'ready';
    editorState: EditorState;
  };
  mode: 'editable' | 'readonly';
  mediaType: string;
  searchLabel?: string;
  /** Pre-fills the visible search toolbar and selects the first match on mount. */
  initialSearchQuery?: string;
}

export const LARGE_BODY_MODE_BYTES = 1 * 1024 * 1024;

const editorConfiguration = Facet.define<string, string>({
  combine: values => values.at(-1) ?? '',
});
const editorConfigurationCompartment = new Compartment();

function createSearchPanel(label: string): (view: EditorView) => Panel {
  return view => {
    const dom = document.createElement('div');
    dom.className = 'cm-visible-json-search';

    const input = document.createElement('input');
    input.type = 'search';
    input.setAttribute('aria-label', label);
    input.setAttribute('main-field', 'true');
    input.placeholder = 'Find in JSON...';
    input.className = 'cm-visible-json-search-input';

    const status = document.createElement('span');
    status.className = 'cm-visible-json-search-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const previous = document.createElement('button');
    previous.type = 'button';
    previous.textContent = 'Prev';
    previous.setAttribute('aria-label', 'Previous JSON match');
    previous.className = 'cm-visible-json-search-button';

    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = 'Next';
    next.setAttribute('aria-label', 'Next JSON match');
    next.className = 'cm-visible-json-search-button';

    dom.append(input, status, previous, next);

    const refresh = () => {
      const query = getSearchQuery(view.state);
      if (input.value !== query.search) input.value = query.search;
      let count = 0;
      let selected = 0;
      if (query.valid) {
        const selection = view.state.selection.main;
        const cursor = query.getCursor(view.state);
        for (let next = cursor.next(); !next.done; next = cursor.next()) {
          const match = next.value;
          count += 1;
          if (match.from === selection.from && match.to === selection.to) selected = count;
        }
      }
      status.textContent = count === 0
        ? '0 matches'
        : selected === 0
          ? `${count} matches`
          : `${selected} of ${count}`;
      previous.disabled = count === 0;
      next.disabled = count === 0;
    };

    const updateQuery = () => {
      const query = new SearchQuery({
        search: input.value,
        caseSensitive: false,
        literal: true,
      });
      // The setSearchQuery effect re-enters update() below, which refreshes once.
      view.dispatch({ effects: setSearchQuery.of(query) });
    };
    const showPrevious = () => { findPrevious(view); };
    const showNext = () => { findNext(view); };

    input.addEventListener('input', updateQuery);
    previous.addEventListener('click', showPrevious);
    next.addEventListener('click', showNext);
    refresh();

    return {
      dom,
      top: true,
      update(update: ViewUpdate) {
        // Counting scans the whole document, so only recompute on changes that
        // can move matches or the active selection.
        const queryChanged = update.transactions.some(transaction =>
          transaction.effects.some(effect => effect.is(setSearchQuery)));
        if (update.docChanged || update.selectionSet || queryChanged) refresh();
      },
      destroy() {
        input.removeEventListener('input', updateQuery);
        previous.removeEventListener('click', showPrevious);
        next.removeEventListener('click', showNext);
      },
    };
  };
}

function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return essence === 'application/json' || essence.endsWith('+json');
}

function configurationExtensions(input: {
  key: string;
  ariaLabel: string;
  mode: 'editable' | 'readonly';
  mediaType: string;
  large: boolean;
  searchLabel?: string;
}) {
  return [
    editorConfiguration.of(input.key),
    EditorState.readOnly.of(input.mode === 'readonly'),
    EditorView.editable.of(input.mode === 'editable'),
    EditorView.contentAttributes.of({ 'aria-label': input.ariaLabel }),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    highlightSelectionMatches(),
    ...(input.searchLabel === undefined ? [] : [
      // Keep the visible JSON toolbar persistent: swallow Escape before the
      // default search keymap can close the panel.
      Prec.high(keymap.of([{ key: 'Escape', run: () => true }])),
      search({
        top: true,
        createPanel: createSearchPanel(input.searchLabel),
      }),
    ]),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ...(!input.large ? [EditorView.lineWrapping] : []),
    ...(!input.large && isJsonMediaType(input.mediaType) ? [json()] : []),
    EditorView.theme({
      '&': {
        minHeight: '10rem',
        fontSize: '12px',
        backgroundColor: '#fff',
      },
      '.cm-scroller': {
        minHeight: '10rem',
        maxHeight: '32rem',
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      },
      '.cm-content': { padding: '10px 0' },
      '.cm-line': { padding: '0 12px' },
      '&.cm-focused': { outline: '2px solid #3b82f6', outlineOffset: '-2px' },
      '.cm-panels-top': { borderBottom: '1px solid #e5e7eb' },
      '.cm-visible-json-search': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 8px',
        backgroundColor: '#f9fafb',
      },
      '.cm-visible-json-search-input': {
        minWidth: 0,
        flex: '1 1 12rem',
        border: '1px solid #d1d5db',
        borderRadius: '4px',
        padding: '4px 7px',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '12px',
      },
      '.cm-visible-json-search-input:focus': {
        borderColor: '#3b82f6',
        outline: '2px solid #bfdbfe',
        outlineOffset: 0,
      },
      '.cm-visible-json-search-status': {
        minWidth: '4.5rem',
        color: '#6b7280',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '11px',
        textAlign: 'right',
      },
      '.cm-visible-json-search-button': {
        border: '1px solid #d1d5db',
        borderRadius: '4px',
        padding: '4px 7px',
        backgroundColor: '#fff',
        color: '#374151',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '11px',
      },
      '.cm-visible-json-search-button:disabled': {
        cursor: 'not-allowed',
        color: '#9ca3af',
        backgroundColor: '#f3f4f6',
      },
    }),
  ];
}

function identityKey(handle: BodyDocumentHandle): string {
  const identity = handle.identity;
  return identity.kind === 'traffic'
    ? `traffic:${identity.projectId}:${identity.trafficId}:${identity.side}:${identity.sha256}`
    : `mock:${identity.projectId}:${identity.endpointId}:${identity.variantId}:${identity.variantRevision}:${identity.bodyAssetId ?? ''}`;
}

export function BodyDocumentEditor({
  ariaLabel,
  handle,
  snapshot,
  mode,
  mediaType,
  searchLabel,
  initialSearchQuery,
}: BodyDocumentEditorProps) {
  const parent = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const large = snapshot.byteCount > LARGE_BODY_MODE_BYTES;
  const configurationKey = `${identityKey(handle)}:${mode}:${mediaType}:${large}:${ariaLabel}:${searchLabel ?? ''}`;

  useLayoutEffect(() => {
    let current = handle.getSnapshot();
    if (current.state !== 'ready' || current.editorState === undefined) return;
    if (current.editorState.facet(editorConfiguration) !== configurationKey) {
      const extensions = configurationExtensions({
          key: configurationKey,
          ariaLabel,
          mode,
          mediaType,
          large,
          searchLabel,
        });
      const configured = current.editorState.update({
        effects: editorConfigurationCompartment.get(current.editorState) === undefined
          ? StateEffect.appendConfig.of(editorConfigurationCompartment.of(extensions))
          : editorConfigurationCompartment.reconfigure(extensions),
      });
      if (!handle.dispatch(configured, current.documentGeneration)) return;
      current = handle.getSnapshot();
      if (current.state !== 'ready' || current.editorState === undefined) return;
    }
    const editor = view.current;
    if (editor !== undefined && editor.state !== current.editorState) {
      editor.setState(current.editorState);
    }
    // Opening a closed panel only toggles panel state; it does not move focus,
    // so nearby controls keep their focus while an async body finishes loading.
    if (searchLabel !== undefined && editor !== undefined && !searchPanelOpen(editor.state)) {
      openSearchPanel(editor);
    }
  }, [ariaLabel, configurationKey, handle, large, mediaType, mode, searchLabel]);

  useLayoutEffect(() => {
    if (parent.current === null) return;
    const current = handle.getSnapshot();
    if (current.state !== 'ready' || current.editorState === undefined) return;

    const editor = new EditorView({
      state: current.editorState,
      parent: parent.current,
      dispatchTransactions(transactions, owningView) {
        for (const transaction of transactions) {
          const owned = handle.getSnapshot();
          if (owned.state !== 'ready'
            || owned.editorState === undefined
            || !handle.dispatch(transaction, owned.documentGeneration)) {
            const latest = handle.getSnapshot();
            if (latest.state === 'ready'
              && latest.editorState !== undefined
              && owningView.state !== latest.editorState) owningView.setState(latest.editorState);
            return;
          }
        }
        owningView.update(transactions);
        const latest = handle.getSnapshot();
        if (latest.state === 'ready'
          && latest.editorState !== undefined
          && owningView.state !== latest.editorState) owningView.setState(latest.editorState);
      },
    });
    view.current = editor;
    if (searchLabel !== undefined) openSearchPanel(editor);
    return () => {
      if (view.current === editor) view.current = undefined;
      editor.destroy();
    };
  }, [handle, searchLabel]);

  // Seeding dispatches into the existing view; recreating it here would discard
  // scroll position, selection, and undo history.
  useLayoutEffect(() => {
    const editor = view.current;
    if (editor === undefined
      || searchLabel === undefined
      || initialSearchQuery === undefined
      || initialSearchQuery.length === 0) return;
    if (getSearchQuery(editor.state).search === initialSearchQuery) return;
    editor.dispatch({
      effects: setSearchQuery.of(new SearchQuery({
        search: initialSearchQuery,
        caseSensitive: false,
        literal: true,
      })),
    });
    findNext(editor);
  }, [initialSearchQuery, searchLabel, snapshot.editorState]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor !== undefined && editor.state !== snapshot.editorState) {
      editor.setState(snapshot.editorState);
    }
  }, [snapshot.editorState]);

  return (
    <div className="overflow-clip rounded-md border border-gray-300 bg-white">
      {large ? (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Large body mode: syntax parsing and line wrapping are disabled above 1 MiB.
        </p>
      ) : null}
      <div ref={parent} />
    </div>
  );
}
