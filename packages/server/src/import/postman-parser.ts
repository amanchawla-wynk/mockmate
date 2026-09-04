import { validateHeaderName, validateHeaderValue } from 'node:http';

import { normalizeHttpOrigin } from '../domain/http-origin';
import { parseRawQuery, type QueryEntry } from '../domain/query-matcher';
import { AuthoredResponseStatusSchema } from '../domain/schemas';
import { normalizeMethod, normalizePath } from '../repository/compile-project';
import { HttpError } from '../services/api-errors';
import type {
  ImportMessage,
  ImportRequestField,
  ImportRequestSummary,
  NormalizedImportMember,
  NormalizedImportResponse,
  ParsedImportSource,
} from './contracts';
import {
  compareCodeUnits,
  redactRequestSummary,
  sha256Bytes,
  sha256Identity,
} from './security';

const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const MAX_REQUESTS = 1_000;
const MAX_RESPONSES = 5_000;
const MAX_TRAVERSAL_NODES = 10_000;
const MAX_FOLDER_DEPTH = 100;
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const DISCARDED_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'content-encoding',
]);

type UnknownRecord = Record<string, unknown>;
type PostmanAuth = UnknownRecord;

interface TraversalContext {
  itemPath: number[];
  breadcrumb: string[];
  inheritedAuth?: PostmanAuth;
  collectionVariables: Record<string, string>;
  suppliedVariables: Record<string, string>;
  counters: { requests: number; responses: number };
}

interface InterpolatedValue {
  value: string;
  unresolved: string[];
}

interface PreparedUrl {
  text: string;
  query?: ImportRequestField[];
  queryInvalid: boolean;
  unresolved: string[];
  sourcePort?: string;
}

interface TraversalEntry {
  item: unknown;
  context: TraversalContext;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function message(code: string, text: string): ImportMessage {
  return { code, message: text };
}

function sourceError(code: string, text: string): HttpError {
  return new HttpError(422, code, text);
}

function addMessage(messages: ImportMessage[], value: ImportMessage): void {
  if (!messages.some(existing => existing.code === value.code)) messages.push(value);
}

function eventsDeclared(container: UnknownRecord): boolean {
  return Array.isArray(container.event) && container.event.length > 0;
}

function scriptWarning(
  container: 'collection' | 'folder' | 'request',
  itemPath?: number[],
): ImportMessage {
  const pathContext = itemPath === undefined ? '' : ` at itemPath [${itemPath.join(',')}]`;
  return message(
    'IMPORT_SCRIPT_IGNORED',
    `Postman ${container} scripts${pathContext} are ignored during import`,
  );
}

function resolveAuth(container: UnknownRecord, inherited?: PostmanAuth): PostmanAuth | undefined {
  if (!hasOwn(container, 'auth')) return inherited;
  if (!isRecord(container.auth) || container.auth.type === 'noauth') return undefined;
  return container.auth;
}

function collectVariables(collection: UnknownRecord): Record<string, string> {
  const variables: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!Array.isArray(collection.variable)) return variables;

  for (const candidate of collection.variable) {
    if (
      isRecord(candidate)
      && candidate.disabled !== true
      && typeof candidate.key === 'string'
      && typeof candidate.value === 'string'
    ) {
      variables[candidate.key] = candidate.value;
    }
  }
  return variables;
}

function collectSuppliedVariables(variables: Record<string, string>): Record<string, string> {
  const supplied: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value === 'string') supplied[name] = value;
  }
  return supplied;
}

function interpolate(
  input: string,
  collectionVariables: Record<string, string>,
  suppliedVariables: Record<string, string>,
): InterpolatedValue {
  let value = input;
  for (let pass = 0; pass < 20; pass += 1) {
    let changed = false;
    const next = value.replace(/\{\{([^{}]+)\}\}/g, (placeholder, name: string) => {
      let replacement: string | undefined;
      if (hasOwn(collectionVariables, name)) replacement = collectionVariables[name];
      else if (hasOwn(suppliedVariables, name)) replacement = suppliedVariables[name];
      if (replacement === undefined || replacement === placeholder) return placeholder;
      changed = true;
      return replacement;
    });
    value = next;
    if (!changed) break;
  }

  const unresolved: string[] = [];
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const name = match[1];
    if (!unresolved.includes(name)) unresolved.push(name);
  }
  return { value, unresolved };
}

function mergeUnresolved(target: string[], names: string[]): void {
  for (const name of names) {
    if (!target.includes(name)) target.push(name);
  }
}

function enabledFields(
  source: unknown,
  collectionVariables: Record<string, string>,
  suppliedVariables: Record<string, string>,
): { fields: ImportRequestField[]; unresolved: string[] } {
  const fields: ImportRequestField[] = [];
  const unresolved: string[] = [];
  if (!Array.isArray(source)) return { fields, unresolved };

  for (const candidate of source) {
    if (
      !isRecord(candidate)
      || candidate.disabled === true
      || typeof candidate.key !== 'string'
      || typeof candidate.value !== 'string'
    ) continue;
    const name = interpolate(candidate.key, collectionVariables, suppliedVariables);
    const value = interpolate(candidate.value, collectionVariables, suppliedVariables);
    mergeUnresolved(unresolved, name.unresolved);
    mergeUnresolved(unresolved, value.unresolved);
    fields.push({ name: name.value, value: value.value });
  }
  return { fields, unresolved };
}

function extractExplicitSourcePort(value: string): string | undefined {
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.exec(value);
  if (!scheme) return undefined;
  const authorityStart = scheme[0].length;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndOffset < 0
    ? value.length
    : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);

  if (hostAndPort.startsWith('[')) {
    const closeBracket = hostAndPort.indexOf(']');
    if (closeBracket < 0) return undefined;
    const port = hostAndPort.slice(closeBracket + 1);
    return /^:\d+$/.test(port) ? port.slice(1) : undefined;
  }

  const colonIndex = hostAndPort.lastIndexOf(':');
  if (colonIndex < 0) return undefined;
  const port = hostAndPort.slice(colonIndex + 1);
  return /^\d+$/.test(port) ? port : undefined;
}

function structuredUrlBase(url: UnknownRecord): string | undefined {
  if (typeof url.protocol !== 'string') return undefined;
  const host = Array.isArray(url.host)
    ? url.host.every(part => typeof part === 'string') ? url.host.join('.') : undefined
    : typeof url.host === 'string' ? url.host : undefined;
  if (host === undefined) return undefined;

  const path = Array.isArray(url.path)
    ? url.path.every(part => typeof part === 'string') ? url.path.join('/') : undefined
    : typeof url.path === 'string' ? url.path.replace(/^\/+/, '') : '';
  if (path === undefined) return undefined;
  const port = typeof url.port === 'string' && url.port.length > 0 ? `:${url.port}` : '';
  const username = typeof url.username === 'string' ? url.username : '';
  const password = typeof url.password === 'string' ? `:${url.password}` : '';
  const userInfo = username || password ? `${username}${password}@` : '';
  return `${url.protocol.replace(/:$/, '')}://${userInfo}${host}${port}/${path}`;
}

function rawQueryFields(value: string): {
  fields?: ImportRequestField[];
  invalid: boolean;
} {
  const fragmentIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  if (queryIndex < 0 || (fragmentIndex >= 0 && queryIndex > fragmentIndex)) {
    return { invalid: false };
  }
  const queryEnd = fragmentIndex < 0 ? value.length : fragmentIndex;
  const parsed = parseRawQuery(value.slice(queryIndex + 1, queryEnd));
  return parsed.ok
    ? { fields: parsed.entries, invalid: false }
    : { fields: [], invalid: true };
}

function exactQueryConstraints(entries: QueryEntry[]) {
  const query: NonNullable<NormalizedImportMember['canonicalRequest']>['matcher']['query'] = {};
  for (const { name, value } of entries) {
    (query[name] ??= []).push({ operator: 'equals', value });
  }
  return Object.keys(query).length === 0 ? undefined : query;
}

function prepareUrl(
  source: unknown,
  collectionVariables: Record<string, string>,
  suppliedVariables: Record<string, string>,
): PreparedUrl | undefined {
  if (typeof source === 'string') {
    const resolved = interpolate(source, collectionVariables, suppliedVariables);
    const query = rawQueryFields(resolved.value);
    return {
      text: resolved.value,
      query: query.fields,
      queryInvalid: query.invalid,
      unresolved: resolved.unresolved,
      sourcePort: extractExplicitSourcePort(resolved.value),
    };
  }
  if (!isRecord(source)) return undefined;

  let base: string | undefined;
  if (typeof source.raw === 'string') base = source.raw;
  else base = structuredUrlBase(source);
  if (base === undefined) return undefined;

  if (!hasOwn(source, 'query')) {
    const resolved = interpolate(base, collectionVariables, suppliedVariables);
    const query = rawQueryFields(resolved.value);
    return {
      text: resolved.value,
      query: query.fields,
      queryInvalid: query.invalid,
      unresolved: resolved.unresolved,
      sourcePort: extractExplicitSourcePort(resolved.value),
    };
  }
  if (!Array.isArray(source.query)) return undefined;

  const query = enabledFields(source.query, collectionVariables, suppliedVariables);
  const fragmentIndex = base.indexOf('#');
  const fragment = fragmentIndex < 0 ? '' : base.slice(fragmentIndex);
  const beforeFragment = fragmentIndex < 0 ? base : base.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf('?');
  const querylessBase = queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  const resolvedBase = interpolate(querylessBase, collectionVariables, suppliedVariables);
  const resolvedFragment = interpolate(fragment, collectionVariables, suppliedVariables);
  const params = new URLSearchParams(query.fields.map(
    (field): [string, string] => [field.name, field.value],
  ));
  const text = params.size > 0
    ? `${resolvedBase.value}?${params.toString()}${resolvedFragment.value}`
    : `${resolvedBase.value}${resolvedFragment.value}`;
  const unresolved = [...resolvedBase.unresolved];
  mergeUnresolved(unresolved, query.unresolved);
  mergeUnresolved(unresolved, resolvedFragment.unresolved);
  return {
    text,
    query: query.fields,
    queryInvalid: false,
    unresolved,
    sourcePort: extractExplicitSourcePort(resolvedBase.value),
  };
}

function description(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.content === 'string') return value.content;
  return undefined;
}

function authSummary(
  auth: PostmanAuth | undefined,
  collectionVariables: Record<string, string>,
  suppliedVariables: Record<string, string>,
): ImportRequestSummary['auth'] {
  if (!auth || typeof auth.type !== 'string' || auth.type.length === 0) return undefined;
  const fields: ImportRequestField[] = [];
  const source = auth[auth.type];
  if (Array.isArray(source)) {
    for (const candidate of source) {
      if (!isRecord(candidate) || typeof candidate.key !== 'string') continue;
      const value = typeof candidate.value === 'string'
        ? interpolate(candidate.value, collectionVariables, suppliedVariables).value
        : '';
      fields.push({ name: candidate.key, value });
    }
  }
  return { type: auth.type, fields };
}

function requestHeaders(
  source: unknown,
  collectionVariables: Record<string, string>,
  suppliedVariables: Record<string, string>,
): ImportRequestField[] {
  return enabledFields(source, collectionVariables, suppliedVariables).fields;
}

function inferredRawMediaType(body: UnknownRecord): string | undefined {
  if (!isRecord(body.options) || !isRecord(body.options.raw) || typeof body.options.raw.language !== 'string') {
    return undefined;
  }
  const mediaTypes: Record<string, string> = {
    html: 'text/html',
    javascript: 'application/javascript',
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
  };
  return mediaTypes[body.options.raw.language.toLowerCase()];
}

function requestBodySummary(
  source: unknown,
  headers: ImportRequestField[],
): ImportRequestSummary['body'] {
  if (!isRecord(source) || source.mode !== 'raw' || typeof source.raw !== 'string') return undefined;
  const mediaType = headers.find(field => field.name.toLowerCase() === 'content-type')?.value
    ?? inferredRawMediaType(source);
  return {
    ...(mediaType === undefined ? {} : { mediaType }),
    byteCount: Buffer.byteLength(source.raw),
    omitted: true,
  };
}

function baseMember(item: unknown, context: TraversalContext): NormalizedImportMember {
  const location = { type: 'postman' as const, itemPath: [...context.itemPath] };
  const itemName = isRecord(item) && typeof item.name === 'string' && item.name.trim().length > 0
    ? item.name.trim()
    : `Postman request ${context.counters.requests}`;
  return {
    provisionalId: sha256Identity('import-member-v1', {
      sourceType: 'postman',
      location,
    }),
    location,
    breadcrumb: [...context.breadcrumb],
    name: itemName,
    disabled: isRecord(item) && item.disabled === true,
    supportedMethod: false,
    canonicalRequest: undefined,
    request: { query: [], headers: [] },
    responses: [],
    unresolvedVariables: [],
    warnings: [],
    errors: [],
  };
}

function responseError(code: string, text: string): ImportMessage {
  return message(code, text);
}

function normalizeResponseHeaders(
  source: unknown,
  responseWarnings: ImportMessage[],
  responseErrors: ImportMessage[],
): Record<string, string | string[]> {
  const grouped = new Map<string, string[]>();
  if (source === undefined) return {};
  if (!Array.isArray(source)) {
    addMessage(responseErrors, responseError(
      'IMPORT_RESPONSE_HEADER_INVALID',
      'A saved response contains invalid headers',
    ));
    return {};
  }

  for (const candidate of source) {
    if (!isRecord(candidate)) {
      addMessage(responseErrors, responseError(
        'IMPORT_RESPONSE_HEADER_INVALID',
        'A saved response contains an invalid header',
      ));
      continue;
    }
    if (candidate.disabled === true) continue;
    if (typeof candidate.key !== 'string' || typeof candidate.value !== 'string') {
      addMessage(responseErrors, responseError(
        'IMPORT_RESPONSE_HEADER_INVALID',
        'A saved response contains an invalid header',
      ));
      continue;
    }

    try {
      validateHeaderName(candidate.key);
      validateHeaderValue(candidate.key, candidate.value);
    } catch {
      addMessage(responseErrors, responseError(
        'IMPORT_RESPONSE_HEADER_INVALID',
        'A saved response contains an invalid header',
      ));
      continue;
    }

    const name = candidate.key.toLowerCase();
    if (DISCARDED_RESPONSE_HEADERS.has(name)) {
      responseWarnings.push(message(
        'IMPORT_RESPONSE_HEADER_DISCARDED',
        'A transport-managed saved response header was discarded',
      ));
      continue;
    }
    const values = grouped.get(name);
    if (values) values.push(candidate.value);
    else grouped.set(name, [candidate.value]);
  }

  return Object.fromEntries([...grouped].map(([name, values]) => [
    name,
    values.length === 1 ? values[0] : values,
  ]));
}

function normalizeResponse(source: unknown): NormalizedImportResponse {
  const response = isRecord(source) ? source : {};
  const warnings: ImportMessage[] = [];
  const errors: ImportMessage[] = [];
  if (!isRecord(source)) {
    addMessage(errors, responseError(
      'IMPORT_RESPONSE_INVALID',
      'A saved response is malformed',
    ));
  }

  const parsedStatus = AuthoredResponseStatusSchema.safeParse(response.code);
  const status = parsedStatus.success ? parsedStatus.data : 200;
  if (!parsedStatus.success) {
    addMessage(errors, responseError(
      'IMPORT_RESPONSE_STATUS_INVALID',
      'A saved response status must be an integer from 200 through 599',
    ));
  }

  const responseHeaders = normalizeResponseHeaders(response.header, warnings, errors);
  let body: Buffer | undefined;
  if (hasOwn(response, 'body')) {
    if (typeof response.body !== 'string') {
      addMessage(errors, responseError(
        'IMPORT_RESPONSE_BODY_INVALID',
        'A saved response body must be textual',
      ));
    } else if (Buffer.byteLength(response.body) > MAX_RESPONSE_BODY_BYTES) {
      addMessage(errors, responseError(
        'IMPORT_RESPONSE_BODY_TOO_LARGE',
        'A saved response body exceeds 10 MiB',
      ));
    } else {
      body = Buffer.from(response.body);
    }
  }

  const identityHeaders = Object.fromEntries(Object.entries(responseHeaders)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value : [value]]));
  const identity = sha256Identity('import-response-v1', {
    status,
    headers: identityHeaders,
    body: body === undefined
      ? { kind: 'none' }
      : { kind: 'sha256', value: sha256Bytes(body) },
  });

  return {
    name: typeof response.name === 'string' ? response.name.trim() : '',
    status,
    responseHeaders,
    ...(body === undefined ? {} : { body }),
    identity,
    warnings,
    errors,
  };
}

function normalizeResponses(item: UnknownRecord, member: NormalizedImportMember): void {
  if (!hasOwn(item, 'response')) return;
  if (!Array.isArray(item.response)) {
    addMessage(member.errors, responseError(
      'IMPORT_RESPONSE_INVALID',
      'The request saved responses are malformed',
    ));
    return;
  }

  member.responses = item.response.map(candidate => normalizeResponse(candidate));
  for (const response of member.responses) {
    for (const warning of response.warnings) member.warnings.push(warning);
    for (const error of response.errors) addMessage(member.errors, error);
  }
}

function malformedRequest(member: NormalizedImportMember): NormalizedImportMember {
  addMessage(member.errors, message(
    'IMPORT_REQUEST_INVALID',
    'The Postman request item is malformed',
  ));
  return member;
}

function normalizeRequest(item: unknown, context: TraversalContext): NormalizedImportMember {
  const member = baseMember(item, context);
  if (!isRecord(item)) return malformedRequest(member);

  const itemAuth = resolveAuth(item, context.inheritedAuth);
  if (eventsDeclared(item)) addMessage(member.warnings, scriptWarning('request', context.itemPath));
  normalizeResponses(item, member);
  if (!isRecord(item.request)) return malformedRequest(member);

  const request = item.request;
  if (eventsDeclared(request)) addMessage(member.warnings, scriptWarning('request', context.itemPath));
  member.disabled = member.disabled || request.disabled === true;
  const requestAuth = resolveAuth(request, itemAuth);
  if (typeof request.method !== 'string' || request.method.trim().length === 0 || !hasOwn(request, 'url')) {
    return malformedRequest(member);
  }

  const method = normalizeMethod(request.method);
  member.supportedMethod = SUPPORTED_METHODS.has(method);
  if (!member.supportedMethod) {
    addMessage(member.errors, message(
      'IMPORT_METHOD_UNSUPPORTED',
      'The Postman request method is not supported',
    ));
  }
  const requestDescription = description(request.description);
  if (requestDescription !== undefined) member.description = requestDescription;

  const headers = requestHeaders(
    request.header,
    context.collectionVariables,
    context.suppliedVariables,
  );
  const auth = authSummary(
    requestAuth,
    context.collectionVariables,
    context.suppliedVariables,
  );
  const body = requestBodySummary(request.body, headers);
  const prepared = prepareUrl(
    request.url,
    context.collectionVariables,
    context.suppliedVariables,
  );
  member.unresolvedVariables = prepared?.unresolved ?? [];
  if (prepared?.queryInvalid) {
    addMessage(member.errors, message(
      'IMPORT_QUERY_INVALID',
      'The Postman request query contains invalid encoding',
    ));
  }

  let parsedUrl: URL | undefined;
  if (prepared && member.unresolvedVariables.length === 0) {
    try {
      const candidate = new URL(prepared.text);
      if (!candidate.hostname) throw new TypeError('URL hostname is required');
      parsedUrl = candidate;
    } catch {
      addMessage(member.errors, message(
        'IMPORT_URL_INVALID',
        'The Postman request URL is invalid',
      ));
    }
  } else if (!prepared) {
    addMessage(member.errors, message(
      'IMPORT_URL_INVALID',
      'The Postman request URL is invalid',
    ));
  }

  const summary: ImportRequestSummary = {
    query: prepared?.query ?? (parsedUrl ? [...parsedUrl.searchParams].map(([name, value]) => ({
      name,
      value,
    })) : []),
    headers,
    ...(auth === undefined ? {} : { auth }),
    ...(body === undefined ? {} : { body }),
  };
  if (parsedUrl) {
    const origin = normalizeHttpOrigin(`${parsedUrl.protocol}//${parsedUrl.host}`);
    const sourcePort = prepared?.sourcePort;
    if (!prepared?.queryInvalid) {
      const query = exactQueryConstraints(prepared?.query ?? []);
      member.canonicalRequest = {
        baseUrl: origin.origin,
        matcher: {
          method,
          path: normalizePath(parsedUrl.pathname.replace(/(^|\/):[^/]+/g, '$1*')),
          ...(query === undefined ? {} : { query }),
        },
      };
    }
    summary.scheme = parsedUrl.protocol.slice(0, -1);
    summary.hostname = origin.hostname;
    if (sourcePort !== undefined) summary.port = sourcePort;
    if (parsedUrl.username || parsedUrl.password) summary.userInfo = '[PRESENT]';
  }
  member.request = redactRequestSummary(summary);
  return member;
}

function pushChildren(
  stack: TraversalEntry[],
  items: unknown[],
  context: Omit<TraversalContext, 'itemPath'>,
  parentPath: number[],
  traversedNodes: number,
): void {
  if (
    traversedNodes + stack.length + items.length > MAX_TRAVERSAL_NODES
    || (items.length > 0 && parentPath.length >= MAX_FOLDER_DEPTH)
  ) {
    throw sourceError(
      'IMPORT_LIMIT_EXCEEDED',
      'The Postman collection folder structure exceeds import traversal limits',
    );
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    stack.push({
      item: items[index],
      context: {
        ...context,
        itemPath: [...parentPath, index],
      },
    });
  }
}

export function parsePostmanSource(
  collection: unknown,
  variables: Record<string, string> = {},
): ParsedImportSource {
  if (
    !isRecord(collection)
    || !isRecord(collection.info)
    || collection.info.schema !== POSTMAN_V21_SCHEMA
    || !Array.isArray(collection.item)
  ) {
    throw sourceError('IMPORT_SOURCE_INVALID', 'The source is not a Postman v2.1 collection');
  }

  const warnings: ImportMessage[] = [];
  if (eventsDeclared(collection)) warnings.push(scriptWarning('collection'));
  const collectionVariables = collectVariables(collection);
  const suppliedVariables = collectSuppliedVariables(variables);
  const counters = { requests: 0, responses: 0 };
  let traversedNodes = 0;
  const inheritedAuth = resolveAuth(collection);
  const stack: TraversalEntry[] = [];
  pushChildren(stack, collection.item, {
    breadcrumb: [],
    inheritedAuth,
    collectionVariables,
    suppliedVariables,
    counters,
  }, [], traversedNodes);

  const members: NormalizedImportMember[] = [];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const { item, context } = entry;
    traversedNodes += 1;
    if (traversedNodes > MAX_TRAVERSAL_NODES || context.itemPath.length > MAX_FOLDER_DEPTH) {
      throw sourceError(
        'IMPORT_LIMIT_EXCEEDED',
        'The Postman collection folder structure exceeds import traversal limits',
      );
    }
    if (isRecord(item) && Array.isArray(item.item)) {
      if (eventsDeclared(item)) warnings.push(scriptWarning('folder', context.itemPath));
      const folderName = typeof item.name === 'string' && item.name.trim().length > 0
        ? item.name.trim()
        : 'Postman folder';
      pushChildren(stack, item.item, {
        breadcrumb: [...context.breadcrumb, folderName],
        inheritedAuth: resolveAuth(item, context.inheritedAuth),
        collectionVariables,
        suppliedVariables,
        counters,
      }, context.itemPath, traversedNodes);
      continue;
    }

    counters.requests += 1;
    if (counters.requests > MAX_REQUESTS) {
      throw sourceError(
        'IMPORT_LIMIT_EXCEEDED',
        'The Postman collection contains more than 1,000 request items',
      );
    }
    if (isRecord(item) && Array.isArray(item.response)) {
      counters.responses += item.response.length;
      if (counters.responses > MAX_RESPONSES) {
        throw sourceError(
          'IMPORT_LIMIT_EXCEEDED',
          'The Postman collection contains more than 5,000 saved responses',
        );
      }
    }
    members.push(normalizeRequest(item, context));
  }

  return { sourceType: 'postman', members, warnings };
}
