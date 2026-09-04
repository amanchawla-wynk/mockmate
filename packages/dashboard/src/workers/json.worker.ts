import type { JsonWorkerRequest, JsonWorkerResponse } from './json-worker-client';

interface JsonWorkerScope {
  onmessage: ((event: MessageEvent<JsonWorkerRequest>) => void) | null;
  postMessage(response: JsonWorkerResponse): void;
}

export function handleJsonWorkerRequest({
  id,
  operation,
  text,
  documentIdentity,
  documentGeneration,
  operationGeneration,
}: JsonWorkerRequest): JsonWorkerResponse {
  const owner = { id, documentIdentity, documentGeneration, operationGeneration };
  try {
    const value: unknown = JSON.parse(text);
    return operation === 'format'
      ? { ...owner, ok: true, formatted: JSON.stringify(value, null, 2) }
      : { ...owner, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    const positionMatch = /position\s+(\d+)/i.exec(message);
    return {
      ...owner,
      ok: false,
      message,
      ...(positionMatch ? { position: Number(positionMatch[1]) } : {}),
    };
  }
}

const workerScope = typeof self !== 'undefined' && 'importScripts' in self
  ? self as unknown as JsonWorkerScope
  : undefined;

if (workerScope) {
  workerScope.onmessage = event => {
    workerScope.postMessage(handleJsonWorkerRequest(event.data));
  };
}
