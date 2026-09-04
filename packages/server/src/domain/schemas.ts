import { z } from 'zod';

import { normalizeContentEncoding, normalizeMediaType } from './http-metadata';
import { normalizeHttpOrigin } from './http-origin';
import { canonicalizeQueryConstraints } from './query-matcher';

import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  GenerationPointer,
  MatchExpression,
  Project,
  ProjectRuntimeSettings,
  ResponseVariant,
  WorkspaceState,
} from './model';

const schemaVersionSchema = z.literal(4);
const idSchema = z.string().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const timestampSchema = z.string().datetime();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AuthoredResponseStatusSchema = z.number().int().min(200).max(599);

function normalizeOrIssue<T>(context: z.RefinementCtx, normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid normalized value',
    });
    return z.NEVER;
  }
}

function normalizedHeaderRecord<T extends z.ZodType>(valueSchema: T) {
  return z.unknown().transform((headers, context) => {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      context.addIssue({ code: 'custom', message: 'Expected a header record' });
      return z.NEVER;
    }

    const normalized = Object.create(null) as Record<string, z.output<T>>;

    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(normalized, normalizedName)) {
        context.addIssue({
          code: 'custom',
          path: [normalizedName],
          message: `Duplicate header after lowercase normalization: ${normalizedName}`,
        });
        return z.NEVER;
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

export const MatchExpressionSchema: z.ZodType<MatchExpression> = z.discriminatedUnion('operator', [
  z.strictObject({ operator: z.literal('equals'), value: z.string() }),
  z.strictObject({ operator: z.literal('glob'), value: z.string() }),
]);

export const ProjectSchema: z.ZodType<Project> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  appStateMode: z.enum(['enabled', 'disabled']),
  activeStateId: idSchema.optional(),
  baseStateId: idSchema.optional(),
  revision: nonNegativeIntegerSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const responseHeaderValueSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
]);

export const ResponseVariantSchema: z.ZodType<ResponseVariant> = z.strictObject({
  id: idSchema,
  endpointId: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  status: AuthoredResponseStatusSchema,
  responseHeaders: normalizedHeaderRecord(responseHeaderValueSchema),
  bodyAssetId: sha256Schema.optional(),
  delayMs: nonNegativeIntegerSchema.optional(),
  trafficProvenance: z.array(z.strictObject({
    type: z.literal('traffic'),
    trafficId: idSchema,
    trafficGeneration: idSchema,
    capturedAt: timestampSchema,
    requestOrigin: z.string().transform((value, context) => (
      normalizeOrIssue(context, () => normalizeHttpOrigin(value).origin)
    )),
    responseIdentity: idSchema,
    endpointTarget: z.enum(['create', 'reuse']),
    endpointId: idSchema,
    endpointCreated: z.boolean(),
    variantId: idSchema,
    variantCreated: z.boolean(),
    endpointModeChanged: z.boolean(),
    stateTarget: z.enum(['unbound', 'bound']),
    stateId: idSchema.optional(),
    bindingChanged: z.boolean(),
  })).optional(),
  revision: nonNegativeIntegerSchema,
});

const EndpointMatcherSchema = z.strictObject({
  method: z.string().min(1),
  path: z.string().min(1),
  query: z.record(z.string(), z.array(MatchExpressionSchema).min(1)).optional()
    .transform(value => canonicalizeQueryConstraints(value)),
  headers: normalizedHeaderRecord(MatchExpressionSchema).optional(),
});

export const EndpointSchema: z.ZodType<EndpointDetail> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  baseUrl: z.string().transform((value, context) => (
    normalizeOrIssue(context, () => normalizeHttpOrigin(value).origin)
  )),
  matcher: EndpointMatcherSchema,
  mode: z.enum(['mock', 'passthrough']),
  defaultVariantId: idSchema.optional(),
  variants: z.array(ResponseVariantSchema),
  revision: nonNegativeIntegerSchema,
});

export const AppStateSchema: z.ZodType<AppState> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: idSchema,
  projectId: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()),
  expectedUi: z.string().optional(),
  bindings: z.record(z.string(), idSchema),
  revision: nonNegativeIntegerSchema,
});

export const BodyAssetSchema: z.ZodType<BodyAsset> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: sha256Schema,
  mediaType: z.string().min(1).transform((value, context) => (
    normalizeOrIssue(context, () => normalizeMediaType(value))
  )),
  size: nonNegativeIntegerSchema,
  encoding: z.string().min(1).optional().transform((value, context) => (
    normalizeOrIssue(context, () => normalizeContentEncoding(value))
  )),
  createdAt: timestampSchema,
});

export const ProjectRuntimeSettingsSchema: z.ZodType<ProjectRuntimeSettings> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  projectId: idSchema,
  interceptHosts: z.array(z.string().min(1)),
  captureRawTraffic: z.boolean(),
  debugProvenanceHeaders: z.boolean(),
  revision: nonNegativeIntegerSchema,
});

export const WorkspaceStateSchema: z.ZodType<WorkspaceState> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  activeProjectId: idSchema.optional(),
  revision: nonNegativeIntegerSchema,
});

export const GenerationPointerSchema: z.ZodType<GenerationPointer> = z.strictObject({
  schemaVersion: schemaVersionSchema,
  generationId: idSchema,
});
