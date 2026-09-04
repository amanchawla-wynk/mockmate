import { Router } from 'express';
import { z } from 'zod';

import type {
  ImportCommitRequest,
  ImportPreviewRequest,
} from '../../import/contracts';
import type { ProjectRepository } from '../../repository/project-repository';
import { asyncHandler, HttpError } from '../../services/api-errors';

const SOURCE_LIMIT_BYTES = 10 * 1024 * 1024;
const COMMIT_FIELDS_LIMIT_BYTES = 1024 * 1024;

const source = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('curl'), text: z.string() }),
  z.strictObject({ type: z.literal('postman'), collection: z.unknown() }),
]);
const variables = z.record(z.string(), z.string()).optional();
const action = z.discriminatedUnion('action', [
  z.strictObject({
    itemId: z.string(),
    action: z.literal('create'),
    confirmOverlap: z.boolean().optional(),
  }),
  z.strictObject({ itemId: z.string(), action: z.literal('merge'), endpointId: z.string() }),
  z.strictObject({ itemId: z.string(), action: z.literal('skip') }),
]);
const previewRequest = z.strictObject({ source, variables });
const commitSource = z.object({ source, variables }).passthrough();
const commitSelection = z.strictObject({
  source: z.unknown(),
  variables: z.unknown().optional(),
  snapshotToken: z.string(),
  selectedItemIds: z.array(z.string()),
  actions: z.array(action),
});

function importError(code: string, message: string): HttpError {
  return new HttpError(422, code, message);
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

function sourceValue(body: unknown): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).source
    : undefined;
}

function nonSourceFieldsValue(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const fields = { ...body as Record<string, unknown> };
  delete fields.source;
  return fields;
}

function assertSourceLimit(body: unknown): void {
  if (serializedByteLength(sourceValue(body)) > SOURCE_LIMIT_BYTES) {
    throw importError('IMPORT_LIMIT_EXCEEDED', 'Import source exceeds the 10 MiB limit');
  }
}

function parsePreviewRequest(body: unknown): ImportPreviewRequest {
  assertSourceLimit(body);
  if (serializedByteLength(nonSourceFieldsValue(body)) > COMMIT_FIELDS_LIMIT_BYTES) {
    throw importError('IMPORT_LIMIT_EXCEEDED', 'Import preview fields exceed the 1 MiB limit');
  }
  const parsed = previewRequest.safeParse(body);
  if (!parsed.success) throw importError('IMPORT_SOURCE_INVALID', 'Import source is invalid');
  return parsed.data;
}

function parseCommitRequest(body: unknown): ImportCommitRequest {
  assertSourceLimit(body);
  if (serializedByteLength(nonSourceFieldsValue(body)) > COMMIT_FIELDS_LIMIT_BYTES) {
    throw importError('IMPORT_LIMIT_EXCEEDED', 'Import commit fields exceed the 1 MiB limit');
  }
  const parsedSource = commitSource.safeParse(body);
  if (!parsedSource.success) throw importError('IMPORT_SOURCE_INVALID', 'Import source is invalid');
  const parsedSelection = commitSelection.safeParse(body);
  if (!parsedSelection.success) {
    throw importError('IMPORT_SELECTION_INVALID', 'Import selection is invalid');
  }
  return {
    source: parsedSource.data.source,
    ...(parsedSource.data.variables === undefined ? {} : { variables: parsedSource.data.variables }),
    snapshotToken: parsedSelection.data.snapshotToken,
    selectedItemIds: parsedSelection.data.selectedItemIds,
    actions: parsedSelection.data.actions,
  };
}

export function createImportsRouter(repository: ProjectRepository): Router {
  const router = Router({ mergeParams: true });

  router.post('/preview', asyncHandler(async (req, res) => {
    res.json(repository.previewImport(req.params.projectId, parsePreviewRequest(req.body)));
  }));

  router.post('/commit', asyncHandler(async (req, res) => {
    res.status(201).json(await repository.commitImport(
      req.params.projectId,
      parseCommitRequest(req.body),
    ));
  }));

  return router;
}
