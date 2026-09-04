import { z } from 'zod';

export interface ValidationFinding {
  severity: 'warning' | 'blocking';
  code: string;
  file: string;
  path?: string;
  message: string;
  recovery: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; findings: ValidationFinding[] };

const dynamicRecordFields = new Set([
  'bindings',
  'headers',
  'query',
  'responseHeaders',
]);

function canonicalFindingPath(path: PropertyKey[]): PropertyKey[] {
  const dynamicRecordIndex = path.findIndex(segment => (
    typeof segment === 'string' && dynamicRecordFields.has(segment)
  ));
  return dynamicRecordIndex === -1 ? path : path.slice(0, dynamicRecordIndex + 1);
}

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === 'number') return `${formatted}[${segment}]`;
    const property = String(segment);
    return /^[A-Za-z_$][\w$]*$/.test(property)
      ? `${formatted}.${property}`
      : `${formatted}[${JSON.stringify(property)}]`;
  }, '$');
}

function fieldCode(path: PropertyKey[]): string {
  const field = [...path].reverse().find(segment => typeof segment === 'string');
  if (field === undefined) return 'INVALID_RECORD';
  const normalized = field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized ? `INVALID_${normalized}` : 'INVALID_RECORD';
}

function toFinding(file: string, issue: z.core.$ZodIssue): ValidationFinding {
  const canonicalPath = canonicalFindingPath(issue.path);
  const path = formatPath(canonicalPath);

  if (issue.path.length === 1 && issue.path[0] === 'schemaVersion') {
    return {
      severity: 'blocking',
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      file,
      path,
      message: 'The record uses an unsupported schema version.',
      recovery: 'Reset the configured MockMate data directory and restart the fresh schema-v4 application.',
    };
  }

  if (issue.code === 'custom' && issue.message.startsWith('Duplicate header')) {
    return {
      severity: 'blocking',
      code: 'DUPLICATE_HEADER',
      file,
      path,
      message: 'Header names must be unique after lowercase normalization.',
      recovery: 'Remove the duplicate header and keep one unique lowercase name.',
    };
  }

  if (issue.code === 'unrecognized_keys') {
    return {
      severity: 'blocking',
      code: 'UNKNOWN_FIELD',
      file,
      path,
      message: 'The record contains one or more unsupported fields.',
      recovery: 'Remove unsupported fields and retry loading the record.',
    };
  }

  const code = fieldCode(canonicalPath);
  const field = path === '$' ? 'record' : path;
  return {
    severity: 'blocking',
    code,
    file,
    path,
    message: `The ${field} field is invalid.`,
    recovery: `Correct the ${field} field and retry loading the record.`,
  };
}

export function parsePersistedRecord<T>(
  schema: z.ZodType<T>,
  input: unknown,
  file: string,
): ParseResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    findings: parsed.error.issues.map(issue => toFinding(file, issue)),
  };
}
