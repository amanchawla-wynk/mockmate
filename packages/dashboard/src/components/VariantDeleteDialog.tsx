import { useState } from 'react';

import type { ResponseVariant, VariantDeletionImpact } from '../api/types';
import { Modal } from './Modal';

export interface VariantDeleteDialogResult {
  replacementVariantId?: string;
}

export interface VariantDeleteDialogProps {
  isOpen: boolean;
  variant: ResponseVariant;
  impact: VariantDeletionImpact;
  error?: string;
  recoveryMessage?: string;
  recoveryLabel?: string;
  confirmDisabled?: boolean;
  loading: boolean;
  onRecovery?(): void;
  onConfirm(result: VariantDeleteDialogResult): void;
  onCancel(): void;
}

export function VariantDeleteDialog({ isOpen, ...props }: VariantDeleteDialogProps) {
  if (!isOpen) return null;
  return <VariantDeleteDialogContent key={JSON.stringify(props.impact)} {...props} />;
}

function VariantDeleteDialogContent({
  variant,
  impact,
  error,
  recoveryMessage,
  recoveryLabel,
  confirmDisabled = false,
  loading,
  onRecovery,
  onConfirm,
  onCancel,
}: Omit<VariantDeleteDialogProps, 'isOpen'>) {
  const [replacementVariantId, setReplacementVariantId] = useState<string>();
  const isReferenced = impact.affectedStates.length > 0;
  const replacementRequired = !isReferenced
    && impact.isFallback
    && impact.replacementVariants.length > 0;
  const canConfirm = !loading
    && !confirmDisabled
    && !isReferenced
    && (!replacementRequired || replacementVariantId !== undefined);

  return (
    <Modal
      isOpen
      label={`Delete ${variant.name}`}
      loading={loading}
      onCancel={onCancel}
      className="relative w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
    >
          <h3 className="text-lg font-semibold text-gray-900">Delete {variant.name}</h3>
          <p className="mt-2 text-sm text-gray-600">This removes the Variant from the Endpoint.</p>

          {error ? <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

          {recoveryMessage && recoveryLabel && onRecovery ? (
            <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded bg-amber-50 p-3 text-sm text-amber-800">
              <span>{recoveryMessage}</span>
              <button
                type="button"
                disabled={loading}
                onClick={onRecovery}
                className="font-medium underline disabled:opacity-50"
              >
                {recoveryLabel}
              </button>
            </div>
          ) : null}

          {impact.isFallback ? (
            <p className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
              This Variant is the fallback response.
            </p>
          ) : null}

          {impact.affectedStates.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 rounded bg-amber-50 p-3 text-sm text-amber-800">
                Remove the App State bindings before deleting this Variant.
              </p>
              <p className="text-sm font-medium text-gray-700">Affected App States</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                {impact.affectedStates.map(state => <li key={state.id}>{state.name}</li>)}
              </ul>
            </div>
          ) : null}

          {replacementRequired ? (
            <label className="mt-4 block text-sm font-medium text-gray-700">
              Replacement Variant
              <select
                aria-label="Replacement Variant"
                data-modal-initial-focus
                value={replacementVariantId ?? ''}
                disabled={loading}
                onChange={event => setReplacementVariantId(event.target.value || undefined)}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              >
                <option value="">Select a replacement</option>
                {impact.replacementVariants.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </label>
          ) : null}

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
              onClick={() => onConfirm(replacementVariantId ? { replacementVariantId } : {})}
              className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Delete Variant
            </button>
          </div>
    </Modal>
  );
}
