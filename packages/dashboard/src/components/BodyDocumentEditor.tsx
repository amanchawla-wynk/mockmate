import {
  defaultKeymap,
  history,
  historyKeymap,
} from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Facet, StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
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
}

export const LARGE_BODY_MODE_BYTES = 1 * 1024 * 1024;

const editorConfiguration = Facet.define<string, string>({
  combine: values => values.at(-1) ?? '',
});
const editorConfigurationCompartment = new Compartment();

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
}) {
  return [
    editorConfiguration.of(input.key),
    EditorState.readOnly.of(input.mode === 'readonly'),
    EditorView.editable.of(input.mode === 'editable'),
    EditorView.contentAttributes.of({ 'aria-label': input.ariaLabel }),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    highlightSelectionMatches(),
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
}: BodyDocumentEditorProps) {
  const parent = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const large = snapshot.byteCount > LARGE_BODY_MODE_BYTES;
  const configurationKey = `${identityKey(handle)}:${mode}:${mediaType}:${large}:${ariaLabel}`;

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
  }, [ariaLabel, configurationKey, handle, large, mediaType, mode]);

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
        const latest = handle.getSnapshot();
        if (latest.state === 'ready'
          && latest.editorState !== undefined
          && owningView.state !== latest.editorState) owningView.setState(latest.editorState);
      },
    });
    view.current = editor;
    return () => {
      if (view.current === editor) view.current = undefined;
      editor.destroy();
    };
  }, [handle]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor !== undefined && editor.state !== snapshot.editorState) {
      editor.setState(snapshot.editorState);
    }
  }, [snapshot.editorState]);

  return (
    <div className="overflow-hidden rounded-md border border-gray-300 bg-white">
      {large ? (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Large body mode: syntax parsing and line wrapping are disabled above 1 MiB.
        </p>
      ) : null}
      <div ref={parent} />
    </div>
  );
}
