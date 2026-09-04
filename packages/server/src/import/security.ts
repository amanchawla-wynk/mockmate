import { createHash, createHmac } from 'node:crypto';

import type { EndpointMatcherInput } from '../domain/model';
import { isSensitiveQueryName, redactTrafficQuery } from '../domain/traffic-redaction';
import type { ImportRequestSummary } from './contracts';

const REDACTED = '[REDACTED]';
const SECRET_NAME = /(token|secret|password|key|credential|session|auth)/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = Array.from(value, item => canonicalValue(item) ?? 'null');
    return `[${items.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .flatMap(([key, nested]) => {
        const serialized = canonicalValue(nested);
        return serialized === undefined
          ? []
          : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string {
  const serialized = canonicalValue(value);
  if (serialized === undefined) throw new TypeError('Import identity value is not serializable');
  return serialized;
}

export function sha256Identity(namespace: string, value: unknown): string {
  return createHash('sha256').update(namespace).update('\0').update(canonicalJson(value)).digest('hex');
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestVariables(variables: Record<string, string>, key: Buffer): string {
  return createHmac('sha256', key).update('import-variables-v1\0').update(canonicalJson(variables)).digest('hex');
}

export function redactRequestSummary(summary: ImportRequestSummary): ImportRequestSummary {
  const redacted: ImportRequestSummary = {
    query: redactTrafficQuery(summary.query),
    headers: summary.headers.map(field => ({
      name: field.name,
      value: SECRET_HEADER.test(field.name) || SECRET_NAME.test(field.name) ? REDACTED : field.value,
    })),
  };

  if (summary.scheme !== undefined) redacted.scheme = summary.scheme;
  if (summary.hostname !== undefined) redacted.hostname = summary.hostname;
  if (summary.port !== undefined) redacted.port = summary.port;
  if (summary.userInfo !== undefined) redacted.userInfo = REDACTED;
  if (summary.auth !== undefined) {
    redacted.auth = {
      type: summary.auth.type,
      fields: summary.auth.fields.map(field => ({
        name: field.name,
        value: REDACTED,
      })),
    };
  }
  if (summary.body !== undefined) {
    redacted.body = {
      ...(summary.body.mediaType === undefined ? {} : { mediaType: summary.body.mediaType }),
      byteCount: summary.body.byteCount,
      omitted: true,
    };
  }

  return redacted;
}

export function redactImportMatcher(matcher: EndpointMatcherInput): EndpointMatcherInput {
  return {
    method: matcher.method,
    path: matcher.path,
    ...(matcher.query === undefined ? {} : {
      query: Object.fromEntries(Object.entries(matcher.query).map(([name, expressions]) => [
        name,
        expressions.map(expression => ({
          ...expression,
          value: isSensitiveQueryName(name) ? REDACTED : expression.value,
        })),
      ])),
    }),
    ...(matcher.headers === undefined ? {} : {
      headers: Object.fromEntries(Object.entries(matcher.headers).map(([name, expression]) => [
        name,
        { ...expression },
      ])),
    }),
  };
}
