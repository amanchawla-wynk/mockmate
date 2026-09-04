# MockMate Import Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users preview, resolve, review, and atomically commit cURL or Postman imports while preserving multi-backend hostname matchers, saved response Variants, credentials only in redacted preview data, and every existing fallback and App State binding.

**Architecture:** Add a stateless import module that parses source data into normalized members, groups and plans deterministic preview items against one canonical Project snapshot, and authenticates the snapshot and plan with a process-local HMAC token. Keep publication behind two `ProjectRepository` methods; commit replays the source inside the per-Project queue, stages body bytes through a repository-private Body Store transaction, and switches one complete generation only after validation and compilation. The dashboard owns source and choices in one abort-aware wizard hook, renders Source/Resolve/Review/Complete steps in the shared `Modal`, and reloads canonical Endpoint and App State data after commit.

**Tech Stack:** TypeScript, Node.js crypto/HTTP/filesystem primitives, Express, Zod, React 19, Tailwind CSS, Vitest, Testing Library, Supertest, immutable generation storage.

## Global Constraints

- Preserve schema version 3. Do not add import fields to persisted `Project`, `EndpointDetail`, `ResponseVariant`, `AppState`, `BodyAsset`, or runtime-settings records.
- Preserve the current uncommitted Authoring Foundation as the implementation baseline, including repeated `ResponseHeaders`, stable IDs, optimistic revisions, atomic dependent deletion, shared `Modal`, and owner-safe Endpoint/App State refresh methods.
- Preserve scalar response-header compatibility and ordered repeated `string[]` values; independent `Set-Cookie` values must never be comma-joined or reordered.
- Canonical imported request identity is normalized method + normalized hostname + normalized matcher path. Scheme and port remain preview-only and do not enter matcher identity.
- Canonical imported request data is limited to method, optional hostname, and path. Query values, request headers, auth, cookies, request bodies, source text, variables, and provenance remain preview-only and are never persisted.
- Preserve runtime resolution order and existing fallback behavior. Import never changes an existing Endpoint fallback, App State binding/revision, Project display field/revision, workspace selection, or runtime setting, and never adds a discovered host to `interceptHosts`.
- A new Endpoint starts at revision 0, each new Variant starts at revision 0, and its first candidate Variant is fallback. A request with no saved response gets `Default`, status 200, no response headers, no body, and no delay.
- A merged Endpoint increments its revision exactly once when at least one distinct Variant is added. Existing Variant IDs/revisions and the existing fallback remain unchanged.
- Imported body bytes use immutable `application/octet-stream` Body Asset metadata. A preserved Variant `Content-Type` is authoritative during delivery; Body Asset media metadata is only the fallback when the Variant has no `Content-Type`.
- The complete HTTP request limit remains 12 MiB. Serialized `source` is limited to 10 MiB; variables, token, selections, and actions together are limited to 1 MiB. Each UTF-8 saved response body is limited to 10 MiB.
- One preview traverses at most 1,000 request items and 5,000 saved responses, counting disabled, malformed, and later-collapsed entries.
- cURL parsing is tokenization only. Never execute a shell, expand an environment variable, run command substitution, read a file, perform network access, or accept file/form upload syntax.
- Accept exactly one Postman Collection v2.1 object per preview. Do not import Postman environments, globals, events, scripts, tests, pre-request scripts, or file-backed/binary response examples.
- Preview and commit are stateless. Raw source and plaintext variable values are not logged, persisted, or embedded in the snapshot token. A server restart invalidates open previews.
- The dashboard never predicts canonical IDs or revisions and never auto-selects an imported Endpoint. After a successful commit, or a transport/response failure whose publication outcome is unknown, it reloads Endpoint summaries, App State summaries, and selected App State detail when present.
- Use strict RED/GREEN: every production behavior follows a focused test that failed for the expected reason.
- Preserve unrelated worktree changes. Never overwrite or revert the current uncommitted Authoring Foundation, and never stage `.superpowers/`, `graphify-out/`, generated output, lockfiles, or unrelated files.
- Every commit step is a checkpoint, not permission to commit. Only with explicit user authorization.
- After TypeScript or JavaScript changes, run `graphify update .` only at the final metadata gate and do not stage generated graph output.

---

### Task 1: Import Contracts, Secret Redaction, And Deterministic Hashing

**Files:**
- Create: `packages/server/src/import/contracts.ts`
- Create: `packages/server/src/import/security.ts`
- Create: `packages/server/src/import/security.test.ts`

**Interfaces:**
- Consumes: schema-v3 `EndpointDetail['matcher']`, `ResponseHeaders`, Node `createHash`, `createHmac`, and `timingSafeEqual`.
- Produces: the exact server-side `ImportPreviewRequest`, `ImportPreview`, `ImportPreviewItem`, `ImportCommitRequest`, `ImportCommitResult`, normalized parser member/response types, `canonicalJson(value)`, `sha256Identity(namespace, value)`, `sha256Bytes(bytes)`, `digestVariables(variables, key)`, and `redactRequestSummary(summary)` used by Tasks 2-7.

- [ ] **Step 1: Add failing deterministic-hash and redaction tests**

Create `packages/server/src/import/security.test.ts` with exact coverage for stable object ordering, ordered arrays, no-body versus empty-body identity, and masked request secrets:

```ts
import { describe, expect, it } from 'vitest';

import type { ImportRequestSummary } from './contracts';
import {
  canonicalJson,
  digestVariables,
  redactRequestSummary,
  sha256Bytes,
  sha256Identity,
} from './security';

describe('import security primitives', () => {
  it('sorts object keys while preserving array order', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: 'value' } })).toBe(
      '{"a":{"x":"value","y":true},"z":[2,1]}',
    );
  });

  it('uses versioned namespaces and distinguishes no body from empty bytes', () => {
    expect(sha256Identity('import-response-v1', { body: { kind: 'none' } }))
      .not.toBe(sha256Identity('import-response-v1', {
        body: { kind: 'sha256', value: sha256Bytes(Buffer.alloc(0)) },
      }));
  });

  it('keys variable digests and never returns plaintext values', () => {
    const first = digestVariables({ token: 'secret-token', host: 'api.example.test' }, Buffer.alloc(32, 1));
    const second = digestVariables({ host: 'api.example.test', token: 'secret-token' }, Buffer.alloc(32, 1));
    expect(first).toBe(second);
    expect(first).not.toContain('secret-token');
    expect(first).not.toBe(digestVariables({ token: 'secret-token', host: 'api.example.test' }, Buffer.alloc(32, 2)));
  });

  it('masks credential headers, sensitive names, URL user information, auth, and body content', () => {
    const summary: ImportRequestSummary = {
      scheme: 'https',
      hostname: 'api.example.test',
      port: '8443',
      userInfo: 'mobile:password',
      query: [
        { name: 'page', value: '2' },
        { name: 'apiKey', value: 'query-secret' },
      ],
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer header-secret' },
        { name: 'X-Session-Token', value: 'session-secret' },
      ],
      auth: { type: 'bearer', fields: [{ name: 'token', value: 'postman-secret' }] },
      body: { mediaType: 'application/json', byteCount: 31, omitted: true },
    };

    const redacted = redactRequestSummary(summary);
    expect(redacted).toMatchObject({
      userInfo: '[REDACTED]',
      query: [
        { name: 'page', value: '2' },
        { name: 'apiKey', value: '[REDACTED]' },
      ],
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: '[REDACTED]' },
        { name: 'X-Session-Token', value: '[REDACTED]' },
      ],
      auth: { type: 'bearer', fields: [{ name: 'token', value: '[REDACTED]' }] },
      body: { mediaType: 'application/json', byteCount: 31, omitted: true },
    });
    expect(JSON.stringify(redacted)).not.toMatch(/password|header-secret|query-secret|session-secret|postman-secret/);
  });
});
```

- [ ] **Step 2: Run the security test and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run src/import/security.test.ts
```

Expected: FAIL because `src/import/contracts.ts` and `src/import/security.ts` do not exist.

- [ ] **Step 3: Define the complete public and normalized contracts**

Create `packages/server/src/import/contracts.ts`. Keep these names and discriminants exact so server, repository, and dashboard mirrors stay type-consistent:

```ts
import type { EndpointDetail, ResponseHeaders } from '../domain/model';

export type ImportSourceType = 'curl' | 'postman';
export type ImportSource =
  | { type: 'curl'; text: string }
  | { type: 'postman'; collection: unknown };

export interface ImportPreviewRequest {
  source: ImportSource;
  variables?: Record<string, string>;
}

export type ImportActionName = 'create' | 'merge' | 'skip';
export type ImportAction =
  | { itemId: string; action: 'create'; confirmOverlap?: boolean }
  | { itemId: string; action: 'merge'; endpointId: string }
  | { itemId: string; action: 'skip' };

export interface ImportCommitRequest extends ImportPreviewRequest {
  snapshotToken: string;
  selectedItemIds: string[];
  actions: ImportAction[];
}

export type ImportSourceLocation =
  | { type: 'curl'; commandIndex: number }
  | { type: 'postman'; itemPath: number[] };

export interface ImportMessage {
  code: string;
  message: string;
  memberId?: string;
}

export interface ImportRequestField {
  name: string;
  value: string;
}

export interface ImportRequestSummary {
  scheme?: string;
  hostname?: string;
  port?: string;
  userInfo?: string;
  query: ImportRequestField[];
  headers: ImportRequestField[];
  auth?: { type: string; fields: ImportRequestField[] };
  body?: { mediaType?: string; byteCount: number; omitted: true };
}

export interface ImportResponseSummary {
  name: string;
  status: number;
  responseHeaders: ResponseHeaders;
  body: { kind: 'none' } | { kind: 'sha256'; sha256: string; byteCount: number };
  identity: string;
}

export interface ImportExactTarget {
  endpointId: string;
  endpointRevision: number;
  name: string;
  newVariantCount: number;
  candidateResponses: ImportResponseSummary[];
}

export interface ImportOverlap {
  endpointId?: string;
  itemId?: string;
  matcher: Pick<EndpointDetail['matcher'], 'method' | 'host' | 'path'>;
  relativeSpecificity: 'more-specific' | 'less-specific' | 'equal';
  confirmationRequired: boolean;
}

export interface ImportPreviewItem {
  id: string;
  memberIds: string[];
  locations: ImportSourceLocation[];
  breadcrumbs: string[][];
  name: string;
  description?: string;
  matcher: Pick<EndpointDetail['matcher'], 'method' | 'host' | 'path'>;
  requests: ImportRequestSummary[];
  responses: ImportResponseSummary[];
  proposedAction: ImportActionName;
  allowedActions: ImportActionName[];
  exactTargets: ImportExactTarget[];
  overlaps: ImportOverlap[];
  warnings: ImportMessage[];
  errors: ImportMessage[];
  selectedByDefault: boolean;
  createEffect: { createsEndpoint: boolean; createsVariants: number };
}

export interface ImportUnresolvedMember {
  id: string;
  location: ImportSourceLocation;
  breadcrumb: string[];
  name: string;
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface ImportVariableRequirement {
  name: string;
  memberIds: string[];
}

export interface ImportPreview {
  snapshotToken: string;
  sourceType: ImportSourceType;
  items: ImportPreviewItem[];
  unresolvedMembers: ImportUnresolvedMember[];
  unresolvedVariables: ImportVariableRequirement[];
  warnings: ImportMessage[];
  discoveredHosts: string[];
  affectedStates: Array<{ id: string; name: string }>;
  summary: { valid: number; invalid: number; create: number; merge: number; skip: number };
}

export type ImportPreviewData = Omit<ImportPreview, 'snapshotToken'>;

export interface ImportCommitResult {
  createdEndpointIds: string[];
  updatedEndpointIds: string[];
  createdVariantIds: string[];
  skippedItemIds: string[];
}

export interface NormalizedImportResponse {
  name: string;
  status: number;
  responseHeaders: ResponseHeaders;
  body?: Buffer;
  identity: string;
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface PlannedImportResponse {
  summary: ImportResponseSummary;
  body?: Buffer;
}

export interface PlannedImportItem {
  preview: ImportPreviewItem;
  createResponses: PlannedImportResponse[];
  mergeResponsesByEndpointId: ReadonlyMap<string, PlannedImportResponse[]>;
}

export interface ImportPlan {
  preview: ImportPreviewData;
  items: PlannedImportItem[];
}

export interface NormalizedImportMember {
  provisionalId: string;
  location: ImportSourceLocation;
  breadcrumb: string[];
  name: string;
  description?: string;
  disabled: boolean;
  supportedMethod: boolean;
  matcher?: Pick<EndpointDetail['matcher'], 'method' | 'host' | 'path'>;
  request: ImportRequestSummary;
  responses: NormalizedImportResponse[];
  unresolvedVariables: string[];
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface ParsedImportSource {
  sourceType: ImportSourceType;
  members: NormalizedImportMember[];
  warnings: ImportMessage[];
}
```

`NormalizedImportResponse.body === undefined` means no body. `Buffer.alloc(0)` means an explicitly present empty body. Never collapse those states.

`ImportPlan` is repository-private: `preview` is safe to serialize, while `createResponses` and `mergeResponsesByEndpointId` retain replayed bytes only for the duration of one preview call or queued commit. Never return an `ImportPlan` from an HTTP route or retain it between requests.

- [ ] **Step 4: Implement canonical serialization, versioned hashes, and redaction**

Create `packages/server/src/import/security.ts` with recursive object-key sorting, array-order preservation, keyed variable hashing, and one redaction predicate:

```ts
import { createHash, createHmac } from 'node:crypto';

import type { ImportRequestSummary } from './contracts';

const REDACTED = '[REDACTED]';
const SECRET_NAME = /(token|secret|password|key|credential|session|auth)/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
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
  return {
    ...structuredClone(summary),
    ...(summary.userInfo === undefined ? {} : { userInfo: REDACTED }),
    query: summary.query.map(field => ({
      ...field,
      value: SECRET_NAME.test(field.name) ? REDACTED : field.value,
    })),
    headers: summary.headers.map(field => ({
      ...field,
      value: SECRET_HEADER.test(field.name) || SECRET_NAME.test(field.name) ? REDACTED : field.value,
    })),
    ...(summary.auth === undefined ? {} : {
      auth: {
        type: summary.auth.type,
        fields: summary.auth.fields.map(field => ({ ...field, value: REDACTED })),
      },
    }),
  };
}
```

Parsers must call `redactRequestSummary()` before placing a request summary in `ParsedImportSource`; unredacted summaries must not cross the parser interface. Test canonical serialization with non-ASCII object keys so hash order is independent of process locale and ICU data.

- [ ] **Step 5: Run the security test and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run src/import/security.test.ts
```

Expected: PASS with stable hashes, distinct no-body/empty-body identities, keyed variable digests, and no raw credential value in serialized redacted summaries.

- [ ] **Step 6: Commit contracts and security checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/import/contracts.ts \
  packages/server/src/import/security.ts \
  packages/server/src/import/security.test.ts
git commit -m "feat: define secure import preview contracts"
```

### Task 2: Shell-Aware cURL Parser

**Files:**
- Create: `packages/server/src/import/curl-parser.ts`
- Create: `packages/server/src/import/curl-parser.test.ts`
- Verify unchanged until Task 7 cutover: `packages/server/src/utils/curl-parser.ts`

**Interfaces:**
- Consumes: `ParsedImportSource`, `NormalizedImportMember`, `ImportSourceLocation`, `sha256Identity()`, `redactRequestSummary()`, the 1,000-request limit, and runtime `normalizeMethod/normalizeHost/normalizePath` from `compile-project.ts`.
- Produces: `parseCurlSource(text: string): ParsedImportSource`, with enumerable command-level errors, zero shell execution, command indexes after shell-aware splitting, normalized hostname/path matchers, preview-only request fields, and no response examples.

- [ ] **Step 1: Add failing tokenizer and supported-command tests**

Create `packages/server/src/import/curl-parser.test.ts` and cover quoted/unquoted `--url`, continuations, separators, quoted separator text, explicit methods, and data-implied POST:

```ts
import { describe, expect, it } from 'vitest';

import { parseCurlSource } from './curl-parser';

describe('parseCurlSource', () => {
  it('enumerates shell-aware commands without executing shell syntax', () => {
    const parsed = parseCurlSource(String.raw`curl --url https://api.one.test/users?token=secret \
      -H 'Authorization: Bearer hidden' ;
      curl "https://api.two.test/note;still-one" -H "X-Label: curl && safe" &&
      curl https://api.three.test/items --data-raw '{"name":"Ada"}'`);

    expect(parsed.members.map(member => member.location)).toEqual([
      { type: 'curl', commandIndex: 0 },
      { type: 'curl', commandIndex: 1 },
      { type: 'curl', commandIndex: 2 },
    ]);
    expect(parsed.members.map(member => member.matcher)).toEqual([
      { method: 'GET', host: 'api.one.test', path: '/users' },
      { method: 'GET', host: 'api.two.test', path: '/note;still-one' },
      { method: 'POST', host: 'api.three.test', path: '/items' },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/secret|Bearer hidden/);
    expect(parsed.members[2]?.request.body).toEqual({
      mediaType: undefined,
      byteCount: Buffer.byteLength('{"name":"Ada"}'),
      omitted: true,
    });
  });

  it.each([
    ['-X', "curl -X PATCH 'https://api.example.test/items/1'"],
    ['--request', "curl --request DELETE 'https://api.example.test/items/1'"],
    ['literal --data-binary', "curl 'https://api.example.test/items' --data-binary 'plain bytes'"],
  ])('supports %s', (_name, source) => {
    expect(parseCurlSource(source).members[0]?.errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Add failing safety and enumerable-error tests**

Add table cases asserting each unsafe command remains visible with its command index and exact error code:

```ts
it.each([
  ['backticks', "curl 'https://api.test/`whoami`'", 'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED'],
  ['$()', "curl 'https://api.test/$(whoami)'", 'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED'],
  ['dynamic URL', 'curl https://$HOST/items', 'CURL_DYNAMIC_URL_UNSUPPORTED'],
  ['short file body', "curl https://api.test/items -d '@payload.bin'", 'CURL_FILE_BODY_UNSUPPORTED'],
  ['long file body', "curl https://api.test/items --data '@payload.bin'", 'CURL_FILE_BODY_UNSUPPORTED'],
  ['binary file body', "curl https://api.test/items --data-binary '@payload.bin'", 'CURL_FILE_BODY_UNSUPPORTED'],
  ['short form upload', "curl https://api.test/items -F 'file=@payload.bin'", 'CURL_FORM_UNSUPPORTED'],
  ['long form upload', "curl https://api.test/items --form 'file=@payload.bin'", 'CURL_FORM_UNSUPPORTED'],
  ['short upload file', "curl https://api.test/items -T payload.bin", 'CURL_FILE_BODY_UNSUPPORTED'],
  ['long upload file', "curl https://api.test/items --upload-file payload.bin", 'CURL_FILE_BODY_UNSUPPORTED'],
  ['unsupported option operand', "curl --proxy http://proxy.test https://api.test/items", 'CURL_OPTION_UNSUPPORTED'],
  ['pipe', 'curl https://api.test/items | jq .', 'CURL_SHELL_SYNTAX_UNSUPPORTED'],
])('reports %s as an item error', (_name, source, code) => {
  const member = parseCurlSource(source).members[0];
  expect(member).toMatchObject({
    location: { type: 'curl', commandIndex: 0 },
    errors: [expect.objectContaining({ code })],
  });
});

it('keeps a leading @ literal for --data-raw', () => {
  expect(parseCurlSource("curl https://api.test/items --data-raw '@literal'")
    .members[0]?.errors).toEqual([]);
});

it('keeps non-curl groups visible when at least one curl group is enumerable', () => {
  const parsed = parseCurlSource('echo unsafe; curl https://api.test/items');
  expect(parsed.members[0]).toMatchObject({
    location: { type: 'curl', commandIndex: 0 },
    errors: [expect.objectContaining({ code: 'CURL_COMMAND_UNSUPPORTED' })],
  });
  expect(parsed.members[1]).toMatchObject({
    location: { type: 'curl', commandIndex: 1 },
    matcher: { method: 'GET', host: 'api.test', path: '/items' },
  });
});

it('keeps unsupported methods visible and uncommittable', () => {
  const member = parseCurlSource("curl -X OPTIONS 'https://api.example.test/items'").members[0];
  expect(member).toMatchObject({
    supportedMethod: false,
    matcher: { method: 'OPTIONS', host: 'api.example.test', path: '/items' },
    errors: [expect.objectContaining({ code: 'IMPORT_METHOD_UNSUPPORTED' })],
  });
});
```

Also assert unbalanced quotes or input with no enumerable `curl` command throws `HttpError` status 422/code `IMPORT_SOURCE_INVALID`; malformed URLs and missing URLs remain member errors when command boundaries are enumerable. Build 1,001 shell-separated groups, including malformed and non-`curl` groups among them, and assert `IMPORT_LIMIT_EXCEEDED` before command filtering or collapse.

- [ ] **Step 3: Run the cURL parser test and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run src/import/curl-parser.test.ts
```

Expected: FAIL because the current regex parser cannot tokenize unquoted URLs or separators safely, leaks request values, and has no enumerable item-error model.

- [ ] **Step 4: Implement a state-machine tokenizer and command splitter**

In `packages/server/src/import/curl-parser.ts`, keep shell behavior deliberately small:

```ts
type Quote = 'single' | 'double' | undefined;

interface CurlToken {
  value: string;
  quoted: boolean;
}

interface TokenizedCommand {
  commandIndex: number;
  tokens: CurlToken[];
  errors: ImportMessage[];
}

function tokenizeCommands(text: string): TokenizedCommand[] {
  const commands: TokenizedCommand[] = [];
  let tokens: CurlToken[] = [];
  let value = '';
  let quote: Quote;
  let escaped = false;
  let tokenQuoted = false;
  // Scan one character at a time. Consume backslash-newline as whitespace;
  // split on newline, `;`, or `&&` only outside quotes; reject `|`, `||`,
  // redirection, backticks, and `$(` without evaluating them.
  // Flush every nonempty command group; classification happens after counting.
  return commands;
}
```

Implement the stated transitions rather than regular-expression splitting:

- single quotes preserve every character until the next single quote;
- double quotes preserve ordinary characters and allow backslash escaping without expansion;
- outside quotes, backslash escapes the next ordinary character and backslash-newline is removed;
- newline, `;`, and `&&` flush a command only outside quotes;
- an unmatched quote makes the complete source structurally unenumerable;
- `|`, `||`, `<`, `>`, backticks, and `$(` add the documented command error and are never executed;
- nonempty command groups not beginning with `curl` count toward the request limit and, when at least one `curl` group exists, remain visible as enumerable command errors rather than being passed to a shell.

Reject at 1,001 tokenized nonempty groups with `IMPORT_LIMIT_EXCEEDED` before classifying, filtering, or collapsing them. If no group begins with case-insensitive `curl`, retain the source-level `IMPORT_SOURCE_INVALID` behavior. Do not add a shell-tokenizer dependency.

- [ ] **Step 5: Normalize flags into preview-only members**

Parse `-X`/`--request`, `-H`/`--header`, `-d`/`--data`/`--data-raw`/literal `--data-binary`, and `--url`; choose the first positional URL otherwise. Reject `-F`/`--form` and `-T`/`--upload-file` before any file access. Any unsupported option produces `CURL_OPTION_UNSUPPORTED`; use a small explicit arity table for rejected common options such as `--proxy` so their operands can never be mistaken for the request URL, and do not attempt positional URL inference after an option with unknown arity. Use this exact member construction:

```ts
const sourcePort = extractExplicitSourcePort(urlToken.value);
const url = new URL(urlToken.value);
const method = normalizeMethod(explicitMethod ?? (dataTokens.length > 0 ? 'POST' : 'GET'));
const provisionalId = sha256Identity('import-member-v1', {
  sourceType: 'curl',
  location: { type: 'curl', commandIndex },
});
const request = redactRequestSummary({
  scheme: url.protocol.slice(0, -1),
  hostname: normalizeHost(url.hostname),
  ...(sourcePort ? { port: sourcePort } : {}),
  ...(url.username || url.password ? { userInfo: '[PRESENT]' } : {}),
  query: [...url.searchParams].map(([name, value]) => ({ name, value })),
  headers,
  ...(bodyBytes === undefined ? {} : {
    body: {
      mediaType: headers.find(field => field.name.toLowerCase() === 'content-type')?.value,
      byteCount: bodyBytes.length,
      omitted: true,
    },
  }),
});
```

Set `matcher` to `{ method, host: normalizeHost(url.hostname), path: normalizePath(url.pathname) }`. Capture an explicitly written authority port before WHATWG URL normalization so default `:80` and `:443` values remain visible; support bracketed IPv6 without confusing its colons for a port. Add `IMPORT_SCHEME_PORT_DISCARDED` for every valid URL because scheme is never canonical; include the lexical source port in the message when present. Preserve scheme/port only in the request summary. A user-info presence marker is sufficient because redaction occurs immediately; do not decode secret user information. Preserve duplicate request headers as ordered fields. Leave parser output as `responses: []`; Task 4 adds the previewed empty status-200 fallback only when planning a create. Add assertions for explicit default ports and malformed percent escapes in user information.

- [ ] **Step 6: Run the cURL parser test and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run src/import/curl-parser.test.ts
```

Expected: PASS for quoted/unquoted URLs, `--url`, continuations, separators, quoted separator text, methods, data flags, command indexes/count limits, preview redaction, and every blocked shell/file/network construct.

- [ ] **Step 7: Commit cURL parser checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/import/curl-parser.ts \
  packages/server/src/import/curl-parser.test.ts
git commit -m "feat: parse curl imports without shell execution"
```

### Task 3: Postman Parsing And Saved-Response Normalization

**Files:**
- Create: `packages/server/src/import/postman-parser.ts`
- Create: `packages/server/src/import/postman-parser.test.ts`
- Verify unchanged until Task 7 cutover: `packages/server/src/utils/postman-parser.ts`

**Interfaces:**
- Consumes: Task 1 contracts/security, runtime matcher normalizers, Node `validateHeaderName/validateHeaderValue`, and the 1,000-request/5,000-response/10-MiB limits.
- Produces: `parsePostmanSource(collection: unknown, variables?: Record<string, string>): ParsedImportSource`, depth-first structural locations, collection/folder/request auth inheritance, unresolved variable requirements, normalized saved responses, and response-content identities used by Task 4.

- [ ] **Step 1: Add failing traversal, variables, auth, and URL tests**

Create a v2.1 collection fixture with collection variables, nested folders, one supplied variable, string/object descriptions, structured and string URLs, explicit default ports, disabled query/header entries, inherited auth, `:id`, and unresolved `{{tenant}}`. Assert:

```ts
const parsed = parsePostmanSource(collection, { region: 'eu' });

expect(parsed.members.map(member => member.location)).toEqual([
  { type: 'postman', itemPath: [0, 0] },
  { type: 'postman', itemPath: [0, 1, 0] },
]);
expect(parsed.members[0]).toMatchObject({
  name: 'Get account',
  description: 'Returns one account',
  breadcrumb: ['Accounts'],
  matcher: { method: 'GET', host: 'eu.api.example.test', path: '/accounts/*' },
  unresolvedVariables: [],
});
expect(parsed.members[1]).toMatchObject({
  matcher: undefined,
  unresolvedVariables: ['tenant'],
});
expect(JSON.stringify(parsed)).not.toMatch(/collection-secret|request-secret/);
```

Assert collection variables apply before supplied values, supplied values fill only still-unresolved names, `{{variable}}` is never converted to `*`, and a complete path-segment variable remains required until supplied. Assert collection/folder event declarations produce sanitized `parsed.warnings`, request events produce member warnings, and an otherwise empty collection still returns its collection-script warning.

- [ ] **Step 2: Add failing response normalization and limit tests**

Use two saved responses with repeated mixed-case `Set-Cookie`, `Content-Type`, bodyless `Content-Type`, hop-by-hop fields, blank names, explicit empty body, and no body. Assert:

```ts
expect(member.responses.map(response => ({
  name: response.name,
  status: response.status,
  headers: response.responseHeaders,
  bodySize: response.body?.length,
}))).toEqual([
  {
    name: '',
    status: 201,
    headers: {
      'content-type': 'application/vnd.example+json; profile=mobile',
      'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
    },
    bodySize: 0,
  },
  {
    name: 'Bodyless',
    status: 204,
    headers: { 'content-type': 'text/plain' },
    bodySize: undefined,
  },
]);
expect(member.warnings).toEqual(expect.arrayContaining([
  expect.objectContaining({ code: 'IMPORT_RESPONSE_HEADER_DISCARDED' }),
]));
expect(member.responses[0]?.identity).not.toBe(member.responses[1]?.identity);
```

Add exact invalid-item cases for status below 100/above 599, invalid Node header names/values, non-textual response bodies, UTF-8 bodies over 10 MiB, and malformed request items. Add collection-level `IMPORT_LIMIT_EXCEEDED` cases at 1,001 traversed items and 5,001 traversed saved responses; disabled and malformed entries must count.

- [ ] **Step 3: Run the Postman parser test and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run src/import/postman-parser.test.ts
```

Expected: FAIL because the current parser defaults unsupported methods to GET, drops host and responses, rewrites variables incorrectly, has no auth inheritance/redaction, and does not enforce semantic limits.

- [ ] **Step 4: Validate and traverse one v2.1 collection as data**

In `postman-parser.ts`, validate `info.schema` as the v2.1 collection schema URL and require `item` to be an array. A missing/invalid root throws `HttpError(422, 'IMPORT_SOURCE_INVALID', ...)`; count overflow throws `HttpError(422, 'IMPORT_LIMIT_EXCEEDED', ...)`.

Traverse depth-first in array order with this internal context:

```ts
interface TraversalContext {
  itemPath: number[];
  breadcrumb: string[];
  inheritedAuth?: PostmanAuth;
  collectionVariables: Record<string, string>;
  suppliedVariables: Record<string, string>;
  counters: { requests: number; responses: number };
}
```

Resolve auth with property-presence checks rather than `??`: an absent override inherits, while an explicitly present `null` or `{ type: 'noauth' }` returns no auth. Apply this helper when initializing collection context, entering a folder, resolving item-level auth, and resolving request-level auth. Add tests for inheritance and clearing through `null` and `noauth` at collection, folder, item, and request levels. Ignore events/scripts with one `IMPORT_SCRIPT_IGNORED` warning per containing collection/folder/request that declares them. Collection/folder warnings go to `ParsedImportSource.warnings` with sanitized context and therefore survive even when the collection has no request items; request warnings go to the containing member.

- [ ] **Step 5: Resolve URLs and produce redacted request summaries**

Resolve every `{{name}}` in URL text by checking collection values first and supplied values second. Do not interpolate unresolved names. When structured `url.query` metadata exists, strip the raw query and rebuild it from enabled entries even when `raw` exists, so disabled entries never participate in variable requirements or preview data. Use the raw query only when query metadata is absent. Build a URL from structured `protocol`, `host`, optional `port`, and `path` when `raw` is absent. After complete interpolation:

```ts
const parsedUrl = new URL(resolvedUrl);
const matcher = {
  method: normalizeMethod(request.method),
  host: normalizeHost(parsedUrl.hostname),
  path: normalizePath(parsedUrl.pathname.replace(/(^|\/)\:[^/]+/g, '$1*')),
};
```

Until every URL variable is resolved or URL parsing succeeds, leave `matcher` undefined and retain the provisional member ID. Disabled items set `disabled: true`, add no parser error, and later default unselected. Unsupported methods retain their normalized method plus `IMPORT_METHOD_UNSUPPORTED`.

Normalize a request's Postman string or object description into `member.description`. Represent auth as ordered fields and run the complete request summary through `redactRequestSummary()`. Include source scheme, normalized hostname, optional lexical/structured port, URL user-information presence, enabled query entries, and enabled request headers before redaction. Capture explicit default ports before WHATWG normalization and test raw `:80`/`:443` plus structured ports. Add `IMPORT_SCHEME_PORT_DISCARDED` for every valid URL because scheme is preview-only, including the source port in the warning when present. Request body preview contains only media type and `Buffer.byteLength()`; never return body text.

- [ ] **Step 6: Normalize saved responses and compute identity**

Use these exact discarded response names:

```ts
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
```

Validate every source header with Node validators before filtering. Group remaining names case-insensitively in first-seen order, lowercase the stored key, preserve value order, and emit a scalar for one value or `string[]` for repeated values. Preserve valid `Content-Type` verbatim even without a body.

Compute identity after filtering:

```ts
const identityHeaders = Object.fromEntries(Object.entries(responseHeaders)
  .sort(([left], [right]) => compareCodeUnits(left, right))
  .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value : [value]]));
const identity = sha256Identity('import-response-v1', {
  status,
  headers: identityHeaders,
  body: body === undefined ? { kind: 'none' } : { kind: 'sha256', value: sha256Bytes(body) },
});
```

Trim response names; assign `Response N` later in collapsed response order in Task 4 so numbering remains correct after source grouping. A response error is copied to the containing member, making its eventual collapsed item invalid.

- [ ] **Step 7: Run the Postman parser test and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run src/import/postman-parser.test.ts
```

Expected: PASS for v2.1 validation, depth-first locations, breadcrumbs, defaults/supplied variables, string/structured URLs, colon parameters, disabled fields/items, auth inheritance/redaction, script warnings, statuses, repeated headers, filtering, body distinctions, and every count/byte limit.

- [ ] **Step 8: Commit Postman parser checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/import/postman-parser.ts \
  packages/server/src/import/postman-parser.test.ts
git commit -m "feat: normalize postman import previews"
```

### Task 4: Matcher Conflict Planner And HMAC Snapshot Token

**Files:**
- Modify: `packages/server/src/repository/compile-project.ts:139-243`
- Modify: `packages/server/src/repository/compile-project.test.ts`
- Create: `packages/server/src/import/planner.ts`
- Create: `packages/server/src/import/planner.test.ts`
- Create: `packages/server/src/import/snapshot-token.ts`
- Create: `packages/server/src/import/snapshot-token.test.ts`

**Interfaces:**
- Consumes: `ValidatedProjectSnapshot`, parsed members from Tasks 2-3, runtime normalizers/rank, response identity, canonical hashing, and keyed variable digest.
- Produces: `matcherIdentity(matcher)`, `matcherSpecificity(matcher)`, `matchersMayOverlap(left, right)`, `buildImportPlan(snapshot, parsed, variablesDigest): ImportPlan`, `canonicalImportDigest(snapshot)`, `importPlanDigest(plan.preview, variablesDigest)`, and `createImportSnapshotTokenCodec(key?)`.

- [ ] **Step 1: Add failing shared-rank and conservative-overlap tests**

Extend `compile-project.test.ts` to assert exported rank values sort identically to runtime matching for hostless, host-specific, wildcard-host, exact-path, and wildcard-path matchers. In `planner.test.ts`, assert methods must match and both host/path dimensions must overlap:

```ts
expect(matchersMayOverlap(
  { method: 'GET', path: '/users/*' },
  { method: 'GET', host: 'api.example.test', path: '/users/42' },
)).toBe(true);
expect(matchersMayOverlap(
  { method: 'POST', path: '/users/*' },
  { method: 'GET', path: '/users/42' },
)).toBe(false);
expect(matchersMayOverlap(
  { method: 'GET', host: '*.example.test', path: '/v1/*' },
  { method: 'GET', host: 'api.other.test', path: '/v2/*' },
)).toBe(true);
```

The last case deliberately proves conservative wildcard-versus-wildcard review even when actual languages may be disjoint.

- [ ] **Step 2: Add failing grouping, duplicate, and naming tests**

Build parsed fixtures with equal method/host/path across multiple source locations and assert:

- one versioned item ID contains the ordered complete location list;
- provisional unresolved IDs do not appear in `items` and become a final grouped ID after variable resolution;
- first member name/description wins while all locations/breadcrumbs remain;
- saved responses combine in source order;
- duplicate saved response content remains duplicated for a new Endpoint while colliding names receive deterministic suffixes;
- exact existing matcher returns all legacy exact targets and forbids `create`;
- legacy exact targets can have different `newVariantCount` values for the same source item;
- example-free cURL exact matches and all-identical merge candidates propose `skip`;
- an example-free cURL create has one previewed `Default` status-200/no-header/no-body response, `createEffect.createsVariants === 1`, and the same response in `createResponses`; an exact merge remains a no-op and receives no synthetic candidate;
- merge candidates skip existing/earlier equal identities and suffix case-insensitive name collisions as `Name (2)`, `Name (3)`;
- equal-specificity overlap proposes `create`, stays selected, and requires confirmation;
- a host-specific matcher beside a hostless matcher is allowed without confirmation because it is more constrained;
- relative specificity includes the existing matcher's query/header total and exact counts, while imported candidates contribute zero query/header constraints;
- `affectedStates` is all current states only when at least one item proposes a new Endpoint.

Core assertions:

```ts
expect(plan.items[0]).toMatchObject({
  preview: {
    locations: [
      { type: 'postman', itemPath: [0] },
      { type: 'postman', itemPath: [1] },
    ],
    breadcrumbs: [[], []],
    proposedAction: 'create',
    allowedActions: ['create', 'skip'],
    selectedByDefault: true,
    createEffect: { createsEndpoint: true, createsVariants: 2 },
  },
});
expect(plan.items[0]?.createResponses.map(response => response.summary.name)).toEqual(['OK', 'OK (2)']);
```

- [ ] **Step 3: Add failing token authentication and digest tests**

In `snapshot-token.test.ts`, use fixed 32-byte keys and assert:

```ts
const codec = createImportSnapshotTokenCodec(Buffer.alloc(32, 7));
const token = codec.issue({
  projectId: 'prj_1',
  sourceType: 'postman',
  canonicalDigest: 'canonical-a',
  planDigest: 'plan-a',
});
expect(codec.verify(token)).toEqual({
  version: 1,
  projectId: 'prj_1',
  sourceType: 'postman',
  canonicalDigest: 'canonical-a',
  planDigest: 'plan-a',
});
expect(() => createImportSnapshotTokenCodec(Buffer.alloc(32, 8)).verify(token))
  .toThrowError(expect.objectContaining({ code: 'IMPORT_PREVIEW_STALE' }));
```

Also reject payload/signature edits and cross-Project/source reuse. Assert canonical digest changes for Endpoint ID/revision/matcher/fallback, Variant ID/revision/name/status/headers/body ID/delay, or referenced Body Asset immutable metadata, but not for App State bindings, Project display/revision, workspace, or runtime settings. Assert plan digest changes for ordered locations, matcher/name/description/responses/warnings/errors or keyed variable digest, but not semantically equivalent source formatting.

- [ ] **Step 4: Run planner and token tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/compile-project.test.ts \
  src/import/planner.test.ts \
  src/import/snapshot-token.test.ts
```

Expected: FAIL because runtime rank is private and no grouping, overlap, digest, or authenticated token module exists.

- [ ] **Step 5: Export normalized matcher identity and runtime rank**

Refactor without changing runtime ordering:

```ts
export type CanonicalImportMatcher = Pick<EndpointDetail['matcher'], 'method' | 'host' | 'path'>;

export function normalizeCanonicalMatcher(matcher: CanonicalImportMatcher): CanonicalImportMatcher {
  return {
    method: normalizeMethod(matcher.method),
    ...(matcher.host === undefined ? {} : { host: normalizeHost(matcher.host) }),
    path: normalizePath(matcher.path),
  };
}

export interface MatcherSpecificityExtras {
  queryCount: number;
  exactQueryCount: number;
  headerCount: number;
  exactHeaderCount: number;
}

export function matcherSpecificity(
  matcher: CanonicalImportMatcher,
  extras: MatcherSpecificityExtras = {
    queryCount: 0,
    exactQueryCount: 0,
    headerCount: 0,
    exactHeaderCount: 0,
  },
): readonly number[] {
  const normalized = normalizeCanonicalMatcher(matcher);
  const hostExact = normalized.host !== undefined && !normalized.host.includes('*');
  const staticPath = normalized.path.replaceAll('*', '');
  return Object.freeze([
    normalized.host === undefined ? 0 : 1,
    hostExact ? 1 : 0,
    extras.queryCount,
    extras.exactQueryCount,
    extras.headerCount,
    extras.exactHeaderCount,
    staticPath.split('/').filter(Boolean).length,
    staticPath.length,
    normalized.path.includes('*') ? 0 : 1,
    normalized.method.includes('*') ? 0 : 1,
  ]);
}
```

Have `compileMatcher()` call the same helper with its existing query/header counts. Planner comparisons must pass each existing Endpoint matcher's query/header total and exact counts to `matcherSpecificity()`; imported candidates pass zeros because import does not persist those request fields. Add a planner test where an otherwise-equal existing matcher changes relative specificity only through query/header constraints. `matcherIdentity()` hashes the normalized three-field object; it never includes scheme, port, query, or headers.

- [ ] **Step 6: Implement grouping, conflicts, response names, and plan digests**

In `planner.ts`, group only members with a matcher by `matcherIdentity()`. Generate IDs as:

```ts
const itemId = sha256Identity('import-item-v1', {
  sourceType: parsed.sourceType,
  requestIdentity,
  locations: members.map(member => member.location),
});
```

`member.location` contains structural indexes only. Keep Postman breadcrumbs in `member.breadcrumb`/`item.breadcrumbs`; never include display names in provisional or final ID input. Add a test proving folder renames preserve IDs when item index paths and normalized request identity are unchanged.

For each group, flatten responses in member/source order. When that list is empty and create is allowed, synthesize one planned response before digesting or returning preview data:

```ts
{
  summary: {
    name: 'Default',
    status: 200,
    responseHeaders: {},
    body: { kind: 'none' },
    identity: sha256Identity('import-response-v1', {
      status: 200,
      headers: {},
      body: { kind: 'none' },
    }),
  },
}
```

Include it in `preview.responses`, `createResponses`, `createEffect.createsVariants`, and therefore the plan digest. Do not synthesize it for an exact existing matcher because that path must remain a no-op/skip. Then replace each blank trimmed source-response name with `Response ${index + 1}`. Preserve duplicate content for create, while suffixing every case-insensitive create-name collision against earlier create responses. For each exact target, compare response identity against existing Variants and earlier candidate identities, calculate `newVariantCount`, and deterministically suffix variants that will be merged against existing and earlier candidate names. Put those target-specific summaries in `ImportExactTarget.candidateResponses` and the corresponding private bytes in `mergeResponsesByEndpointId`.

Normalize existing Variant identity with the same status/header-array/body SHA rules; `bodyAssetId` is already the body SHA-256. Use `compareCodeUnits()` for every deterministic string ordering: exact targets by Endpoint stable ID, overlaps by target Endpoint/item ID, hosts lexically, and affected states by stable ID. Add non-ASCII stable-ID/hostname fixtures that prove output order does not depend on locale.

Each `PlannedImportItem.preview` contains the serializable row. `createEffect` describes only the create action; merge effectiveness remains target-specific through `ImportExactTarget.newVariantCount`. `createResponses` preserves every normalized response, including equal identities, after deterministic create-name suffixing. `mergeResponsesByEndpointId` contains only distinct responses for that exact target after deterministic target-name suffixing. Use exact plan digest content:

```ts
export function importPlanDigest(plan: ImportPreviewData, variablesDigest: string): string {
  return sha256Identity('import-plan-v1', {
    sourceType: plan.sourceType,
    variablesDigest,
    items: plan.items.map(item => ({
      id: item.id,
      locations: item.locations,
      name: item.name,
      description: item.description,
      matcher: item.matcher,
      responses: item.responses,
      exactTargets: item.exactTargets,
      overlaps: item.overlaps,
      warnings: item.warnings,
      errors: item.errors,
    })),
    unresolvedMembers: plan.unresolvedMembers,
    unresolvedVariables: plan.unresolvedVariables,
    warnings: plan.warnings,
  });
}
```

Copy `parsed.warnings` into `plan.preview.warnings`; member warnings remain on their item or unresolved member. The canonical digest serializes only the import-relevant fields listed in the Global Constraints and referenced Body Asset metadata.

- [ ] **Step 7: Implement the versioned HMAC envelope**

`createImportSnapshotTokenCodec()` defaults to `randomBytes(32)` once per repository construction. Encode `base64url(canonicalJson(payload)) + '.' + base64url(hmac)` and verify with equal-length `timingSafeEqual` before parsing trusted fields:

```ts
export interface ImportSnapshotTokenPayload {
  version: 1;
  projectId: string;
  sourceType: ImportSourceType;
  canonicalDigest: string;
  planDigest: string;
}

export interface ImportSnapshotTokenCodec {
  issue(input: Omit<ImportSnapshotTokenPayload, 'version'>): string;
  verify(token: string): ImportSnapshotTokenPayload;
}
```

Every malformed/signature failure throws `HttpError(409, 'IMPORT_PREVIEW_STALE', 'Import preview is stale; refresh the preview')`. The token payload contains digests, never source or plaintext variables.

- [ ] **Step 8: Run planner and token tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/compile-project.test.ts \
  src/import/planner.test.ts \
  src/import/snapshot-token.test.ts
```

Expected: PASS for shared runtime rank, conservative overlaps, exact grouping, provisional/final IDs, merge dedupe/name suffixing, fallback-safe proposals, canonical/plan digest scope, signature authentication, Project/source binding, and restart-key invalidation.

- [ ] **Step 9: Commit planner and token checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/repository/compile-project.ts \
  packages/server/src/repository/compile-project.test.ts \
  packages/server/src/import/planner.ts \
  packages/server/src/import/planner.test.ts \
  packages/server/src/import/snapshot-token.ts \
  packages/server/src/import/snapshot-token.test.ts
git commit -m "feat: plan deterministic import conflicts"
```

### Task 5: Body Store Import Transaction And Content-Type Precedence

**Files:**
- Modify: `packages/server/src/repository/file-system.ts:4-24`
- Modify: `packages/server/src/repository/body-store.ts:15-35,239-558`
- Modify: `packages/server/src/repository/body-store.test.ts`
- Modify: `packages/server/src/services/response-writer.ts:6-10,247-264`
- Modify: `packages/server/src/services/response-writer.test.ts`

**Interfaces:**
- Consumes: immutable SHA-256 Body Assets, `AtomicFileWriter`, `FileSystem`, and repeated Variant response headers.
- Produces: repository-private `BodyImportTransaction`, staged metadata overlay, promotion/rollback disposition for operation-owned assets only, and Variant-first `Content-Type` delivery. Task 6 integrates this transaction with candidate validation and generation publication through the repository interface.

- [ ] **Step 1: Add failing transaction staging, dedupe, conflict, and rollback tests**

Extend `body-store.test.ts` with the exact private interface:

```ts
export interface BodyImportTransaction {
  stage(bytes: Buffer, metadata: PutBodyMetadata): Promise<BodyAsset>;
  getMetadata(assetId: string): Promise<BodyAsset>;
  promote(): Promise<void>;
  rollback(): Promise<void>;
  complete(): void;
}

export interface BodyStore {
  // existing put/getMetadata/openReadStream methods remain unchanged
  beginImport(projectId: string): Promise<BodyImportTransaction>;
}
```

Tests must prove staged metadata is readable through the transaction but not `store.getMetadata()`, equal bytes/metadata deduplicate, equal bytes with different immutable metadata throw `ASSET_METADATA_CONFLICT`, and promotion creates content plus metadata exactly once.

Inject failures during second-asset promotion, metadata write, and rollback. After `rollback()`, assert every operation-owned content/metadata file is gone, pre-existing/deduplicated assets remain byte-for-byte unchanged, and `.import-*` staging files are removed. Calling `rollback()` or `complete()` twice must be harmless.

- [ ] **Step 2: Add failing Content-Type precedence tests**

Extend `response-writer.test.ts` with body-bearing and bodyless cases using its existing `RecordingTarget`, `resolved()`, `bodyAsset()`, `Readable`, and `writeResolvedResponse()` harness. Update the current authoritative-header assertion and add a focused case equivalent to:

```ts
const target = new RecordingTarget();
await writeResolvedResponse(target, resolved({
  responseHeaders: { 'content-type': 'application/vnd.example+json; profile=mobile' },
}), {
  getBody: async () => bodyAsset({ size: 2 }),
  openBody: () => Readable.from([Buffer.from('{}')]),
});
expect(target.header('content-type'))
  .toBe('application/vnd.example+json; profile=mobile');
expect(target.header('Content-Length')).toBe(2);
```

Also assert a non-empty body-bearing Variant without `Content-Type` falls back to Body Asset `application/octet-stream`; an explicitly present empty body without a Variant `Content-Type` has `Content-Length: 0` and no invented `Content-Type`; and a bodyless Variant preserves its own `Content-Type` with `Content-Length: 0` without calling the body repository.

- [ ] **Step 3: Run Body Store and writer tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/body-store.test.ts \
  src/services/response-writer.test.ts
```

Expected: FAIL because Body Store has no import transaction and the writer currently discards Variant `Content-Type` in favor of Body Asset metadata.

- [ ] **Step 4: Implement operation-owned staging and overlay reads**

Add `FileSystem.rm(path, { recursive: true, force: true })` and its `nodeFileSystem` adapter so staging cleanup remains injectable and failure-testable. `beginImport(projectId)` creates one `.import-${randomUUID()}` directory below the Project body root after the same containment/symlink checks as `put()`. `stage()` hashes the supplied Buffer and always requests schema-v3 `application/octet-stream` metadata from the importer. It first validates an existing complete asset; matching metadata records it as pre-existing, conflicting metadata throws 409, and an absent asset writes transaction-local content/metadata without publishing canonical paths.

Track exact disposition:

```ts
interface ImportAssetDisposition {
  asset: BodyAsset;
  contentStagingPath?: string;
  metadataStagingPath?: string;
  contentPromoted: boolean;
  metadataPromoted: boolean;
  preExisting: boolean;
}
```

`getMetadata()` returns a defensive clone from this map before falling back to canonical storage. `promote()` moves/writes only non-pre-existing assets, rechecks a concurrently appearing canonical asset for compatible metadata, and records each successful promotion before the next operation. `rollback()` removes only paths whose disposition says this transaction promoted them, then removes staging. `complete()` only marks ownership released and schedules best-effort staging removal; it never throws.

- [ ] **Step 5: Prefer Variant Content-Type and preserve bodyless values**

Replace the authoritative set with body-owned fields only:

```ts
const BODY_OWNED_HEADERS = new Set(['content-encoding', 'content-length']);

for (const [name, value] of Object.entries(resolvedHeaders)) {
  if (!BODY_OWNED_HEADERS.has(name.toLowerCase())) target.setHeader(name, value);
}
const variantHasContentType = Object.keys(resolvedHeaders)
  .some(name => name.toLowerCase() === 'content-type');
if (metadata && metadata.size > 0 && !variantHasContentType) {
  target.setHeader('Content-Type', metadata.mediaType);
}
target.setHeader('Content-Length', metadata?.size ?? 0);
if (metadata?.encoding) target.setHeader('Content-Encoding', metadata.encoding);
```

This applies uniformly to imported and authored Variants while preserving canonical Body Asset metadata.

- [ ] **Step 6: Run Body Store and writer tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/body-store.test.ts \
  src/services/response-writer.test.ts
```

Expected: PASS for staging visibility, deduplication, metadata conflicts, promotion/rollback disposition, idempotent cleanup, and Variant-first/non-empty-body-metadata-fallback `Content-Type` behavior without inventing a type for explicit empty bodies.

- [ ] **Step 7: Commit Body Store transaction checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/repository/file-system.ts \
  packages/server/src/repository/body-store.ts \
  packages/server/src/repository/body-store.test.ts \
  packages/server/src/services/response-writer.ts \
  packages/server/src/services/response-writer.test.ts
git commit -m "feat: stage import bodies with atomic publication"
```

### Task 6: Repository Preview And Atomic Commit

**Files:**
- Modify: `packages/server/src/repository/project-repository.ts:1-159,250-441,1490-1593`
- Modify: `packages/server/src/repository/project-repository.test.ts`

**Interfaces:**
- Consumes: parsers, planner/digests/token codec, Body Import Transaction, repository queue/ID allocator/snapshot clone, referential validation, compilation, and one `publishGeneration()`.
- Produces: `previewImport(projectId, input): ImportPreview` and `commitImport(projectId, input): Promise<ImportCommitResult>` as the only import publication interface used by Task 7.

- [ ] **Step 1: Add failing stateless preview and replay tests**

Extend `ProjectRepository` with:

```ts
previewImport(projectId: string, input: ImportPreviewRequest): ImportPreview;
commitImport(projectId: string, input: ImportCommitRequest): Promise<ImportCommitResult>;
```

Add tests proving preview writes no Project/body files, returns deterministic items/tokens for equivalent formatting, and returns provisional unresolved members before supplied variables move them into grouped final items. Assert a changed source, changed variable value, unknown/duplicate selected ID, unknown/duplicate action ID, missing action, extra action, invalid selected item, disallowed create/merge/skip, stale merge target, or unconfirmed equal-specificity overlap rejects the whole commit with `IMPORT_SELECTION_INVALID`.

Assert unresolved replay fails before selection with `IMPORT_VARIABLES_REQUIRED`, and zero/effectively skipped changes fail with `IMPORT_NO_CHANGES`.

- [ ] **Step 2: Add failing create/merge revision and identity tests**

Cover these independently reviewable outcomes:

- new Endpoint/Variant IDs are stable-shaped but not preview item IDs;
- new Endpoint and Variant revisions are 0;
- first saved response is fallback;
- no-response cURL publishes the exact empty `Default` status-200 fallback already present in its preview and plan digest;
- duplicate saved responses are both preserved for a new Endpoint;
- exact merge keeps existing fallback/Variant IDs/revisions and adds only distinct content;
- each merged Endpoint revision increments once for any number of added Variants;
- deterministic case-insensitive suffixes use the first available number;
- one selected item can target one of multiple legacy exact-match Endpoints only;
- unselected valid items and explicit skip actions are returned in `skippedItemIds`; invalid preview items are absent;
- no App State, Project display/revision, workspace, or runtime-settings field changes.

Core result assertion:

```ts
expect(result).toEqual({
  createdEndpointIds: [expect.stringMatching(/^ep_/)],
  updatedEndpointIds: ['ep_existing'],
  createdVariantIds: [
    expect.stringMatching(/^var_/),
    expect.stringMatching(/^var_/),
    expect.stringMatching(/^var_/),
  ],
  skippedItemIds: [skippedItemId],
});
expect(repository.getEndpoint(projectId, 'ep_existing')).toMatchObject({
  defaultVariantId: existingFallbackId,
  revision: existingRevision + 1,
});
```

- [ ] **Step 3: Add failing stale, collision, publication, and asset tests**

Preview, then mutate each import-relevant field class and assert commit returns `IMPORT_PREVIEW_STALE` before merge-target validation. Mutate only App State bindings, Project name, workspace, or settings and assert the token remains valid.

Use a fixed `idSource` to exhaust Endpoint/Variant allocation and assert public `ID_COLLISION`. Include collisions between two selected creates in the same candidate, proving an ID reserved by the first item cannot be reused by the second before either is published. Spy/inject the generation writer to prove one queue entry and one `publishGeneration()` for a multi-item create+merge. Inject validation, compile, staged write, generation rename, body promotion, and pointer failures; assert no Endpoint/Variant/binding/pointer change and no operation-owned Body Asset. Pre-existing and deduplicated assets must remain.

Record the successful transaction order through a tracking `BodyStore` adapter:

```ts
expect(events).toEqual([
  'validate-staged-metadata',
  'compile-candidate',
  'write-generation',
  'rename-generation',
  'promote-assets',
  'publish-pointer',
  'publish-memory',
  'complete-assets',
]);
```

For a simulated response failure after `commitImport()` resolves, assert the committed pointer remains and transaction rollback does not run.

- [ ] **Step 4: Run repository import tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run src/repository/project-repository.test.ts
```

Expected: FAIL because the repository exposes only direct granular mutations and cannot preview/replay or publish multiple imported records with staged body bytes in one queue entry.

- [ ] **Step 5: Parse and issue stateless previews from current snapshots**

Construct one token codec and one variable-digest key in `createProjectRepository()`; accept optional deterministic keys only through `ProjectRepositoryOptions` for tests:

```ts
export interface ProjectRepositoryOptions {
  // existing fields
  importTokenKey?: Buffer;
  importVariableDigestKey?: Buffer;
}
```

Dispatch source by discriminant:

```ts
function parseImport(input: ImportPreviewRequest): ParsedImportSource {
  return input.source.type === 'curl'
    ? parseCurlSource(input.source.text)
    : parsePostmanSource(input.source.collection, input.variables ?? {});
}
```

`previewImport()` reads one current snapshot, builds the internal plan, calculates canonical and plan digests from `plan.preview`, then returns `{ ...plan.preview, snapshotToken }`. It does not return private planned responses, enter the queue, allocate IDs, write files, retain source, or retain a preview session.

- [ ] **Step 6: Validate replay and selection in the specified order**

Inside `enqueue(projectId, async () => ...)`:

1. require the current snapshot;
2. reparse and rebuild the complete plan;
3. reject unresolved variables;
4. verify deterministic item IDs and exact selected/action cardinality;
5. verify token signature, Project ID, source type, canonical digest, and plan digest;
6. only then validate selected merge targets and overlap confirmations;
7. reject no effective changes before ID allocation/body staging.

Use `IMPORT_SELECTION_INVALID` when replay no longer reproduces the plan or client choices violate the preview. Use `IMPORT_PREVIEW_STALE` for token/signature/canonical mismatch. This ordering ensures a changed/disappeared preview target is stale, while a non-preview target under a valid snapshot is invalid selection.

- [ ] **Step 7: Build one candidate and publish once**

Create one Body Import Transaction after all replay/selection checks. Allocate IDs during commit only. Maintain candidate-wide reserved Endpoint and Variant ID sets initialized from the current snapshot; add each allocation immediately so later selected items cannot reuse an ID that exists only in the in-memory candidate. Exhaustion maps to `ID_COLLISION` before publication. For each selected create, create all Variants in source order and set `defaultVariantId` to the first.

For each selected create, consume `plannedItem.createResponses` exactly as previewed; commit never synthesizes an unpreviewed response. For each selected merge, consume only `plannedItem.mergeResponsesByEndpointId.get(action.endpointId)`, compare identities again under the queue, stage bodies only for distinct new responses, suffix names against existing plus earlier additions, append new Variants, and increment the Endpoint revision once after all additions. Never rewrite the fallback or existing Variants.

Stage every non-`undefined` response body as:

```ts
const asset = await bodyTransaction.stage(response.body, {
  mediaType: 'application/octet-stream',
});
```

Clone the current snapshot once, mutate only `candidate.endpoints`, and call `publishGeneration(projectId, candidate, bodyTransaction)` exactly once. Return creation/update IDs in deterministic preview/application order and skipped item IDs in preview order. If pre-publication work throws, call `rollback()` and preserve the original error.

Make existing private preparation/publication functions transaction-aware without expanding `ProjectRepository`:

```ts
async function prepare(
  candidateInput: ValidatedProjectSnapshot,
  getBodyMetadata: (projectId: string, assetId: string) => Promise<BodyAsset> = bodyStore.getMetadata,
): Promise<{ snapshot: ValidatedProjectSnapshot; compiled: CompiledProject }>;

async function publishGeneration(
  projectId: string,
  candidate: ValidatedProjectSnapshot,
  bodyTransaction?: BodyImportTransaction,
): Promise<ValidatedProjectSnapshot>;
```

Use `bodyTransaction === undefined ? bodyStore.getMetadata : (_projectId, assetId) => bodyTransaction.getMetadata(assetId)` as the candidate metadata overlay; do not pass the one-argument transaction method directly to the current two-argument repository callback. After the staged generation rename and before `current.json`, call `promote()`. Set `pointerPublished = true` only after the atomic pointer write resolves, then call the non-throwing `publish()` map swap and `complete()`. In `catch`, call `rollback()` only while `pointerPublished === false`; preserve the original operation error if cleanup also fails.

- [ ] **Step 8: Run repository import tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/project-repository.test.ts \
  src/repository/body-store.test.ts
```

Expected: PASS for stateless preview, replay binding, IDs, variables, duplicate/overlap choices, stale detection, create/merge revisions, fallback preservation, one generation publication, stable-ID collision mapping, body dedupe/conflict/cleanup, and non-mutation of App States/settings/workspace.

- [ ] **Step 9: Commit repository import checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/repository/project-repository.ts \
  packages/server/src/repository/project-repository.test.ts
git commit -m "feat: commit import previews atomically"
```

### Task 7: Server And Dashboard HTTP Contracts With Old Route Removal

**Files:**
- Replace: `packages/server/src/routes/admin/imports.ts`
- Delete: `packages/server/src/utils/curl-parser.ts`
- Delete: `packages/server/src/utils/postman-parser.ts`
- Modify: `packages/server/src/routes/admin.test.ts:78-101`
- Modify: `packages/server/src/routes/admin/repository-integrations.test.ts:17,42-50,214-221`
- Modify: `packages/server/src/services/api-errors.test.ts`
- Modify: `packages/dashboard/src/api/types.ts:1-254`
- Modify: `packages/dashboard/src/api/client.ts:1-268`
- Modify: `packages/dashboard/src/api/client.test.ts:1-209`

**Interfaces:**
- Consumes: repository `previewImport/commitImport`, import contracts, existing 12-MiB admin JSON parser, stable path validation/error serialization, and abort-aware dashboard `json()`.
- Produces: `POST .../import/preview` (200), `POST .../import/commit` (201), exact dashboard `importApi.preview/commit`, documented import errors/request IDs, and 404s for old `/curl` and `/postman` routes.

- [ ] **Step 1: Add failing route payload/status/error tests**

Replace old import assertions with preview/commit Supertest flows. Assert strict source discriminants and strict actions reject unknown keys; stable Project paths retain `INVALID_PROJECT_ID`; missing Projects return `PROJECT_NOT_FOUND`; malformed JSON returns `MALFORMED_JSON`; and the complete envelope remains capped at 12 MiB.

Assert exact successful statuses and IDs-only commit response:

```ts
const preview = await request(app)
  .post(`/api/admin/projects/${project.id}/import/preview`)
  .send({ source: { type: 'curl', text: "curl 'https://api.example.test/users'" } })
  .expect(200);

await request(app)
  .post(`/api/admin/projects/${project.id}/import/commit`)
  .send({
    source: { type: 'curl', text: "curl 'https://api.example.test/users'" },
    snapshotToken: preview.body.snapshotToken,
    selectedItemIds: [preview.body.items[0].id],
    actions: [{ itemId: preview.body.items[0].id, action: 'create' }],
  })
  .expect(201)
  .expect(response => {
    expect(response.body).toEqual({
      createdEndpointIds: [expect.stringMatching(/^ep_/)],
      updatedEndpointIds: [],
      createdVariantIds: [expect.stringMatching(/^var_/)],
      skippedItemIds: [],
    });
  });
```

Assert preview payload serialization contains no raw cURL text, request body, auth value, supplied secret, or response body. Include an exact public-shape fixture proving a hashed response body serializes as `{ kind: 'sha256', sha256, byteCount }`, an item serializes `createEffect`, a top-level parser warning remains in `warnings`, and each exact target exposes its own `candidateResponses`. Assert every documented import error keeps `X-Request-Id` and body `requestId`.

- [ ] **Step 2: Add failing source-part/count/old-route tests**

Cover serialized `source` over 10 MiB and non-source commit fields over 1 MiB as `IMPORT_LIMIT_EXCEEDED`, semantic parser limits as `IMPORT_LIMIT_EXCEEDED`, unresolved commit as `IMPORT_VARIABLES_REQUIRED`, selection/no-op as their exact codes, stale as 409, metadata conflict as 409, and ID collision as 409.

Assert removal explicitly:

```ts
await request(app).post(`/api/admin/projects/${project.id}/import/curl`).send({}).expect(404);
await request(app).post(`/api/admin/projects/${project.id}/import/postman`).send({}).expect(404);
```

- [ ] **Step 3: Add failing dashboard type/client request tests**

Mirror every Task 1 public interface in `dashboard/src/api/types.ts`, using browser-safe types only. Add client tests:

```ts
const controller = new AbortController();
await importApi.preview('prj/1', previewInput, controller.signal);
expect(fetch).toHaveBeenNthCalledWith(
  1,
  '/api/admin/projects/prj%2F1/import/preview',
  expect.objectContaining({
    method: 'POST',
    body: JSON.stringify(previewInput),
    signal: controller.signal,
  }),
);

await importApi.commit('prj/1', commitInput);
expect(fetch).toHaveBeenNthCalledWith(
  2,
  '/api/admin/projects/prj%2F1/import/commit',
  expect.objectContaining({ method: 'POST', body: JSON.stringify(commitInput) }),
);
expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('signal');
```

Have the mocked preview response use the same exact Task 7 route fixture, including `body: { kind: 'sha256', sha256: 'ab'.repeat(32), byteCount: 2 }`, `createEffect`, top-level `warnings`, and target-specific `candidateResponses`. Assert the browser-safe `ImportPreview` result preserves that shape exactly; never mirror the internal response-identity `{ kind: 'sha256', value }` input as the public body summary.

- [ ] **Step 4: Run route and client tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/routes/admin.test.ts \
  src/routes/admin/repository-integrations.test.ts \
  src/services/api-errors.test.ts
npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts
```

Expected: FAIL because only immediate `/curl` and `/postman` routes/clients exist and they return canonical records rather than previews and IDs-only results.

- [ ] **Step 5: Implement strict preview and commit route schemas**

Use strict Zod schemas with a stable Project path checked by repository entry. Parse preview and commit separately so error codes stay canonical:

```ts
const source = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('curl'), text: z.string() }),
  z.strictObject({ type: z.literal('postman'), collection: z.unknown() }),
]);
const variables = z.record(z.string(), z.string()).optional();
const action = z.discriminatedUnion('action', [
  z.strictObject({ itemId: z.string(), action: z.literal('create'), confirmOverlap: z.boolean().optional() }),
  z.strictObject({ itemId: z.string(), action: z.literal('merge'), endpointId: z.string() }),
  z.strictObject({ itemId: z.string(), action: z.literal('skip') }),
]);
```

On preview schema failure, throw `IMPORT_SOURCE_INVALID`. On commit source/variable failure, throw `IMPORT_SOURCE_INVALID`; on token/selection/action structural failure, throw `IMPORT_SELECTION_INVALID`. Before repository calls, compute UTF-8 byte lengths of `JSON.stringify(body.source)` and the body excluding `source`; enforce 10 MiB and 1 MiB respectively with `IMPORT_LIMIT_EXCEEDED`.

Mount only:

```ts
router.post('/preview', asyncHandler(async (req, res) => {
  res.json(repository.previewImport(req.params.projectId, parsePreviewRequest(req.body)));
}));

router.post('/commit', asyncHandler(async (req, res) => {
  res.status(201).json(await repository.commitImport(
    req.params.projectId,
    parseCommitRequest(req.body),
  ));
}));
```

Do not retain old handlers or compatibility aliases. Delete the two legacy `src/utils/*-parser.ts` modules in this same cutover after all production/test callers use `src/import/curl-parser.ts` and `src/import/postman-parser.ts`; this keeps Tasks 2-6 buildable while ensuring no direct-commit parser path survives Task 7.

- [ ] **Step 6: Mirror contracts and replace dashboard import clients**

Delete `importCurl/importPostman` and expose only:

```ts
export const importApi = {
  preview: (projectId: string, input: ImportPreviewRequest, signal?: AbortSignal) =>
    json<ImportPreview>(`${API_BASE}/projects/${segment(projectId)}/import/preview`, {
      method: 'POST', body: JSON.stringify(input), signal,
    }),
  commit: (projectId: string, input: ImportCommitRequest) =>
    json<ImportCommitResult>(`${API_BASE}/projects/${segment(projectId)}/import/commit`, {
      method: 'POST', body: JSON.stringify(input),
    }),
};
```

Do not add an abort signal to commit; once accepted by the server queue it is not presented as client-cancellable.

- [ ] **Step 7: Run route and client tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/routes/admin.test.ts \
  src/routes/admin/repository-integrations.test.ts \
  src/services/api-errors.test.ts
npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts
```

Expected: PASS for exact routes/statuses, strict unions/actions, size and semantic limits, sanitized preview/error payloads, request IDs, stable Project paths, IDs-only commit results, dashboard cancellation semantics, and old-route 404s.

- [ ] **Step 8: Commit HTTP contract checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/server/src/routes/admin/imports.ts \
  packages/server/src/utils/curl-parser.ts \
  packages/server/src/utils/postman-parser.ts \
  packages/server/src/routes/admin.test.ts \
  packages/server/src/routes/admin/repository-integrations.test.ts \
  packages/server/src/services/api-errors.test.ts \
  packages/dashboard/src/api/types.ts \
  packages/dashboard/src/api/client.ts \
  packages/dashboard/src/api/client.test.ts
git commit -m "feat: expose preview-first import contracts"
```

### Task 8: Wizard Hook, Steps, And Stale-Choice Reconciliation

**Files:**
- Create: `packages/dashboard/src/hooks/useImportWizard.ts`
- Create: `packages/dashboard/src/hooks/useImportWizard.test.tsx`
- Create: `packages/dashboard/src/components/import/ImportWizard.tsx`
- Create: `packages/dashboard/src/components/import/ImportWizard.test.tsx`
- Create: `packages/dashboard/src/components/import/ImportSourceStep.tsx`
- Create: `packages/dashboard/src/components/import/ImportResolveStep.tsx`
- Create: `packages/dashboard/src/components/import/ImportReviewStep.tsx`
- Create: `packages/dashboard/src/components/import/ImportResultStep.tsx`

**Interfaces:**
- Consumes: Task 7 dashboard import contracts/client, browser `File`/drag-and-drop/AbortController, shared `Modal`, and server-owned actions/conflicts.
- Produces: `useImportWizard(projectId)`, `reconcileImportChoices(previous, next, choices)`, Source/Resolve/Review/Complete UI, redacted expandable details, disabled commit rules, stale refresh, preview abort, and commit dismissal lock.

`ImportWizard` exposes only orchestration callbacks; `AppContent` never reaches into hook state:

```ts
export interface ImportWizardProps {
  isOpen: boolean;
  projectId: string;
  onDirtyChange(dirty: boolean, discard: () => void): void;
  onRequestClose(): void;
  onCommitted(result: ImportCommitResult): Promise<void>;
  onCommitOutcomeUnknown(): Promise<void>;
  onViewEndpoints(): void;
}
```

- [ ] **Step 1: Add failing hook state and cancellation tests**

Define exact hook interfaces in the test:

```ts
export type ImportWizardStep = 'source' | 'resolve' | 'review' | 'complete';

export interface ImportItemChoice {
  selected: boolean;
  action?: ImportActionName;
  endpointId?: string;
  confirmOverlap?: boolean;
}

export class ImportWizardValidationError extends Error {}
export class ImportCommitOutcomeUnknownError extends Error {}

export interface UseImportWizardResult {
  step: ImportWizardStep;
  sourceType: ImportSourceType;
  curlText: string;
  postmanFile?: File;
  variables: Record<string, string>;
  preview?: ImportPreview;
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
```

Test that changing Project resets and aborts preview, a newer preview owns publication when an older request resolves last, closing/reset aborts preview, and commit has no abort signal. Calling `commit()` while `canCommit` is false records `ImportWizardValidationError`, makes no client call, and cannot become an unknown-outcome refresh. A 409 `IMPORT_PREVIEW_STALE` preserves source/variables/choices, sets `stale`, and leaves the step on Review.

- [ ] **Step 2: Add failing pure reconciliation tests**

Export and test `reconcileImportChoices(previous, next, choices)`:

```ts
expect(reconcileImportChoices(previous, refreshed, {
  stableMerge: { selected: true, action: 'merge', endpointId: 'ep_same' },
  stableCreate: { selected: true, action: 'create', confirmOverlap: true },
  changedCreate: { selected: true, action: 'create', confirmOverlap: true },
})).toEqual({
  stableMerge: { selected: true, action: 'merge', endpointId: 'ep_same' },
  stableCreate: { selected: true, action: 'create', confirmOverlap: true },
  changedCreate: { selected: true },
  newItem: { selected: true, action: 'create', confirmOverlap: false },
});
```

Preserve any action only while it remains in `nextItem.allowedActions`. Preserve merge only when the exact target remains. Preserve create/confirmation only when create remains allowed and the code-unit-sorted overlap target IDs, relative specificity, and `confirmationRequired` flags are unchanged. Use a local code-unit comparator rather than `localeCompare`, with a non-ASCII target-ID test. Preserve skip and selected state for unchanged IDs. New valid items use server defaults. Invalid items are unselected. Removed IDs disappear. Changed conflicts stay selected but have unresolved action/confirmation. Add a refresh case where a previously valid create gains an exact canonical match: keep the row selected, but clear create and its confirmation because only merge/skip remain allowed.

- [ ] **Step 3: Add failing Source/Resolve/Review/Complete component tests**

Render `ImportWizard` and assert:

- cURL/Postman tabs, pasted multi-command text, one `.json` file input, and drag/drop;
- invalid JSON appears inline without clearing the selected file/source;
- preview shows a layout-matched row skeleton rather than a spinner;
- Resolve appears only for unresolved variables or item errors, with visible labels/helper text and disabled invalid rows;
- Continue reruns preview with supplied variables;
- a mixed valid/invalid source can continue from Resolve to Review after variables are resolved, retaining invalid rows unselected;
- Review defaults valid rows selected and shows method, hostname/path, every grouped source location/breadcrumb, source scheme/port, response count, action, warnings/errors;
- collection/folder-level preview warnings remain visible even for an empty collection;
- filters cover Selected, Warnings, Errors, New, and Merge;
- expanded rows render redacted request fields/response summaries and never raw secrets;
- duplicate merge target selection and equal-specificity confirmation gate commit;
- with multiple exact targets, merge effectiveness and merged-Variant summary counts use the selected target's `newVariantCount`, including a target-specific no-op;
- summary reports selected requests, new Endpoints, merged Variants, discovered hosts, skipped duplicates, and affected App States; copy states imported hosts are matcher-only, interception is unchanged, imported Endpoints are unbound, and fallback behavior remains;
- zero effective changes, unresolved variables/actions, selected invalid rows, or unconfirmed overlaps disable commit;
- pending commit disables every source/action control and `Modal` dismissal;
- success renders counts and `View Endpoints` without opening an Endpoint;
- a non-`ApiClientError` commit transport or success-payload decode failure calls `onCommitOutcomeUnknown()` before displaying an outcome-unknown error; documented HTTP errors do not.

- [ ] **Step 4: Run hook and wizard tests and verify RED**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/hooks/useImportWizard.test.tsx \
  src/components/import/ImportWizard.test.tsx
```

Expected: FAIL because no wizard state owner, stale reconciliation, source handling, review steps, or import modal exists.

- [ ] **Step 5: Implement source ownership and preview publication**

Store the Postman `File` and parsed collection in memory only. `setPostmanFile()` requires `.json`, reads `file.text()`, parses JSON as data, and preserves the file while surfacing parse errors. Build source exactly:

```ts
const source: ImportSource = sourceType === 'curl'
  ? { type: 'curl', text: curlText }
  : { type: 'postman', collection: postmanCollection };
```

Each preview aborts the previous controller and publishes only when its controller still owns the request. Initialize choices from every item:

```ts
function defaultChoice(item: ImportPreviewItem): ImportItemChoice {
  return {
    selected: item.selectedByDefault && item.errors.length === 0,
    action: item.proposedAction,
    ...(item.proposedAction === 'create' ? { confirmOverlap: false } : {}),
    ...(item.proposedAction === 'merge' && item.exactTargets.length === 1
      ? { endpointId: item.exactTargets[0]!.endpointId }
      : {}),
  };
}
```

Choose Resolve on the initial preview when unresolved variables or item errors need attention; otherwise choose Review. `continueFromResolve()` reruns preview, remains on Resolve while URL variables are unresolved, and advances to Review when variables are resolved even if persistent enumerable item errors remain. Those invalid items stay visible and unselected. Keep source/errors in place on structural failures.

- [ ] **Step 6: Implement exact commit construction and stale refresh**

`commit()` first rejects with hook-owned `ImportWizardValidationError` and makes no API call when `canCommit` is false. Construct actions only for selected valid items, and never convert a missing action into skip:

```ts
const selectedItemIds = preview.items
  .filter(item => choices[item.id]?.selected)
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
```

`canCommit` requires one selected item with an effective create/merge change, exact action cardinality, no selected errors, no unresolved variables, a valid merge target, and every required overlap confirmation. A create uses `item.createEffect`; a merge and the Review summary use the chosen `ImportExactTarget.newVariantCount`, never an item-level proposed-action count. On stale refresh, call preview with retained source/variables and apply `reconcileImportChoices()` before clearing `stale`.

The hook's `commit()` records `result` on success and returns it. It records documented `ApiClientError` failures, including stale state, then rejects. After the commit API call begins, a non-`ApiClientError` transport or successful-response decode failure is wrapped as `ImportCommitOutcomeUnknownError` and rejects without publishing a hook error because server publication may already have happened. The hook does not own App-level refresh callbacks.

`ImportWizard` orchestrates that prop boundary: await `commit()`, then await `onCommitted(result)` on success. Only for `ImportCommitOutcomeUnknownError`, first await `onCommitOutcomeUnknown()` and then publish a component-owned outcome-unknown error. This guarantees canonical Endpoint and App State refresh precedes the ambiguous error state without misclassifying local validation failures. Documented `ApiClientError` and `ImportWizardValidationError` failures remain in the normal or stale flow and do not trigger the unknown-outcome refresh.

- [ ] **Step 7: Implement focused responsive step modules**

Use the shared `Modal` with:

```tsx
className="flex h-[100dvh] w-full flex-col overflow-hidden bg-white sm:h-[min(52rem,calc(100dvh-2rem))] sm:max-w-6xl sm:rounded-xl sm:border sm:border-gray-200 sm:shadow-xl"
```

On mobile, each step is one column and the action footer stays visible; on desktop, Review uses a scrollable table with expandable detail rows. Keep existing gray/blue Tailwind language, one blue primary action, existing radius scale, labels above inputs, inline errors below inputs, and no animation dependency. `Modal.loading={committing}` owns Escape/backdrop lock.

The review step receives only data/callback props and never calls the client. `ImportSourceStep` owns no source state; `ImportResolveStep` owns no variable state; `ImportResultStep` receives canonical counts only.

- [ ] **Step 8: Run hook and wizard tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/hooks/useImportWizard.test.tsx \
  src/components/import/ImportWizard.test.tsx \
  src/components/Modal.test.tsx
```

Expected: PASS for every source/loading/empty/error/Resolve/Review/stale/success state, file/drop input, redaction, filters/expansion/actions, choice reconciliation, abort ownership, commit lock, and desktop/mobile modal semantics.

- [ ] **Step 9: Commit wizard checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/dashboard/src/hooks/useImportWizard.ts \
  packages/dashboard/src/hooks/useImportWizard.test.tsx \
  packages/dashboard/src/components/import/ImportWizard.tsx \
  packages/dashboard/src/components/import/ImportWizard.test.tsx \
  packages/dashboard/src/components/import/ImportSourceStep.tsx \
  packages/dashboard/src/components/import/ImportResolveStep.tsx \
  packages/dashboard/src/components/import/ImportReviewStep.tsx \
  packages/dashboard/src/components/import/ImportResultStep.tsx
git commit -m "feat: add guided import preview wizard"
```

### Task 9: Endpoints Entry Point, Modal Guard, And Canonical Refresh Integration

**Files:**
- Modify: `packages/dashboard/src/components/EndpointList.tsx:3-50`
- Modify: `packages/dashboard/src/components/EndpointList.test.tsx`
- Modify: `packages/dashboard/src/App.tsx:80-299`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: `ImportWizard`, current unsaved-changes registry/navigation guard, `useEndpoints.refresh()`, `useStates.refresh()/reloadSelected()`, Endpoint editor ownership, and IDs-only commit results.
- Produces: Endpoints-view `Import` entry, guarded nonempty close/project navigation, post-commit canonical refresh, unchanged Endpoint selection/editor behavior, and `View Endpoints` completion action.

- [ ] **Step 1: Add failing Endpoint list entry tests**

Extend props and assert distinct authoring actions:

```ts
export interface EndpointListProps {
  // existing props
  onImport(): void;
}
```

Click `Import` and expect only `onImport`; click `New Endpoint` and expect only `onCreate`. Keep existing host/path and Variant-count rendering unchanged.

- [ ] **Step 2: Add failing App modal, guard, and refresh tests**

Mock `ImportWizard` through a small prop harness. Assert:

- Import opens only from Endpoints view in the active Project;
- a nonempty wizard registers `import:${projectId}` with the existing unsaved-changes guard;
- close, Project switch, view navigation, and Endpoint create/select use the existing confirmation while the import draft is dirty;
- accepted close invokes the hook discard/reset callback and unregisters the key;
- pending commit cannot invoke close even through Escape/backdrop;
- successful commit calls `endpoints.refresh()` and `states.refresh()` in parallel, then `states.reloadSelected()`;
- a simulated commit transport/success-response decode failure invokes the same canonical refresh sequence before the wizard displays its outcome-unknown state;
- selected Endpoint ID/editor-open state does not change and no created Endpoint ID is selected;
- `View Endpoints` closes the completed wizard and retains Endpoints view.

Core refresh assertion:

```ts
expect(endpointHookSpies.refresh).toHaveBeenCalledOnce();
expect(stateHookSpies.refresh).toHaveBeenCalledOnce();
expect(stateHookSpies.reloadSelected).toHaveBeenCalledOnce();
expect(endpointHookSpies.selectEndpoint).not.toHaveBeenCalledWith(expect.stringMatching(/^ep_/));
```

- [ ] **Step 3: Run integration component tests and verify RED**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/EndpointList.test.tsx \
  src/App.test.tsx
```

Expected: FAIL because the Endpoints list has no import entry and `AppContent` does not own wizard visibility, draft registration, or import refresh orchestration.

- [ ] **Step 4: Add the Endpoints import action without changing list behavior**

Render `Import` as a neutral bordered action beside the existing blue `New Endpoint` button:

```tsx
<div className="flex items-center gap-2">
  <button type="button" onClick={onImport} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
    Import
  </button>
  <button type="button" onClick={onCreate} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
    New Endpoint
  </button>
</div>
```

Do not move Endpoint creation into the import wizard.

- [ ] **Step 5: Register the import draft and route closure through the existing guard**

In `AppContent`, add `importOpen`, use a stable key `const importDraftKey = projectId ? `import:${projectId}` : 'import'`, and have the wizard report dirty/discard ownership through the existing `onDirtyChange` callback. Close with:

```ts
const closeImport = () => onAttemptNavigation(() => {
  setImportOpen(false);
}, [importDraftKey]);
```

The discard callback calls the wizard hook's `reset()` before closure. Unregister the key on successful commit/unmount. Opening Import also goes through `onAttemptNavigation()` so existing Endpoint/Variant/App State drafts are respected.

- [ ] **Step 6: Refresh canonical data after successful commit**

Use one canonical-refresh orchestration callback for both confirmed success and unknown publication outcome:

```ts
const refreshImportCanonicalData = async () => {
  await Promise.all([endpoints.refresh(), states.refresh()]);
  await states.reloadSelected();
};
```

Have `handleImportCommitted()` call `refreshImportCanonicalData()` and pass the same callback as `onCommitOutcomeUnknown`. Do not call `refreshProjects()` because import cannot mutate Project fields; do not reload runtime settings; do not close/open the Endpoint editor or call `selectEndpoint()`. `View Endpoints` only closes the completed wizard.

- [ ] **Step 7: Run integration component tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/EndpointList.test.tsx \
  src/components/import/ImportWizard.test.tsx \
  src/hooks/useImportWizard.test.tsx \
  src/hooks/useUnsavedChangesGuard.test.tsx \
  src/App.test.tsx
```

Expected: PASS for the Endpoints entry point, existing draft guard, modal close/commit ownership, canonical Endpoint/State refresh, selected State detail reload, and no predicted/auto-opened canonical record.

- [ ] **Step 8: Commit dashboard integration checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add \
  packages/dashboard/src/components/EndpointList.tsx \
  packages/dashboard/src/components/EndpointList.test.tsx \
  packages/dashboard/src/App.tsx \
  packages/dashboard/src/App.test.tsx
git commit -m "feat: integrate imports into endpoints workflow"
```

### Task 10: Import Acceptance Flow And Full Regression Gate

**Files:**
- Create: `packages/server/src/integration/import-preview.integration.test.ts`
- Verify: every file changed in Tasks 1-9

**Interfaces:**
- Consumes: HTTP preview/commit, Postman variables and saved responses, exact merge, host-specific/wildcard runtime matching, repeated header delivery, immutable Body Assets, restart loading, stale rejection, and canonical dashboard refresh coverage.
- Produces: end-to-end proof of multi-backend import delivery and atomic failure, plus fresh full-suite/lint/build/Graphify evidence.

- [ ] **Step 1: Add the failing multi-backend acceptance test**

Create one existing host-specific Endpoint with fallback body `existing fallback`, then preview a Postman v2.1 collection containing:

- a merge request to that exact matcher with a new 202 saved response;
- a new `https://{{region}}.api.example.test:8443/accounts/:id` request;
- a second backend host;
- collection default plus supplied variable resolution;
- repeated `Set-Cookie` response headers;
- a saved `Content-Type` different from Body Asset `application/octet-stream` metadata;
- one bodyless response with preserved `Content-Type`.

Commit selected create and merge actions through HTTP. Assert IDs-only results, existing fallback ID/body unchanged, merged Endpoint revision incremented once, no App State binding/revision changes, and settings `interceptHosts` unchanged.

- [ ] **Step 2: Restart and verify exact runtime delivery**

Dispose the first runtime references, call `createRuntime()` again with the same root, reselect the Project through canonical workspace APIs if required, and issue host-specific requests. Assert:

```ts
expect(delivered.status).toBe(207);
expect(delivered.body).toEqual(Buffer.from('{"account":true}'));
expect(delivered.headers['content-type']).toBe('application/vnd.mockmate+json; profile=import');
expect(delivered.headers['set-cookie']).toEqual([
  'session=one; Path=/',
  'theme=dark; Path=/',
]);
```

Verify `/accounts/42` matches the imported wildcard path only on its imported hostname, the second backend resolves independently, and the merged Endpoint still serves its old fallback unless an App State is explicitly changed later.

- [ ] **Step 3: Prove stale multi-item commit publishes nothing**

Create a second preview with two body-bearing new items. Mutate one existing import-relevant Variant through the canonical API, then submit the stale commit and expect 409 `IMPORT_PREVIEW_STALE`. Record Endpoint IDs, Variant IDs, App State bindings/revisions, generation pointer, and body-file listing before the request; assert all remain identical afterward and neither candidate body SHA exists.

This is the acceptance-level atomic-failure path; Task 5-6 focused tests retain injected validation/compile/write/rename/promotion/pointer failures.

- [ ] **Step 4: Run the acceptance test and verify RED or cross-subsystem coverage**

Run:

```bash
npm run test:integration --workspace=packages/server -- \
  src/integration/import-preview.integration.test.ts
```

Expected before Tasks 1-9: FAIL because preview/commit routes do not exist. After Tasks 1-9, PASS demonstrates the complete contract without additional production changes.

- [ ] **Step 5: Run the acceptance and focused suites and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/import/security.test.ts \
  src/import/curl-parser.test.ts \
  src/import/postman-parser.test.ts \
  src/import/planner.test.ts \
  src/import/snapshot-token.test.ts \
  src/domain/schemas.test.ts \
  src/repository/compile-project.test.ts \
  src/repository/body-store.test.ts \
  src/repository/project-repository.test.ts \
  src/services/response-writer.test.ts \
  src/services/proxy-server.test.ts \
  src/routes/admin.test.ts \
  src/routes/admin/repository-integrations.test.ts \
  src/routes/admin/versioned-core.test.ts \
  src/services/api-errors.test.ts
npm run test:integration --workspace=packages/server -- \
  src/integration/import-preview.integration.test.ts \
  src/integration/versioned-core.integration.test.ts
npm run test --workspace=packages/dashboard -- --run \
  src/api/client.test.ts \
  src/components/Modal.test.tsx \
  src/components/EndpointList.test.tsx \
  src/components/import/ImportWizard.test.tsx \
  src/hooks/useImportWizard.test.tsx \
  src/hooks/versioned-core-hooks.test.tsx \
  src/hooks/useUnsavedChangesGuard.test.tsx \
  src/App.test.tsx
```

Expected: every listed file passes with zero failures; owner-safe Endpoint/App State refresh coverage remains in `src/hooks/versioned-core-hooks.test.tsx`.

- [ ] **Step 6: Run full regression, integration, lint, build, and whitespace gates**

Run:

```bash
npm test
npm run test:integration:server
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0; dashboard and server compile, all sequential suites pass, and `git diff --check` prints no whitespace errors.

- [ ] **Step 7: Refresh Graphify and inspect final scope**

Run:

```bash
graphify update .
git status --short
git diff --stat
```

Expected: Graphify exits 0. Every new implementation path belongs to Tasks 1-10; every pre-existing uncommitted Authoring Foundation path remains intact; generated graph output is not staged.

- [ ] **Step 8: Commit acceptance checkpoint (Only with explicit user authorization)**

Only with explicit user authorization:

```bash
git add packages/server/src/integration/import-preview.integration.test.ts
git commit -m "test: verify atomic multi-backend imports"
```

## Completion Evidence

Before reporting implementation completion, record fresh output for:

```text
Focused import server tests: passing file/test counts
Focused Authoring Foundation regression tests: passing file/test counts
Focused dashboard wizard/integration tests: passing file/test counts
Import acceptance integration test: passing file/test counts
Full server integration tests: passing file/test counts
Full npm test: passing workspace/test counts
Lint: exit 0
Build: exit 0
git diff --check: exit 0
graphify update .: exit 0
```

Manually inspect the final diff against `docs/superpowers/specs/2026-08-30-mockmate-import-preview-design.md` and confirm all of the following with a concrete test reference: every Goal and Non-Goal; hostname-only identity and scheme/port warning; preview-only request data and redaction; empty initial response; no App State/interception mutation; stateless replay/HMAC digest scope; deterministic/provisional IDs; complete cURL/Postman parsing matrix; response normalization and `Content-Type` precedence; exact duplicate/Variant identity/name suffix semantics; conservative overlaps and confirmation; every HTTP status/error/limit; old-route removal; one queued generation publication and Body Asset rollback; Source/Resolve/Review/Complete states; stale reconciliation; unsaved close/abort/commit lock; canonical refresh; restart delivery; and proof that stale/injected failures publish no partial canonical records or orphan operation-owned Body Assets.
