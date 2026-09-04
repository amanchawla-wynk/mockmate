import { validateHeaderName, validateHeaderValue } from 'node:http';

import { Router } from 'express';
import { z } from 'zod';

import { normalizeHttpOrigin } from '../../domain/http-origin';
import { AuthoredResponseStatusSchema } from '../../domain/schemas';
import type { ProjectRepository } from '../../repository/project-repository';
import { asyncHandler, HttpError, parseApiInput } from '../../services/api-errors';
import { isStablePathSegment } from '../../services/storage';

const nonEmptyString = z.string().refine(value => value.trim().length > 0, 'Must not be empty');
const revision = z.number().int().nonnegative();
const stableId = z.string().refine(isStablePathSegment, 'Must be a stable ID');
const idParams = z.strictObject({
  projectId: stableId,
  endpointId: stableId.optional(),
  variantId: stableId.optional(),
});
const matchExpression = z.discriminatedUnion('operator', [
  z.strictObject({ operator: z.literal('equals'), value: z.string() }),
  z.strictObject({ operator: z.literal('glob'), value: z.string() }),
]);
const responseHeaderValue = z.string().superRefine((value, context) => {
  try {
    validateHeaderValue('response-header', value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid HTTP header value' });
  }
});

function normalizedHeaderRecord<T extends z.ZodType>(valueSchema: T) {
  return z.unknown().transform((headers, context) => {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      context.addIssue({ code: 'custom', message: 'Expected a header record' });
      return z.NEVER;
    }

    const normalized = Object.create(null) as Record<string, z.output<T>>;
    for (const [name, value] of Object.entries(headers)) {
      try {
        validateHeaderName(name);
      } catch {
        context.addIssue({ code: 'custom', path: [name], message: 'Invalid HTTP header name' });
        continue;
      }

      const normalizedName = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(normalized, normalizedName)) {
        context.addIssue({
          code: 'custom',
          path: [normalizedName],
          message: `Duplicate header after lowercase normalization: ${normalizedName}`,
        });
        continue;
      }

      const parsed = valueSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ ...issue, path: [name, ...issue.path] });
        }
        continue;
      }
      normalized[normalizedName] = parsed.data;
    }

    return Object.fromEntries(Object.entries(normalized));
  });
}

const matcher = z.strictObject({
  method: nonEmptyString,
  path: nonEmptyString.refine(value => value.startsWith('/'), 'Path must start with /'),
  query: z.record(z.string(), z.array(matchExpression).min(1)).optional(),
  headers: normalizedHeaderRecord(matchExpression).optional(),
});
const baseUrl = nonEmptyString.transform((value, context) => {
  try {
    return normalizeHttpOrigin(value).origin;
  } catch {
    context.addIssue({ code: 'custom', message: 'Endpoint base URL must be an HTTP origin' });
    return z.NEVER;
  }
});
const responseHeaderValues = z.union([
  responseHeaderValue,
  z.array(responseHeaderValue).min(1),
]);
const responseHeaders = normalizedHeaderRecord(responseHeaderValues);
const bodyAssetId = z.string().regex(/^[a-f0-9]{64}$/);
const variantInput = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
  status: AuthoredResponseStatusSchema,
  responseHeaders,
  bodyAssetId: bodyAssetId.optional(),
  delayMs: z.number().int().nonnegative().optional(),
});
const endpointCreate = z.strictObject({
  name: nonEmptyString,
  description: z.string().optional(),
  baseUrl,
  matcher,
  mode: z.enum(['mock', 'passthrough']),
  variants: z.array(variantInput).optional(),
  defaultVariantIndex: z.number().int().nonnegative().optional(),
}).superRefine((input, context) => {
  const variants = input.variants ?? [];
  if (input.mode === 'mock' && variants.length === 0) {
    context.addIssue({ code: 'custom', path: ['variants'], message: 'Mock Endpoints require a Variant' });
  }
  if (variants.length > 0 && input.defaultVariantIndex === undefined) {
    context.addIssue({ code: 'custom', path: ['defaultVariantIndex'], message: 'Fallback Variant is required' });
  }
  if (input.defaultVariantIndex !== undefined && input.defaultVariantIndex >= variants.length) {
    context.addIssue({
      code: 'custom',
      path: ['defaultVariantIndex'],
      message: 'Default variant index is out of range',
    });
  }
});
const endpointPatch = z.strictObject({
  name: nonEmptyString.optional(),
  description: z.string().nullable().optional(),
  baseUrl: baseUrl.optional(),
  matcher: matcher.optional(),
  defaultVariantId: nonEmptyString.optional(),
});
const endpointUpdate = z.strictObject({ expectedRevision: revision, patch: endpointPatch });
const endpointModeUpdate = z.strictObject({
  mode: z.enum(['mock', 'passthrough']),
  expectedRevision: revision,
});
const deleteInput = z.strictObject({ expectedRevision: revision });
const variantCreate = z.strictObject({
  expectedEndpointRevision: revision,
  name: nonEmptyString,
  description: z.string().optional(),
  status: AuthoredResponseStatusSchema,
  responseHeaders,
  bodyAssetId: bodyAssetId.optional(),
  delayMs: z.number().int().nonnegative().optional(),
});
const variantPatch = z.strictObject({
  name: nonEmptyString.optional(),
  description: z.string().nullable().optional(),
  status: AuthoredResponseStatusSchema.optional(),
  responseHeaders: responseHeaders.optional(),
  bodyAssetId: bodyAssetId.nullable().optional(),
  delayMs: z.number().int().nonnegative().nullable().optional(),
});
const variantUpdate = z.strictObject({ expectedRevision: revision, patch: variantPatch });
const variantDeleteInput = z.strictObject({
  expectedRevision: revision,
  expectedEndpointRevision: revision.optional(),
  replacementVariantId: stableId.optional(),
}).superRefine((value, context) => {
  const hasEndpointRevision = value.expectedEndpointRevision !== undefined;
  const hasReplacement = value.replacementVariantId !== undefined;
  if (hasEndpointRevision === hasReplacement) return;
  context.addIssue({
    code: 'custom',
    message: 'expectedEndpointRevision and replacementVariantId must be provided together',
  });
});

function parseIdParams(input: unknown): z.output<typeof idParams> {
  const parsed = idParams.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new HttpError(400, 'VALIDATION_FAILED', 'Request path validation failed');
}

function parseVariantDeleteInput(input: unknown): z.output<typeof variantDeleteInput> {
  if (typeof input === 'object' && input !== null) {
    const value = input as Record<string, unknown>;
    const hasEndpointRevision = value.expectedEndpointRevision !== undefined;
    const hasReplacement = value.replacementVariantId !== undefined;
    if (hasEndpointRevision !== hasReplacement) {
      throw new HttpError(
        400,
        'VALIDATION_FAILED',
        'expectedEndpointRevision and replacementVariantId must be provided together',
      );
    }
  }
  return parseApiInput(variantDeleteInput, input);
}

export function createEndpointsRouter(repository: ProjectRepository): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const { projectId } = parseIdParams(req.params);
    res.json(repository.listEndpoints(projectId));
  });

  router.post('/', asyncHandler(async (req, res) => {
    const { projectId } = parseIdParams(req.params);
    const input = parseApiInput(endpointCreate, req.body);
    res.status(201).json(await repository.createEndpoint(projectId, input));
  }));

  router.get('/:endpointId/deletion-impact', (req, res) => {
    const { projectId, endpointId } = parseIdParams(req.params);
    res.json(repository.getEndpointDeletionImpact(projectId, endpointId!));
  });

  router.get('/:endpointId/variants/:variantId/deletion-impact', (req, res) => {
    const { projectId, endpointId, variantId } = parseIdParams(req.params);
    res.json(repository.getVariantDeletionImpact(projectId, endpointId!, variantId!));
  });

  router.get('/:endpointId', (req, res) => {
    const { projectId, endpointId } = parseIdParams(req.params);
    res.json(repository.getEndpoint(projectId, endpointId!));
  });

  router.put('/:endpointId', asyncHandler(async (req, res) => {
    const { projectId, endpointId } = parseIdParams(req.params);
    const { expectedRevision, patch } = parseApiInput(endpointUpdate, req.body);
    res.json(await repository.updateEndpoint(projectId, endpointId!, expectedRevision, patch));
  }));

  router.put('/:endpointId/mode', asyncHandler(async (req, res) => {
    const { projectId, endpointId } = parseIdParams(req.params);
    const input = parseApiInput(endpointModeUpdate, req.body);
    res.json(await repository.setEndpointMode(projectId, endpointId!, input));
  }));

  router.delete('/:endpointId', asyncHandler(async (req, res) => {
    const { projectId, endpointId } = parseIdParams(req.params);
    const { expectedRevision } = parseApiInput(deleteInput, req.body);
    await repository.deleteEndpoint(projectId, endpointId!, expectedRevision);
    res.status(204).send();
  }));

  router.post('/:endpointId/variants', asyncHandler(async (req, res) => {
    const { projectId, endpointId } = parseIdParams(req.params);
    const { expectedEndpointRevision, ...input } = parseApiInput(variantCreate, req.body);
    res.status(201).json(await repository.createVariant(
      projectId, endpointId!, expectedEndpointRevision, input,
    ));
  }));

  router.put('/:endpointId/variants/:variantId', asyncHandler(async (req, res) => {
    const { projectId, endpointId, variantId } = parseIdParams(req.params);
    const { expectedRevision, patch } = parseApiInput(variantUpdate, req.body);
    res.json(await repository.updateVariant(
      projectId, endpointId!, variantId!, expectedRevision, patch,
    ));
  }));

  router.delete('/:endpointId/variants/:variantId', asyncHandler(async (req, res) => {
    const { projectId, endpointId, variantId } = parseIdParams(req.params);
    const {
      expectedRevision,
      expectedEndpointRevision,
      replacementVariantId,
    } = parseVariantDeleteInput(req.body);
    await repository.deleteVariant(
      projectId,
      endpointId!,
      variantId!,
      expectedRevision,
      { expectedEndpointRevision, replacementVariantId },
    );
    res.status(204).send();
  }));

  return router;
}
