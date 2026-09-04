import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

import type { ImportCommitResult } from '../../api/types';
import {
  ImportCommitOutcomeUnknownError,
  useImportWizard,
} from '../../hooks/useImportWizard';
import { Modal } from '../Modal';
import { ImportResolveStep } from './ImportResolveStep';
import { ImportResultStep } from './ImportResultStep';
import { ImportReviewStep } from './ImportReviewStep';
import { ImportSourceStep } from './ImportSourceStep';

export interface ImportWizardProps {
  isOpen: boolean;
  projectId: string;
  onDirtyChange(dirty: boolean, discard: () => void): void;
  onRequestClose(): void;
  onCommitted(result: ImportCommitResult): Promise<void>;
  onCommitOutcomeUnknown(): Promise<void>;
  onSettlementChange(pending: boolean): void;
  onViewEndpoints(): void;
  onDiscoveredOrigins?(origins: readonly string[]): void;
}

const stepLabels = {
  source: 'Source',
  resolve: 'Resolve',
  review: 'Review',
  complete: 'Complete',
} as const;

type OrchestrationState =
  | { projectId: string; status: 'idle' }
  | { projectId: string; status: 'pending'; phase: 'commit' }
  | { projectId: string; status: 'pending'; phase: 'canonical-refresh'; result: ImportCommitResult }
  | { projectId: string; status: 'pending'; phase: 'unknown-refresh'; error: ImportCommitOutcomeUnknownError }
  | { projectId: string; status: 'succeeded'; result: ImportCommitResult }
  | { projectId: string; status: 'failed'; failure: 'canonical-refresh'; result: ImportCommitResult }
  | {
    projectId: string;
    status: 'failed';
    failure: 'outcome-unknown';
    error: Error;
    refreshFailed: boolean;
  };

export function ImportWizard({
  isOpen,
  projectId,
  onDirtyChange,
  onRequestClose,
  onCommitted,
  onCommitOutcomeUnknown,
  onSettlementChange,
  onViewEndpoints,
  onDiscoveredOrigins,
}: ImportWizardProps) {
  const wizard = useImportWizard(projectId);
  const [orchestration, setOrchestration] = useState<OrchestrationState>({
    projectId,
    status: 'idle',
  });
  const orchestrationOwner = useRef(0);
  const orchestrationProjectRef = useRef(projectId);
  const currentOrchestration = orchestration.projectId === projectId
    ? orchestration
    : { projectId, status: 'idle' } as const;
  const orchestrationPending = currentOrchestration.status === 'pending';
  const outcomeUnknown = currentOrchestration.status === 'failed'
    && currentOrchestration.failure === 'outcome-unknown';
  const interactionLocked = wizard.committing || orchestrationPending;
  const reportDirty = useEffectEvent((dirty: boolean) => {
    onDirtyChange(dirty, () => wizard.reset());
  });
  const clearDirty = useEffectEvent(() => {
    onDirtyChange(false, () => {});
  });
  const cancelClosedPreview = useEffectEvent(() => {
    wizard.cancelPreview();
  });
  const resetOrchestrationOnProjectChange = useEffectEvent(() => {
    orchestrationOwner.current += 1;
    setOrchestration({ projectId, status: 'idle' });
  });

  useLayoutEffect(() => {
    if (orchestrationProjectRef.current === projectId) return;
    orchestrationProjectRef.current = projectId;
    resetOrchestrationOnProjectChange();
  }, [projectId]);

  useLayoutEffect(() => {
    onSettlementChange(interactionLocked);
  }, [interactionLocked, onSettlementChange]);

  useLayoutEffect(() => () => {
    onSettlementChange(false);
  }, [onSettlementChange]);

  useEffect(() => {
    reportDirty(isOpen && wizard.dirty);
  }, [isOpen, wizard.dirty]);

  useEffect(() => () => {
    clearDirty();
  }, []);

  useEffect(() => {
    if (!isOpen) cancelClosedPreview();
  }, [isOpen]);

  const requestClose = () => {
    if (interactionLocked) return;
    wizard.cancelPreview();
    onDiscoveredOrigins?.([]);
    onRequestClose();
  };

  const previewSource = async () => {
    orchestrationOwner.current += 1;
    setOrchestration({ projectId, status: 'idle' });
    onDiscoveredOrigins?.([]);
    try {
      await wizard.previewSource();
    } catch {
      // The hook publishes source and documented API errors inline.
    }
  };

  const continueFromResolve = async () => {
    orchestrationOwner.current += 1;
    setOrchestration({ projectId, status: 'idle' });
    try {
      await wizard.continueFromResolve();
    } catch {
      // The hook retains the source and publishes the error inline.
    }
  };

  const refreshPreview = async () => {
    orchestrationOwner.current += 1;
    setOrchestration({ projectId, status: 'idle' });
    try {
      await wizard.refreshPreview();
    } catch {
      // Stale choices and replay data remain available for another refresh.
    }
  };

  const refreshCanonicalData = async (result: ImportCommitResult) => {
    const owner = orchestrationOwner.current + 1;
    orchestrationOwner.current = owner;
    setOrchestration({ projectId, status: 'pending', phase: 'canonical-refresh', result });
    try {
      await onCommitted(result);
      if (orchestrationOwner.current !== owner) return;
      onDiscoveredOrigins?.(wizard.discoveredOrigins);
      setOrchestration({ projectId, status: 'succeeded', result });
    } catch {
      if (orchestrationOwner.current !== owner) return;
      setOrchestration({ projectId, status: 'failed', failure: 'canonical-refresh', result });
    }
  };

  const commit = async () => {
    const owner = orchestrationOwner.current + 1;
    orchestrationOwner.current = owner;
    setOrchestration({ projectId, status: 'pending', phase: 'commit' });
    try {
      const result = await wizard.commit();
      if (orchestrationOwner.current !== owner) return;
      await refreshCanonicalData(result);
    } catch (caught) {
      if (orchestrationOwner.current !== owner) return;
      if (!(caught instanceof ImportCommitOutcomeUnknownError)) {
        setOrchestration({ projectId, status: 'idle' });
        return;
      }
      setOrchestration({ projectId, status: 'pending', phase: 'unknown-refresh', error: caught });
      let refreshFailed = false;
      try {
        await onCommitOutcomeUnknown();
      } catch {
        refreshFailed = true;
      }
      if (orchestrationOwner.current !== owner) return;
      setOrchestration({
        projectId,
        status: 'failed',
        failure: 'outcome-unknown',
        refreshFailed,
        error: refreshFailed
          ? new Error('The import outcome is unknown, and the dashboard could not refresh canonical data. Check Endpoints before trying again.')
          : caught,
      });
    }
  };

  const displayedError = outcomeUnknown ? currentOrchestration.error : wizard.error;

  return (
    <Modal
      isOpen={isOpen}
      label="Import API requests"
      loading={interactionLocked}
      onCancel={requestClose}
      className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white sm:h-[min(52rem,calc(100dvh-2rem))] sm:max-w-6xl sm:rounded-xl sm:border sm:border-gray-200 sm:shadow-xl"
    >
      <header className="shrink-0 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Import API requests</h1>
            <ol aria-label="Import progress" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
              {(Object.keys(stepLabels) as Array<keyof typeof stepLabels>).map((step, index) => (
                <li key={step} aria-current={wizard.step === step ? 'step' : undefined} className={wizard.step === step ? 'font-semibold text-blue-700' : undefined}>
                  {index + 1}. {stepLabels[step]}
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            aria-label="Close import"
            onClick={requestClose}
            disabled={interactionLocked}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </header>

      {wizard.step === 'source' ? (
        <ImportSourceStep
          sourceType={wizard.sourceType}
          curlText={wizard.curlText}
          postmanFile={wizard.postmanFile}
          error={displayedError}
          loading={wizard.loadingPreview}
          disabled={interactionLocked}
          onSourceTypeChange={wizard.setSourceType}
          onCurlTextChange={wizard.setCurlText}
          onPostmanFile={wizard.setPostmanFile}
          onPreview={previewSource}
        />
      ) : null}

      {wizard.step === 'resolve' && wizard.preview ? (
        <ImportResolveStep
          preview={wizard.preview}
          variables={wizard.variables}
          error={displayedError}
          loading={wizard.loadingPreview}
          disabled={interactionLocked}
          onVariableChange={wizard.setVariable}
          onContinue={continueFromResolve}
        />
      ) : null}

      {wizard.step === 'review' && wizard.preview ? (
        <ImportReviewStep
          preview={wizard.preview}
          choices={wizard.choices}
          canCommit={wizard.canCommit}
          stale={wizard.stale}
          outcomeUnknown={outcomeUnknown}
          error={displayedError}
          committing={interactionLocked}
          refreshing={wizard.loadingPreview}
          onChoiceChange={wizard.setChoice}
          onRefresh={refreshPreview}
          onCommit={commit}
        />
      ) : null}

      {currentOrchestration.status === 'pending'
        && currentOrchestration.phase === 'canonical-refresh' ? (
        <div role="status" className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-8 sm:px-6 sm:py-12">
          <div className="w-full max-w-xl rounded-md border border-blue-200 bg-blue-50 px-4 py-4 text-blue-900">
            <h2 className="text-lg font-semibold">Refreshing dashboard data</h2>
            <p className="mt-2 text-sm">The import was accepted. Refreshing canonical dashboard data before showing results.</p>
          </div>
        </div>
      ) : null}

      {currentOrchestration.status === 'failed'
        && currentOrchestration.failure === 'canonical-refresh' ? (
        <div role="alert" className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-8 sm:px-6 sm:py-12">
          <div className="w-full max-w-xl rounded-md border border-red-200 bg-red-50 px-4 py-4 text-red-900">
            <h2 className="text-lg font-semibold">Dashboard refresh failed</h2>
            <p className="mt-2 text-sm">The import was accepted, but the dashboard could not refresh canonical data. Do not import again.</p>
            <button
              type="button"
              onClick={() => void refreshCanonicalData(currentOrchestration.result)}
              className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              Retry dashboard refresh
            </button>
          </div>
        </div>
      ) : null}

      {currentOrchestration.status === 'succeeded' ? (
        <ImportResultStep
          result={currentOrchestration.result}
          discoveredOrigins={wizard.discoveredOrigins}
          onViewEndpoints={onViewEndpoints}
        />
      ) : null}
    </Modal>
  );
}
