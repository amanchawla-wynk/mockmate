import { useState } from 'react';

import type { ResponseVariant } from '../api/types';
import { Modal } from './Modal';

export type NewVariantSource = 'clone' | 'blank';

export interface NewVariantDialogResult {
  name: string;
  source: NewVariantSource;
}

export interface NewVariantDialogProps {
  isOpen: boolean;
  selectedVariant?: ResponseVariant;
  loading: boolean;
  onConfirm(result: NewVariantDialogResult): void;
  onCancel(): void;
}

export function NewVariantDialog({ isOpen, ...props }: NewVariantDialogProps) {
  if (!isOpen) return null;
  return <NewVariantDialogContent {...props} />;
}

function NewVariantDialogContent({
  selectedVariant,
  loading,
  onConfirm,
  onCancel,
}: Omit<NewVariantDialogProps, 'isOpen'>) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<NewVariantSource>(selectedVariant ? 'clone' : 'blank');
  const canConfirm = !loading && name.trim().length > 0;

  return (
    <Modal
      isOpen
      label="New Variant"
      loading={loading}
      onCancel={onCancel}
      className="relative w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
    >
          <h3 className="text-lg font-semibold text-gray-900">New Variant</h3>
          <p className="mt-2 text-sm text-gray-600">Start from the selected response or create an empty response.</p>

          <label className="mt-4 block text-sm font-medium text-gray-700">
            New Variant name
            <input
              aria-label="New Variant name"
              data-modal-initial-focus
              value={name}
              disabled={loading}
              onChange={event => setName(event.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            />
          </label>

          <fieldset className="mt-4 space-y-2">
            <legend className="text-sm font-medium text-gray-700">Starting response</legend>
            {selectedVariant ? (
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="variant-source"
                  checked={source === 'clone'}
                  disabled={loading}
                  onChange={() => setSource('clone')}
                />
                Clone selected Variant
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="variant-source"
                checked={source === 'blank'}
                disabled={loading}
                onChange={() => setSource('blank')}
              />
              Blank Variant
            </label>
          </fieldset>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              disabled={loading}
              onClick={onCancel}
              className="rounded border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => onConfirm({ name: name.trim(), source })}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Create Variant
            </button>
          </div>
    </Modal>
  );
}
