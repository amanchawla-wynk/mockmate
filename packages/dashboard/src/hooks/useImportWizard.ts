import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

import { ApiClientError, importApi } from '../api/client';
import type {
  ImportAction,
  ImportActionName,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewItem,
  ImportSource,
  ImportSourceType,
} from '../api/types';

export type ImportWizardStep = 'source' | 'resolve' | 'review' | 'complete';

export interface ImportItemChoice {
  selected: boolean;
  action?: ImportActionName;
  endpointId?: string;
  confirmOverlap?: boolean;
}

export class ImportWizardValidationError extends Error {
  readonly name = 'ImportWizardValidationError';
}

export class ImportCommitOutcomeUnknownError extends Error {
  readonly name = 'ImportCommitOutcomeUnknownError';

  constructor() {
    super('The import outcome is unknown. Canonical data was refreshed before showing this message.');
  }
}

export interface UseImportWizardResult {
  step: ImportWizardStep;
  sourceType: ImportSourceType;
  curlText: string;
  postmanFile?: File;
  variables: Record<string, string>;
  preview?: ImportPreview;
  discoveredOrigins: string[];
  choices: Record<string, ImportItemChoice>;
  result?: ImportCommitResult;
  loadingPreview: boolean;
  committing: boolean;
  stale: boolean;
  dirty: boolean;
  error?: ApiClientError | Error;
  canCommit: boolean;
  setSourceType(type: ImportSourceType): void;
  setCurlText(text: string): void;
  setPostmanFile(file: File): Promise<void>;
  setVariable(name: string, value: string): void;
  previewSource(): Promise<void>;
  continueFromResolve(): Promise<void>;
  setChoice(itemId: string, patch: Partial<ImportItemChoice>): void;
  refreshPreview(): Promise<void>;
  commit(): Promise<ImportCommitResult>;
  cancelPreview(): void;
  reset(): void;
}

function defaultChoice(item: ImportPreviewItem): ImportItemChoice {
  return {
    selected: item.selectedByDefault && item.errors.length === 0 && itemCanBeSelected(item),
    action: item.proposedAction,
    ...(item.proposedAction === 'create' ? { confirmOverlap: false } : {}),
    ...(item.proposedAction === 'merge' && item.exactTargets.length === 1
      ? { endpointId: item.exactTargets[0]!.endpointId }
      : {}),
  };
}

function itemCanBeSelected(item: ImportPreviewItem): boolean {
  return item.allowedActions.some(action => action !== 'skip');
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function overlapSignature(item: ImportPreviewItem): string {
  return item.overlaps.map(overlap => [
    overlap.endpointId ? `endpoint:${overlap.endpointId}` : `item:${overlap.itemId ?? ''}`,
    overlap.relativeSpecificity,
    overlap.confirmationRequired ? 'required' : 'not-required',
  ].join('|')).sort(codeUnitCompare).join('\n');
}

export function reconcileImportChoices(
  previous: ImportPreview,
  next: ImportPreview,
  choices: Record<string, ImportItemChoice>,
): Record<string, ImportItemChoice> {
  const previousById = new Map(previous.items.map(item => [item.id, item]));
  return Object.fromEntries(next.items.map(nextItem => {
    const previousItem = previousById.get(nextItem.id);
    const choice = choices[nextItem.id];
    if (!previousItem || !choice) return [nextItem.id, defaultChoice(nextItem)];
    if (nextItem.errors.length > 0 || !itemCanBeSelected(nextItem)) {
      return [nextItem.id, { ...defaultChoice(nextItem), selected: false }];
    }

    const retained: ImportItemChoice = { selected: choice.selected };
    if (!choice.action || !nextItem.allowedActions.includes(choice.action)) {
      return [nextItem.id, retained];
    }
    if (choice.action === 'skip') return [nextItem.id, { ...retained, action: 'skip' }];
    if (choice.action === 'merge') {
      if (choice.endpointId
        && nextItem.exactTargets.some(target => target.endpointId === choice.endpointId)) {
        return [nextItem.id, {
          ...retained,
          action: 'merge',
          endpointId: choice.endpointId,
        }];
      }
      return [nextItem.id, retained];
    }
    if (overlapSignature(previousItem) !== overlapSignature(nextItem)) {
      return [nextItem.id, retained];
    }
    return [nextItem.id, {
      ...retained,
      action: 'create',
      confirmOverlap: choice.confirmOverlap ?? false,
    }];
  }));
}

function needsInitialResolution(value: ImportPreview): boolean {
  return value.unresolvedVariables.length > 0
    || value.unresolvedMembers.length > 0
    || value.items.some(item => item.errors.length > 0);
}

function choiceIsEffective(item: ImportPreviewItem, choice: ImportItemChoice): boolean {
  if (choice.action === 'create') {
    return item.createEffect.createsEndpoint || item.createEffect.createsVariants > 0;
  }
  if (choice.action === 'merge') {
    return (item.exactTargets.find(target => target.endpointId === choice.endpointId)?.newVariantCount ?? 0) > 0;
  }
  return false;
}

function choicesCanCommit(
  preview: ImportPreview | undefined,
  choices: Record<string, ImportItemChoice>,
): boolean {
  if (!preview || preview.unresolvedVariables.length > 0) return false;
  const selected = preview.items.filter(item => choices[item.id]?.selected);
  if (selected.length === 0) return false;
  let hasEffectiveChange = false;
  for (const item of selected) {
    const choice = choices[item.id];
    if (!choice || item.errors.length > 0 || !choice.action
      || !itemCanBeSelected(item) || !item.allowedActions.includes(choice.action)) return false;
    if (choice.action === 'merge'
      && !item.exactTargets.some(target => target.endpointId === choice.endpointId)) return false;
    if (choice.action === 'create'
      && item.overlaps.some(overlap => overlap.confirmationRequired)
      && !choice.confirmOverlap) return false;
    if (choiceIsEffective(item, choice)) hasEffectiveChange = true;
  }
  return hasEffectiveChange;
}

export function useImportWizard(projectId: string): UseImportWizardResult {
  const [step, setStep] = useState<ImportWizardStep>('source');
  const [sourceType, setSourceTypeState] = useState<ImportSourceType>('curl');
  const [curlText, setCurlTextState] = useState('');
  const [postmanFile, setPostmanFileState] = useState<File>();
  const [postmanCollection, setPostmanCollection] = useState<unknown>();
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreview>();
  const [discoveredOrigins, setDiscoveredOrigins] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, ImportItemChoice>>({});
  const [result, setResult] = useState<ImportCommitResult>();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<ApiClientError | Error>();
  const previewController = useRef<AbortController | undefined>(undefined);
  const postmanReadOwner = useRef(0);
  const projectRef = useRef(projectId);

  const cancelPreview = () => {
    previewController.current?.abort();
    previewController.current = undefined;
    setLoadingPreview(false);
  };

  const reset = () => {
    cancelPreview();
    postmanReadOwner.current += 1;
    setStep('source');
    setSourceTypeState('curl');
    setCurlTextState('');
    setPostmanFileState(undefined);
    setPostmanCollection(undefined);
    setVariables({});
    setPreview(undefined);
    setDiscoveredOrigins([]);
    setChoices({});
    setResult(undefined);
    setCommitting(false);
    setStale(false);
    setError(undefined);
  };
  const resetOnProjectChange = useEffectEvent(reset);

  useLayoutEffect(() => {
    if (projectRef.current === projectId) return;
    projectRef.current = projectId;
    resetOnProjectChange();
  }, [projectId]);

  useEffect(() => () => {
    previewController.current?.abort();
  }, []);

  const clearPreviewForSourceEdit = () => {
    cancelPreview();
    setPreview(undefined);
    setDiscoveredOrigins([]);
    setChoices({});
    setResult(undefined);
    setStep('source');
    setStale(false);
    setError(undefined);
  };

  const setSourceType = (type: ImportSourceType) => {
    clearPreviewForSourceEdit();
    setSourceTypeState(type);
  };

  const setCurlText = (text: string) => {
    clearPreviewForSourceEdit();
    setCurlTextState(text);
  };

  const setPostmanFile = async (file: File) => {
    const owner = postmanReadOwner.current + 1;
    postmanReadOwner.current = owner;
    clearPreviewForSourceEdit();
    setPostmanFileState(file);
    setPostmanCollection(undefined);
    if (!file.name.toLowerCase().endsWith('.json')) {
      setError(new ImportWizardValidationError('Choose one .json Postman collection file.'));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (postmanReadOwner.current !== owner) return;
      setPostmanCollection(parsed);
      setError(undefined);
    } catch {
      if (postmanReadOwner.current !== owner) return;
      setError(new ImportWizardValidationError('The selected file must contain valid JSON.'));
    }
  };

  const setVariable = (name: string, value: string) => {
    setVariables(current => ({ ...current, [name]: value }));
    setError(undefined);
  };

  const buildSource = (): ImportSource => {
    if (sourceType === 'curl') {
      if (!curlText.trim()) throw new ImportWizardValidationError('Paste at least one cURL command.');
      return { type: 'curl', text: curlText };
    }
    if (postmanCollection === undefined) {
      throw new ImportWizardValidationError('Choose a valid Postman collection JSON file.');
    }
    return { type: 'postman', collection: postmanCollection };
  };

  const runPreview = async (mode: 'initial' | 'resolve' | 'refresh') => {
    let source: ImportSource;
    try {
      source = buildSource();
    } catch (caught) {
      const validationError = caught instanceof Error
        ? caught
        : new ImportWizardValidationError('Choose a valid import source.');
      setError(validationError);
      throw validationError;
    }

    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setLoadingPreview(true);
    setError(undefined);
    const previous = preview;
    const previousChoices = choices;
    try {
      const next = await importApi.preview(projectId, {
        source,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
      }, controller.signal);
      if (previewController.current !== controller) return;
      setPreview(next);
      setDiscoveredOrigins(next.discoveredOrigins);
      setChoices(mode === 'refresh' && previous
        ? reconcileImportChoices(previous, next, previousChoices)
        : Object.fromEntries(next.items.map(item => [item.id, defaultChoice(item)])));
      setResult(undefined);
      setStale(false);
      if (mode === 'initial') setStep(needsInitialResolution(next) ? 'resolve' : 'review');
      else if (mode === 'resolve') {
        setStep(next.unresolvedVariables.length > 0 ? 'resolve' : 'review');
      } else setStep('review');
    } catch (caught) {
      if (previewController.current !== controller || controller.signal.aborted) return;
      const nextError = caught instanceof Error ? caught : new Error('Failed to preview import.');
      setError(nextError);
      throw nextError;
    } finally {
      if (previewController.current === controller) {
        previewController.current = undefined;
        setLoadingPreview(false);
      }
    }
  };

  const previewSource = () => runPreview('initial');
  const continueFromResolve = () => runPreview('resolve');
  const refreshPreview = () => runPreview('refresh');

  const setChoice = (itemId: string, patch: Partial<ImportItemChoice>) => {
    const item = preview?.items.find(candidate => candidate.id === itemId);
    const constrainedPatch = item && !itemCanBeSelected(item)
      ? { ...patch, selected: false }
      : patch;
    setChoices(current => ({
      ...current,
      [itemId]: { ...current[itemId], selected: current[itemId]?.selected ?? false, ...constrainedPatch },
    }));
    setError(undefined);
  };

  const canCommit = choicesCanCommit(preview, choices);
  const commit = async (): Promise<ImportCommitResult> => {
    if (!preview || !canCommit) {
      const validationError = new ImportWizardValidationError(
        'Resolve every selected import action before committing.',
      );
      setError(validationError);
      throw validationError;
    }
    const selectedItemIds = preview.items
      .filter(item => itemCanBeSelected(item) && choices[item.id]?.selected)
      .map(item => item.id);
    const actions: ImportAction[] = selectedItemIds.map(itemId => {
      const choice = choices[itemId]!;
      if (choice.action === 'create') {
        return { itemId, action: 'create', ...(choice.confirmOverlap ? { confirmOverlap: true } : {}) };
      }
      if (choice.action === 'merge' && choice.endpointId) {
        return { itemId, action: 'merge', endpointId: choice.endpointId };
      }
      if (choice.action === 'skip') return { itemId, action: 'skip' };
      throw new ImportWizardValidationError('Import action is incomplete');
    });

    const source = buildSource();
    const operationProjectId = projectId;
    setCommitting(true);
    setError(undefined);
    try {
      const committed = await importApi.commit(projectId, {
        source,
        ...(Object.keys(variables).length > 0 ? { variables } : {}),
        snapshotToken: preview.snapshotToken,
        selectedItemIds,
        actions,
      });
      if (projectRef.current !== operationProjectId) {
        throw new ImportWizardValidationError('The Project changed while the import was committing.');
      }
      setResult(committed);
      setStep('complete');
      setStale(false);
      setCurlTextState('');
      setPostmanFileState(undefined);
      setPostmanCollection(undefined);
      setVariables({});
      setPreview(undefined);
      setChoices({});
      return committed;
    } catch (caught) {
      if (projectRef.current !== operationProjectId) {
        throw new ImportWizardValidationError('The Project changed while the import was committing.');
      }
      if (caught instanceof ImportWizardValidationError) throw caught;
      if (caught instanceof ApiClientError && caught.status >= 400 && caught.status < 500) {
        setError(caught);
        if (caught.code === 'IMPORT_PREVIEW_STALE') {
          setStale(true);
          setStep('review');
        }
        throw caught;
      }
      setCurlTextState('');
      setPostmanFileState(undefined);
      setPostmanCollection(undefined);
      setVariables({});
      throw new ImportCommitOutcomeUnknownError();
    } finally {
      setCommitting(false);
    }
  };

  const dirty = result === undefined && (
    curlText.length > 0
    || postmanFile !== undefined
    || Object.keys(variables).length > 0
    || preview !== undefined
  );

  return {
    step,
    sourceType,
    curlText,
    postmanFile,
    variables,
    preview,
    discoveredOrigins,
    choices,
    result,
    loadingPreview,
    committing,
    stale,
    dirty,
    error,
    canCommit,
    setSourceType,
    setCurlText,
    setPostmanFile,
    setVariable,
    previewSource,
    continueFromResolve,
    setChoice,
    refreshPreview,
    commit,
    cancelPreview,
    reset,
  };
}
