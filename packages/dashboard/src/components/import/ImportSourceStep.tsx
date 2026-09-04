import { useRef, type DragEvent, type KeyboardEvent } from 'react';

import type { ImportSourceType } from '../../api/types';

export interface ImportSourceStepProps {
  sourceType: ImportSourceType;
  curlText: string;
  postmanFile?: File;
  error?: Error;
  loading: boolean;
  disabled: boolean;
  onSourceTypeChange(type: ImportSourceType): void;
  onCurlTextChange(text: string): void;
  onPostmanFile(file: File): Promise<void>;
  onPreview(): Promise<void>;
}

const sourceTypes = ['curl', 'postman'] as const;

export function ImportSourceStep({
  sourceType,
  curlText,
  postmanFile,
  error,
  loading,
  disabled,
  onSourceTypeChange,
  onCurlTextChange,
  onPostmanFile,
  onPreview,
}: ImportSourceStepProps) {
  const tabsRef = useRef<Record<ImportSourceType, HTMLButtonElement | null>>({
    curl: null,
    postman: null,
  });
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    const file = event.dataTransfer.files[0] ?? event.dataTransfer.files.item?.(0);
    if (file) void onPostmanFile(file);
  };
  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    type: ImportSourceType,
  ) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = sourceTypes.indexOf(type);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? sourceTypes.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + sourceTypes.length)
          % sourceTypes.length;
    const nextType = sourceTypes[nextIndex]!;
    onSourceTypeChange(nextType);
    tabsRef.current[nextType]?.focus();
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Choose a source</h2>
            <p className="mt-1 text-sm text-gray-600">
              Preview cURL commands or a Postman collection before changing this Project.
            </p>
          </div>

          <div role="tablist" aria-label="Import source" className="flex border-b border-gray-200">
            {sourceTypes.map(type => (
              <button
                key={type}
                ref={element => { tabsRef.current[type] = element; }}
                type="button"
                role="tab"
                id={`import-source-tab-${type}`}
                aria-controls={`import-source-panel-${type}`}
                aria-selected={sourceType === type}
                data-modal-initial-focus={sourceType === type ? '' : undefined}
                tabIndex={sourceType === type ? 0 : -1}
                disabled={disabled || loading}
                onClick={() => onSourceTypeChange(type)}
                onKeyDown={event => handleTabKeyDown(event, type)}
                className={`border-b-2 px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                  sourceType === type
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {type === 'curl' ? 'cURL' : 'Postman'}
              </button>
            ))}
          </div>

          {sourceType === 'curl' ? (
            <div id="import-source-panel-curl" role="tabpanel" aria-labelledby="import-source-tab-curl" className="space-y-2">
              <label htmlFor="import-curl" className="block text-sm font-medium text-gray-800">
                cURL commands
              </label>
              <textarea
                id="import-curl"
                value={curlText}
                disabled={disabled || loading}
                onChange={event => onCurlTextChange(event.target.value)}
                rows={10}
                spellCheck={false}
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
              />
              <p className="text-sm text-gray-600">
                Paste one or more complete commands, separated by line breaks.
              </p>
            </div>
          ) : (
            <div id="import-source-panel-postman" role="tabpanel" aria-labelledby="import-source-tab-postman" className="space-y-2">
              <label htmlFor="import-postman" className="block text-sm font-medium text-gray-800">
                Postman collection file
              </label>
              <div
                data-testid="postman-drop-zone"
                onDragOver={event => event.preventDefault()}
                onDrop={handleDrop}
                className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/30"
              >
                <input
                  id="import-postman"
                  type="file"
                  accept=".json,application/json"
                  disabled={disabled || loading}
                  onChange={event => {
                    const file = event.target.files?.item(0);
                    if (file) void onPostmanFile(file);
                  }}
                  className="block w-full text-sm text-gray-700 file:mr-3 file:rounded file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:font-medium file:text-blue-700 hover:file:bg-blue-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="mt-2 text-sm text-gray-600">Choose or drop one .json collection file.</p>
                {postmanFile ? <p className="mt-2 text-sm font-medium text-gray-900">{postmanFile.name}</p> : null}
              </div>
            </div>
          )}

          {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</p> : null}

          {loading ? (
            <div aria-label="Loading import preview" className="overflow-hidden rounded-md border border-gray-200">
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600">
                <span>Request</span>
                <span>Action</span>
              </div>
              {[0, 1, 2].map(index => (
                <div key={index} data-testid="preview-skeleton-row" className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-t border-gray-200 px-3 py-3">
                  <span className="h-4 rounded bg-gray-200" />
                  <span className="h-4 rounded bg-gray-200" />
                </div>
              ))}
              <p className="sr-only">Parsing source and checking existing Endpoints.</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 justify-end border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => void onPreview()}
          disabled={disabled || loading || (sourceType === 'curl' ? !curlText.trim() : !postmanFile)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Preparing preview...' : 'Preview import'}
        </button>
      </div>
    </>
  );
}
