# MockMate Authoring Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users fully author and safely delete Endpoints, Variants, and App States while preserving deterministic mobile automation, optimistic revisions, repeated response headers, immutable Body Assets, and atomic publication.

**Architecture:** Keep the existing Project -> Endpoint -> Variant and App State binding model. Extend canonical header types and the granular HTTP APIs, move every cross-record integrity change into one repository generation publication, and make the dashboard reload canonical details after structural mutations instead of predicting revisions.

**Tech Stack:** TypeScript, Node.js HTTP/TLS/streams, Express, Zod, React 19, Vitest, Testing Library, immutable generation storage.

## Global Constraints

- Preserve schema version 3. Existing persisted `Record<string, string>` response headers remain valid without migration.
- A repeated response header is `string[]`; ordering is significant and multiple `Set-Cookie` fields must never be comma-joined.
- Preserve Endpoint matcher semantics: `matcher.host` is optional, different Endpoints may select different backend hosts, and an empty host matches any already selected proxy host.
- Preserve resolution order: Active App State binding, Base App State binding, then Endpoint fallback Variant.
- Preserve both `PUT /setMockServerflags` and `POST /setMockServerflags`, their current payload, project-global state selection, and server-owned optimistic revision lookup.
- Test suites are sequential. Per-client or per-device App State selection is outside this plan.
- Preserve immutable Body Assets. Cloning a Variant may reuse a Body Asset ID, while editing bytes creates a new asset.
- Use the repository per-Project queue and `publishGeneration()` for Endpoint, Variant, and App State deletions that mutate multiple records.
- An impact response is advisory. The queued mutation must re-read and validate current revisions and references.
- Do not implement cURL/Postman import, proxy passthrough changes, Traffic retention, Traffic provenance, replay, or breakpoint behavior in this plan.
- Use strict RED/GREEN: each production behavior follows a focused test that failed for the expected reason.
- Preserve unrelated worktree changes. Never stage `.superpowers/`, `graphify-out/`, generated output, lockfiles, or unrelated files.
- Commit steps are execution checkpoints. Run them only if the user explicitly authorizes commits; otherwise leave the verified changes uncommitted.
- After TypeScript or JavaScript changes, run `graphify update .` as the final metadata refresh.

---

### Task 1: Canonical Repeated Response Headers

**Files:**
- Modify: `packages/server/src/domain/model.ts:22-32`
- Modify: `packages/server/src/domain/schemas.ts:73-83`
- Modify: `packages/server/src/domain/schemas.test.ts:150-250`
- Modify: `packages/server/src/repository/compile-project.ts:29-74,246-260,368-379`
- Modify: `packages/server/src/repository/compile-project.test.ts`

**Interfaces:**
- Consumes: existing schema-v3 `ResponseVariant`, `CreateVariantInput`, `VariantPatch`, `CompiledVariant`, and `ResolvedMock` structures.
- Produces: `ResponseHeaderValue`, `ResponseHeaders`, and immutable cloned response-header arrays used by every later task.

- [ ] **Step 1: Add failing persisted-schema tests**

Extend `header normalization` in `packages/server/src/domain/schemas.test.ts` with exact compatibility and rejection cases:

```ts
it('preserves ordered repeated response header values', () => {
  const parsed = ResponseVariantSchema.parse({
    ...validVariant,
    responseHeaders: {
      'Content-Type': 'application/json',
      'Set-Cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
    },
  });

  expect(parsed.responseHeaders).toEqual({
    'content-type': 'application/json',
    'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
  });
});

it('rejects empty repeated response header arrays', () => {
  expect(() => ResponseVariantSchema.parse({
    ...validVariant,
    responseHeaders: { 'Set-Cookie': [] },
  })).toThrow();
});
```

Also extend the prototype-shaped response-header case so `['one', 'two']` remains an own property under the normalized key.

- [ ] **Step 2: Add a failing nested-immutability compilation test**

In `packages/server/src/repository/compile-project.test.ts`, compile a Variant with two cookie values, mutate the source array, and assert both compiled storage and each resolved response retain the original values:

```ts
const cookies = ['first=1', 'second=2'];
const endpointWithCookies = endpoint(
  'ep_headers',
  { method: 'GET', path: '/profile' },
  ['var_headers'],
);
endpointWithCookies.variants[0].responseHeaders = { 'set-cookie': cookies };
const compiled = compileProject(snapshot({
  endpoints: [endpointWithCookies],
  states: [],
}));

cookies[0] = 'mutated=1';
const first = matchRequest(compiled, request());
expect(first?.responseHeaders['set-cookie']).toEqual(['first=1', 'second=2']);

const resolvedCookies = first?.responseHeaders['set-cookie'];
if (!Array.isArray(resolvedCookies)) throw new Error('Expected repeated header values');
resolvedCookies[0] = 'resolved-mutation=1';

const second = matchRequest(compiled, request());
expect(second?.responseHeaders['set-cookie']).toEqual(['first=1', 'second=2']);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/domain/schemas.test.ts \
  src/repository/compile-project.test.ts
```

Expected: FAIL because persisted schemas reject arrays and compiled/resolved types only accept scalar values.

- [ ] **Step 4: Add the canonical types and schema**

In `packages/server/src/domain/model.ts`, define the aliases immediately before `ResponseVariant` and use them on the model:

```ts
export type ResponseHeaderValue = string | string[];
export type ResponseHeaders = Record<string, ResponseHeaderValue>;

export interface ResponseVariant {
  id: string;
  endpointId: string;
  name: string;
  description?: string;
  status: number;
  responseHeaders: ResponseHeaders;
  bodyAssetId?: string;
  delayMs?: number;
  revision: number;
}
```

In `packages/server/src/domain/schemas.ts`, preserve scalar compatibility and prohibit empty arrays:

```ts
const responseHeaderValueSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
]);

export const ResponseVariantSchema: z.ZodType<ResponseVariant> = z.strictObject({
  id: idSchema,
  endpointId: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.number().int().min(100).max(599),
  responseHeaders: normalizedHeaderRecord(responseHeaderValueSchema),
  bodyAssetId: sha256Schema.optional(),
  delayMs: nonNegativeIntegerSchema.optional(),
  revision: nonNegativeIntegerSchema,
});
```

- [ ] **Step 5: Clone and freeze nested values at compilation boundaries**

Import `ResponseHeaders` into `compile-project.ts`, change `CompiledVariant.responseHeaders` and `ResolvedMock.responseHeaders` to that type, and use these helpers:

```ts
function cloneResponseHeaders(headers: ResponseHeaders): ResponseHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? [...value] : value,
  ]));
}

function freezeResponseHeaders(headers: ResponseHeaders): Readonly<ResponseHeaders> {
  return Object.freeze(Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? Object.freeze([...value]) : value,
  ]))) as Readonly<ResponseHeaders>;
}
```

Use `freezeResponseHeaders(sourceVariant.responseHeaders)` in the compiled Variant and `cloneResponseHeaders(variant.responseHeaders)` in each resolved response. Do not expose compiled array references.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/domain/schemas.test.ts \
  src/repository/compile-project.test.ts
```

Expected: PASS with scalar compatibility, ordered arrays, empty-array rejection, lowercase normalization, prototype safety, and defensive cloning.

- [ ] **Step 7: Commit the canonical header model if authorized**

```bash
git add \
  packages/server/src/domain/model.ts \
  packages/server/src/domain/schemas.ts \
  packages/server/src/domain/schemas.test.ts \
  packages/server/src/repository/compile-project.ts \
  packages/server/src/repository/compile-project.test.ts
```

Then run `git commit -m "feat: support repeated response headers"`.

### Task 2: Preserve Repeated Headers Through Serving And Capture

**Files:**
- Modify: `packages/server/src/services/response-writer.ts:13-16,247-264`
- Modify: `packages/server/src/services/response-writer.test.ts:47-95,880-958`
- Modify: `packages/server/src/services/proxy-server.ts:185-250,283-338`
- Modify: `packages/server/src/services/proxy-server.test.ts`
- Modify: `packages/server/src/test-support/proxy-test-client.ts:25-45`
- Modify: `packages/server/src/services/proxy-handler.ts:16-45`
- Modify: `packages/server/src/services/proxy.ts:12-18,90-105`
- Modify: `packages/server/src/types.ts:35-55`
- Modify: `packages/server/src/services/logger.ts:22-86`
- Modify: `packages/server/src/services/logger.test.ts`
- Modify: `packages/server/src/routes/admin/traffic.ts:45-69`
- Modify: `packages/server/src/repository/project-repository.ts:84-93`
- Modify: `packages/server/src/routes/admin/repository-integrations.test.ts`
- Modify: `packages/dashboard/src/api/types.ts:49-59,170-198`
- Modify: `packages/dashboard/src/components/TrafficView.tsx:443-458`
- Modify: `packages/dashboard/src/components/TrafficView.test.tsx`

**Interfaces:**
- Consumes: `ResponseHeaders` from Task 1 and Node's `setHeader(name, string | number | readonly string[])` contract.
- Produces: repeated-header-safe direct responses, intercepted proxy responses, passthrough results, traffic records, captured mocks, and dashboard inspection.

- [ ] **Step 1: Add failing direct-writer, proxy, and logger tests**

Add these assertions to the existing focused suites:

```ts
expect(target.headerWrites).toContainEqual([
  'set-cookie',
  ['session=one; Path=/', 'theme=dark; Path=/'],
]);
```

For both plain and TLS intercepted proxy requests, configure:

```ts
responseHeaders: {
  'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
}
```

Assert the raw response contains two independent fields in order:

```ts
expect(result.rawHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
  ['Set-Cookie', 'session=one; Path=/'],
  ['Set-Cookie', 'theme=dark; Path=/'],
]);
```

In `logger.test.ts`, mutate the input and returned arrays after logging and verify `listLogEntries()` still returns the original ordered values.

- [ ] **Step 2: Run the serving tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/services/response-writer.test.ts \
  src/services/proxy-server.test.ts \
  src/services/logger.test.ts \
  src/routes/admin/repository-integrations.test.ts
```

Expected: FAIL because response types are scalar, `SocketResponseTarget` comma-joins arrays, and the test parser overwrites duplicate fields.

- [ ] **Step 3: Propagate `ResponseHeaders` through server interfaces**

Use `ResponseHeaders` for response-side data only:

```ts
export interface ProxyOutgoingResponse {
  statusCode: number;
  headers: ResponseHeaders;
  body?: Buffer;
  bodyAssetId?: string;
  delayMs?: number;
  recordResponse?(
    preview: Buffer,
    size: number,
    headers: ResponseHeaders,
  ): void;
}
```

Apply the same type to `ProxyResult.headers`, `RequestLogEntry.responseHeaders`, `CapturedMockInput.responseHeaders`, and `applyHeaders(..., resolvedHeaders, ...)`. Keep request headers as `Record<string, string>`.

When cloning traffic entries, deep-copy only array values:

```ts
function cloneResponseHeaders(headers: ResponseHeaders | undefined): ResponseHeaders | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? [...value] : value,
  ]));
}
```

For `content-type`, consistently use the first value:

```ts
function firstHeaderValue(value: ResponseHeaderValue | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
```

- [ ] **Step 4: Emit one proxy header line per value**

Change `SocketResponseTarget` to retain arrays and serialize each member independently:

```ts
private readonly responseHeaders = new Map<
  string,
  { name: string; value: string | string[] }
>();

setHeader(name: string, value: string | number | readonly string[]): this {
  this.responseHeaders.set(name.toLowerCase(), {
    name,
    value: Array.isArray(value) ? value.map(String) : String(value),
  });
  return this;
}

headers(): ResponseHeaders {
  return Object.fromEntries([...this.responseHeaders].map(([name, header]) => [
    name,
    Array.isArray(header.value) ? [...header.value] : header.value,
  ]));
}
```

When constructing the HTTP head:

```ts
for (const { name, value } of this.responseHeaders.values()) {
  for (const item of Array.isArray(value) ? value : [value]) {
    head += `${name}: ${item}\r\n`;
  }
}
```

Connection-token handling must inspect all values with `Array.isArray(value) ? value : [value]`; do not restore comma-joining.

- [ ] **Step 5: Preserve repeated passthrough cookies and raw test evidence**

In `proxy.ts`, retain ordinary Fetch headers and replace `set-cookie` with Node's separate cookie list when available:

```ts
const headers: ResponseHeaders = {};
response.headers.forEach((value, name) => {
  headers[name] = value;
});
const getSetCookie = (response.headers as typeof response.headers & {
  getSetCookie?: () => string[];
}).getSetCookie;
const cookies = getSetCookie?.call(response.headers);
if (cookies?.length) headers['set-cookie'] = cookies;
```

In `proxy-test-client.ts`, return both the current convenient scalar map and ordered raw fields:

```ts
export interface ParsedProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  rawHeaders: Array<[string, string]>;
  body: Buffer;
}
```

Populate `rawHeaders` for every header line before assigning the scalar map.

- [ ] **Step 6: Render repeated Traffic headers as separate rows**

Mirror `ResponseHeaderValue` and `ResponseHeaders` in dashboard API types. Flatten values in `TrafficView`:

```tsx
{Object.entries(selectedLog.responseHeaders ?? {}).flatMap(([name, value]) =>
  (Array.isArray(value) ? value : [value]).map((item, index) => (
    <tr key={`${name}:${index}`}>
      <td className="px-3 py-2 font-mono text-xs">{name}</td>
      <td className="px-3 py-2 font-mono text-xs">{item}</td>
    </tr>
  )),
)}
```

Add a `TrafficView.test.tsx` assertion that both cookie values render in their original order.

- [ ] **Step 7: Run serving and dashboard tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/services/response-writer.test.ts \
  src/services/proxy-server.test.ts \
  src/services/logger.test.ts \
  src/routes/admin/repository-integrations.test.ts
npm run test --workspace=packages/dashboard -- --run \
  src/components/TrafficView.test.tsx
```

Expected: PASS with repeated fields preserved through direct serving, MITM serving, passthrough, logging, Traffic-to-mock creation, and rendering.

- [ ] **Step 8: Commit header transport if authorized**

```bash
git add \
  packages/server/src/services/response-writer.ts \
  packages/server/src/services/response-writer.test.ts \
  packages/server/src/services/proxy-server.ts \
  packages/server/src/services/proxy-server.test.ts \
  packages/server/src/test-support/proxy-test-client.ts \
  packages/server/src/services/proxy-handler.ts \
  packages/server/src/services/proxy.ts \
  packages/server/src/types.ts \
  packages/server/src/services/logger.ts \
  packages/server/src/services/logger.test.ts \
  packages/server/src/routes/admin/traffic.ts \
  packages/server/src/repository/project-repository.ts \
  packages/server/src/routes/admin/repository-integrations.test.ts \
  packages/dashboard/src/api/types.ts \
  packages/dashboard/src/components/TrafficView.tsx \
  packages/dashboard/src/components/TrafficView.test.tsx
```

Then run `git commit -m "fix: preserve repeated headers end to end"`.

### Task 3: Atomic Deletion And Impact Queries In The Repository

**Files:**
- Modify: `packages/server/src/domain/model.ts:99-111`
- Modify: `packages/server/src/repository/project-repository.ts:101-138,1506-1534,1691-1706,1768-1777`
- Modify: `packages/server/src/repository/project-repository.test.ts:623-998`

**Interfaces:**
- Consumes: existing snapshot clone, per-Project `enqueue()`, revision errors, `prepare()`, and `publishGeneration()`.
- Produces: `EndpointDeletionImpact`, `VariantDeletionImpact`, `VariantDeleteOptions`, impact getters, atomic dependent deletion, and explicit domain errors.

- [ ] **Step 1: Add failing impact and successful atomic-deletion tests**

Use the current repository fixtures to cover these exact outcomes:

```ts
expect(repository.getEndpointDeletionImpact('prj_1', 'ep_1')).toEqual({
  endpointId: 'ep_1',
  endpointRevision: 4,
  affectedStates: [
    { id: 'state_bound', name: 'Bound', revision: 2 },
  ],
});
```

After `deleteEndpoint('prj_1', 'ep_1', 4)`, assert the Endpoint is absent, only bound states lose `bindings.ep_1`, each affected state revision increments once, and unbound states retain their revisions.

For App State deletion, use table cases for Active only, Base only, both, and neither. Assert Project revision increments exactly once when either selection changes and no replacement state is chosen.

Create one immutable Body Asset, pass its ID to `createVariant()`, and assert the new Variant reuses that exact ID while the body store still has one asset. Also assert a missing or other-Project Body Asset ID is rejected before publication.

For Variant impact and deletion, assert:

```ts
expect(repository.getVariantDeletionImpact('prj_1', 'ep_1', 'var_old')).toEqual({
  endpointId: 'ep_1',
  endpointRevision: 7,
  variantId: 'var_old',
  variantRevision: 3,
  isFallback: true,
  affectedStates: [
    { id: 'state_bound', name: 'Bound', revision: 2 },
  ],
  replacementVariants: [
    { id: 'var_new', name: 'Replacement', revision: 1 },
  ],
});
```

Then delete with `{ expectedEndpointRevision: 7, replacementVariantId: 'var_new' }` and assert fallback, every matching binding, Endpoint revision, and affected state revisions change atomically.

- [ ] **Step 2: Add failing domain-error and rollback tests**

Add tests that assert exact status/code pairs:

```ts
await expect(repository.deleteVariant(
  'prj_1',
  'ep_1',
  'var_only',
  1,
)).rejects.toMatchObject({
  status: 409,
  code: 'LAST_VARIANT_REQUIRED',
});
```

Cover `VARIANT_REPLACEMENT_REQUIRED`, `INVALID_VARIANT_REPLACEMENT` for same/missing/cross-Endpoint IDs, stale Variant revision, stale required Endpoint revision, and `INVALID_DEFAULT_VARIANT` from `updateEndpoint()`.

Rewrite old Endpoint/State deletion failure tests that expected one-file `unlink()`. Inject failures at compile, staged generation write, generation rename, and `current.json` pointer publication; assert the old generation pointer and in-memory compiled behavior remain active.

- [ ] **Step 3: Run repository tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/project-repository.test.ts
```

Expected: FAIL because impact getters and explicit errors do not exist, while current deletion leaves or rejects dependent references.

- [ ] **Step 4: Add impact and deletion option types**

Add to `domain/model.ts`:

```ts
export interface AppStateReferenceSummary {
  id: string;
  name: string;
  revision: number;
}

export interface VariantReplacementSummary {
  id: string;
  name: string;
  revision: number;
}

export interface EndpointDeletionImpact {
  endpointId: string;
  endpointRevision: number;
  affectedStates: AppStateReferenceSummary[];
}

export interface VariantDeletionImpact {
  endpointId: string;
  endpointRevision: number;
  variantId: string;
  variantRevision: number;
  isFallback: boolean;
  affectedStates: AppStateReferenceSummary[];
  replacementVariants: VariantReplacementSummary[];
}
```

Add to `project-repository.ts`:

```ts
export interface VariantDeleteOptions {
  expectedEndpointRevision?: number;
  replacementVariantId?: string;
}
```

Extend `ProjectRepository` with synchronous impact getters and:

```ts
getEndpointDeletionImpact(
  projectId: string,
  endpointId: string,
): EndpointDeletionImpact;
getVariantDeletionImpact(
  projectId: string,
  endpointId: string,
  variantId: string,
): VariantDeletionImpact;
deleteVariant(
  projectId: string,
  endpointId: string,
  variantId: string,
  expectedRevision: number,
  options?: VariantDeleteOptions,
): Promise<void>;
```

The concrete repository method must declare
`options: VariantDeleteOptions = {}` so the existing call shape remains safe.

- [ ] **Step 5: Implement deterministic impact reads**

Read one current snapshot, select only matching states, and sort summaries by stable ID:

```ts
function appStateReference(state: AppState): AppStateReferenceSummary {
  return { id: state.id, name: state.name, revision: state.revision };
}

const affectedStates = [...snapshot.states.values()]
  .filter(state => Object.prototype.hasOwnProperty.call(state.bindings, endpointId))
  .sort((left, right) => left.id.localeCompare(right.id))
  .map(appStateReference);
```

Variant impact filters with `state.bindings[endpointId] === variantId`. Replacement candidates come only from the same Endpoint, exclude the deleted Variant, are sorted by ID, and include ID, name, and revision.

- [ ] **Step 6: Implement atomic Endpoint and App State deletion**

Inside the existing per-Project queue, clone the current snapshot and publish one complete generation:

```ts
candidate.endpoints.delete(endpointId);
for (const state of candidate.states.values()) {
  if (!Object.prototype.hasOwnProperty.call(state.bindings, endpointId)) continue;
  delete state.bindings[endpointId];
  state.revision += 1;
}
await publishGeneration(projectId, candidate);
```

For App State deletion:

```ts
candidate.states.delete(stateId);
let selectionChanged = false;
if (candidate.project.activeStateId === stateId) {
  delete candidate.project.activeStateId;
  selectionChanged = true;
}
if (candidate.project.baseStateId === stateId) {
  delete candidate.project.baseStateId;
  selectionChanged = true;
}
if (selectionChanged) {
  candidate.project.revision += 1;
  candidate.project.updatedAt = new Date().toISOString();
}
await publishGeneration(projectId, candidate);
```

Verify record revisions before cloning. Project revision increments once when the deleted state is both Active and Base.

- [ ] **Step 7: Implement guarded Variant replacement and fallback validation**

Before cloning, calculate `isFallback`, `affectedStates`, and `replacementRequired`. Enforce:

```ts
if (endpoint.variants.length === 1) {
  throw new HttpError(409, 'LAST_VARIANT_REQUIRED', 'Every Endpoint requires a Variant');
}
if (replacementRequired && (
  options.expectedEndpointRevision === undefined
  || options.replacementVariantId === undefined
)) {
  throw new HttpError(
    409,
    'VARIANT_REPLACEMENT_REQUIRED',
    'Deleting this Variant requires a replacement and current Endpoint revision',
  );
}
```

If either replacement field is supplied, require both. Verify the Endpoint revision, then require a different replacement owned by this Endpoint or throw `INVALID_VARIANT_REPLACEMENT`.

Apply fallback reassignment, every matching binding rewrite, Variant removal, one Endpoint revision increment, and one increment per affected state before `publishGeneration()`.

In `updateEndpoint()`, validate a patched `defaultVariantId` before cloning/publishing:

```ts
if (patch.defaultVariantId !== undefined
  && !endpoint.variants.some(variant => variant.id === patch.defaultVariantId)) {
  throw new HttpError(
    422,
    'INVALID_DEFAULT_VARIANT',
    'Fallback Variant must belong to the Endpoint',
  );
}
```

- [ ] **Step 8: Run repository tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/repository/project-repository.test.ts
```

Expected: PASS for advisory impact, old-shape unreferenced deletion, guarded replacement, exact revisions, atomic cleanup, explicit errors, and rollback at every publication boundary.

- [ ] **Step 9: Commit repository integrity if authorized**

```bash
git add \
  packages/server/src/domain/model.ts \
  packages/server/src/repository/project-repository.ts \
  packages/server/src/repository/project-repository.test.ts
```

Then run `git commit -m "feat: publish safe authoring deletions atomically"`.

### Task 4: Deletion Impact HTTP Contracts And Dashboard Client

**Files:**
- Modify: `packages/server/src/routes/admin/endpoints.ts:1-183`
- Modify: `packages/server/src/routes/admin/versioned-core.test.ts:311-755`
- Modify: `packages/dashboard/src/api/types.ts:89-160`
- Modify: `packages/dashboard/src/api/client.ts:122-175`
- Modify: `packages/dashboard/src/api/client.test.ts:55-100`

**Interfaces:**
- Consumes: impact types and `VariantDeleteOptions` from Task 3, `isStablePathSegment`, and repeated-header types from Task 1.
- Produces: two read-only impact routes, conditional Variant delete input, repeated-header create/update validation, and matching dashboard clients.

- [ ] **Step 1: Add failing server route contract tests**

Add tests for exact impact JSON, encoded stable IDs, and these Variant delete bodies:

```ts
await request(app)
  .delete('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_unused')
  .send({ expectedRevision: 3 })
  .expect(204);

await request(app)
  .delete('/api/admin/projects/prj_1/endpoints/ep_1/variants/var_bound')
  .send({
    expectedRevision: 3,
    expectedEndpointRevision: 7,
    replacementVariantId: 'var_replacement',
  })
  .expect(204);
```

Assert a request supplying only one replacement field returns 400, invalid path segments return 400, a missing impact target returns 404, and an impact fetched before another mutation does not weaken the delete revision checks.

Add response-header route tests that create and update `set-cookie: ['one=1', 'two=2']`, reject `[]`, and reject CR/LF injection in every array member.

- [ ] **Step 2: Add failing dashboard client request tests**

Assert exact request paths and bodies:

```ts
await endpointsApi.deletionImpact('prj 1', 'ep/1');
expect(fetch).toHaveBeenCalledWith(
  '/api/admin/projects/prj%201/endpoints/ep%2F1/deletion-impact',
  expect.any(Object),
);

await variantsApi.delete('prj_1', 'ep_1', 'var_1', 3, {
  expectedEndpointRevision: 7,
  replacementVariantId: 'var_2',
});
const [, init] = fetch.mock.calls[0] ?? [];
expect(JSON.parse(String(init?.body))).toEqual({
  expectedRevision: 3,
  expectedEndpointRevision: 7,
  replacementVariantId: 'var_2',
});
```

Retain an assertion that omitted replacement options sends only `{ expectedRevision }`.

- [ ] **Step 3: Run route and client tests and verify RED**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/routes/admin/versioned-core.test.ts
npm run test --workspace=packages/dashboard -- --run \
  src/api/client.test.ts
```

Expected: FAIL because impact routes, array-valued validation, and replacement-aware clients are absent.

- [ ] **Step 4: Add stable route schemas and handlers**

Import `isStablePathSegment` and replace route identifier validation:

```ts
const stableId = z.string().refine(isStablePathSegment, 'Must be a stable ID');
const idParams = z.strictObject({
  projectId: stableId,
  endpointId: stableId.optional(),
  variantId: stableId.optional(),
});
```

Accept scalar or nonempty repeated response values, validating each value with the existing Node validator:

```ts
const responseHeaderValues = z.union([
  responseHeaderValue,
  z.array(responseHeaderValue).min(1),
]);
const responseHeaders = normalizedHeaderRecord(responseHeaderValues);
```

Add the impact handlers before the parameterized GET/delete handlers that could otherwise consume the literal path:

```ts
router.get('/:endpointId/deletion-impact', (req, res) => {
  const { projectId, endpointId } = parseApiInput(idParams, req.params);
  res.json(repository.getEndpointDeletionImpact(projectId, endpointId!));
});

router.get('/:endpointId/variants/:variantId/deletion-impact', (req, res) => {
  const { projectId, endpointId, variantId } = parseApiInput(idParams, req.params);
  res.json(repository.getVariantDeletionImpact(projectId, endpointId!, variantId!));
});
```

Use a strict Variant delete schema with paired optional fields:

```ts
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
```

Pass both optional values to the repository without inventing defaults:

```ts
const {
  expectedRevision,
  expectedEndpointRevision,
  replacementVariantId,
} = parseApiInput(variantDeleteInput, req.body);
await repository.deleteVariant(
  projectId,
  endpointId!,
  variantId!,
  expectedRevision,
  { expectedEndpointRevision, replacementVariantId },
);
```

- [ ] **Step 5: Mirror impact contracts in the dashboard**

Add the exact impact interfaces from Task 3 to dashboard `api/types.ts`. Extend the clients:

```ts
deletionImpact: (projectId: string, endpointId: string, signal?: AbortSignal) =>
  json<EndpointDeletionImpact>(
    `${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/deletion-impact`,
    { signal },
  ),
```

```ts
deletionImpact: (
  projectId: string,
  endpointId: string,
  variantId: string,
  signal?: AbortSignal,
) => json<VariantDeletionImpact>(
  `${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/variants/${segment(variantId)}/deletion-impact`,
  { signal },
),
delete: (
  projectId: string,
  endpointId: string,
  variantId: string,
  expectedRevision: number,
  replacement?: {
    expectedEndpointRevision: number;
    replacementVariantId: string;
  },
) => json<void>(
  `${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/variants/${segment(variantId)}`,
  {
    method: 'DELETE',
    body: JSON.stringify({ expectedRevision, ...replacement }),
  },
),
```

- [ ] **Step 6: Run route and client tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/routes/admin/versioned-core.test.ts
npm run test --workspace=packages/dashboard -- --run \
  src/api/client.test.ts
```

Expected: PASS for stable identifiers, impact payloads, scalar/repeated headers, old and replacement delete shapes, explicit domain codes, and URL encoding.

- [ ] **Step 7: Commit API contracts if authorized**

```bash
git add \
  packages/server/src/routes/admin/endpoints.ts \
  packages/server/src/routes/admin/versioned-core.test.ts \
  packages/dashboard/src/api/types.ts \
  packages/dashboard/src/api/client.ts \
  packages/dashboard/src/api/client.test.ts
```

Then run `git commit -m "feat: expose authoring deletion impact"`.

### Task 5: Ordered Response Header Editor

**Files:**
- Modify: `packages/dashboard/src/components/HeadersTable.tsx`
- Modify: `packages/dashboard/src/components/HeadersTable.test.tsx`
- Modify: `packages/dashboard/src/components/VariantEditor.tsx:46-328`
- Modify: `packages/dashboard/src/components/VariantEditor.test.tsx`

**Interfaces:**
- Consumes: dashboard `ResponseHeaders`, existing Variant metadata save/conflict ownership, and Body Editor draft safeguards.
- Produces: `HeaderRow`, lossless row/record conversion, repeated-header UI, and `VariantPatch.responseHeaders` updates.

- [ ] **Step 1: Add failing pure conversion and table interaction tests**

Cover ordered expansion and case-insensitive grouping:

```ts
expect(responseHeadersToRows({
  'content-type': 'application/json',
  'set-cookie': ['session=one', 'theme=dark'],
}).map(({ name, value }) => ({ name, value }))).toEqual([
  { name: 'content-type', value: 'application/json' },
  { name: 'set-cookie', value: 'session=one' },
  { name: 'set-cookie', value: 'theme=dark' },
]);

expect(responseHeaderRowsToRecord([
  { id: '1', name: 'Set-Cookie', value: 'session=one' },
  { id: '2', name: 'set-cookie', value: 'theme=dark' },
])).toEqual({ 'Set-Cookie': ['session=one', 'theme=dark'] });
```

Assert empty/whitespace names throw `Header name is required`. Render the component and verify two blank rows may coexist, row identity survives editing, and add/edit/remove operations call `onChange` with an ordered `HeaderRow[]`.

- [ ] **Step 2: Add failing Variant editor tests**

Add tests that:

- initialize rows from scalar and repeated values;
- include `responseHeaders` only when the rows changed;
- send ordered arrays for repeated case-insensitive names;
- block save and show `Header name is required` for an empty name;
- preserve edited rows after HTTP 409;
- restore server rows when the existing discard action runs;
- preserve all existing body-load, body-remove, stale-operation, and dirty-draft tests.

Core expected patch:

```ts
expect(variantsApi.update).toHaveBeenCalledWith(
  'prj_1',
  'ep_1',
  'var_1',
  3,
  expect.objectContaining({
    responseHeaders: {
      'Content-Type': 'application/json',
      'Set-Cookie': ['session=one', 'theme=dark'],
    },
  }),
);
```

- [ ] **Step 3: Run component tests and verify RED**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/HeadersTable.test.tsx \
  src/components/VariantEditor.test.tsx
```

Expected: FAIL because `HeadersTable` stores an object and `VariantEditor` has no response-header state.

- [ ] **Step 4: Replace object editing with stable ordered rows**

Export these interfaces and conversions from `HeadersTable.tsx`:

```ts
export interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

export function responseHeadersToRows(headers: ResponseHeaders): HeaderRow[] {
  let index = 0;
  return Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map(item => ({
      id: `persisted-header-${index++}`,
      name,
      value: item,
    })),
  );
}

export function responseHeaderRowsToRecord(rows: HeaderRow[]): ResponseHeaders {
  const canonicalNames = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) throw new Error('Header name is required');
    const normalized = name.toLowerCase();
    const canonical = canonicalNames.get(normalized) ?? name;
    canonicalNames.set(normalized, canonical);
    grouped.set(canonical, [...(grouped.get(canonical) ?? []), row.value]);
  }
  return Object.fromEntries([...grouped].map(([name, values]) => [
    name,
    values.length === 1 ? values[0] : values,
  ]));
}
```

Change props to `rows`, `onChange(rows)`, optional `error`, and `readonly`. Add rows with `crypto.randomUUID()`, update/remove by `row.id`, and display the error below the table.

- [ ] **Step 5: Integrate rows into Variant metadata ownership**

Initialize and reset rows from `variant.responseHeaders`. Compare ordered rows for dirty-state tracking so temporary blank names remain editable. Serialize only inside save, catch conversion errors there, and add the patch only when the rows changed:

```ts
const [headerRows, setHeaderRows] = useState(() =>
  responseHeadersToRows(variant.responseHeaders),
);

const initialHeaderRows = responseHeadersToRows(variant.responseHeaders);
const headersDirty = JSON.stringify(headerRows.map(({ name, value }) => ({ name, value })))
  !== JSON.stringify(initialHeaderRows.map(({ name, value }) => ({ name, value })));

// Inside the save handler, after validating the other metadata:
const currentResponseHeaders = responseHeaderRowsToRecord(headerRows);
if (headersDirty) {
  patch.responseHeaders = currentResponseHeaders;
}
```

Catch only row conversion errors before the API call, render the message, and keep the user's rows. On 409, retain rows exactly as the current body draft is retained. Include header state in the existing `onDirtyChange` registration and discard callback.

- [ ] **Step 6: Run component tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/HeadersTable.test.tsx \
  src/components/VariantEditor.test.tsx
```

Expected: PASS for row identity, ordering, repeat grouping, empty-name validation, no-op omission, conflicts, discards, and existing body behavior.

- [ ] **Step 7: Commit the response editor if authorized**

```bash
git add \
  packages/dashboard/src/components/HeadersTable.tsx \
  packages/dashboard/src/components/HeadersTable.test.tsx \
  packages/dashboard/src/components/VariantEditor.tsx \
  packages/dashboard/src/components/VariantEditor.test.tsx
```

Then run `git commit -m "feat: edit repeated response headers"`.

### Task 6: Multi-Variant Lifecycle In Endpoint Editor

**Files:**
- Create: `packages/dashboard/src/components/NewVariantDialog.tsx`
- Create: `packages/dashboard/src/components/VariantDeleteDialog.tsx`
- Create: `packages/dashboard/src/components/NewVariantDialog.test.tsx`
- Create: `packages/dashboard/src/components/VariantDeleteDialog.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx:6-170`
- Modify: `packages/dashboard/src/components/EndpointEditor.test.tsx`

**Interfaces:**
- Consumes: `variantsApi.create/delete/deletionImpact`, `endpointsApi.update/get`, canonical Endpoint revisions, `VariantDeletionImpact`, and the existing dirty-navigation callback.
- Produces: clone/blank Variant creation, fallback badge/action, replacement-aware deletion, disabled last-Variant deletion, and canonical Endpoint reload after structural mutations.

- [ ] **Step 1: Add failing dialog tests**

`NewVariantDialog` must require a trimmed name, default to clone when a selected Variant exists, support blank, and return:

```ts
export type NewVariantSource = 'clone' | 'blank';

export interface NewVariantDialogResult {
  name: string;
  source: NewVariantSource;
}

export interface NewVariantDialogProps {
  isOpen: boolean;
  selectedVariant?: ResponseVariant;
  loading: boolean;
  onConfirm(result: NewVariantDialogResult): void;
  onCancel(): void;
}
```

`VariantDeleteDialog` must list fallback status and affected App State names, require a candidate when `isFallback || affectedStates.length > 0`, and expose:

```ts
export interface VariantDeleteDialogResult {
  replacementVariantId?: string;
}

export interface VariantDeleteDialogProps {
  isOpen: boolean;
  variant: ResponseVariant;
  impact: VariantDeletionImpact;
  loading: boolean;
  onConfirm(result: VariantDeleteDialogResult): void;
  onCancel(): void;
}
```

Assert confirmation is disabled until required selection exists and that loading disables both dialog mutations.

- [ ] **Step 2: Add failing Endpoint lifecycle tests**

In `EndpointEditor.test.tsx`, prove:

- each Variant is a tab and the canonical fallback has a visible `Fallback` badge;
- `New Variant` defaults to clone and copies description, status, headers, Body Asset ID, and delay;
- blank create sends `{ name, status: 200, responseHeaders: {} }` with no optional fields;
- `Set as fallback` sends the current Endpoint revision and selected Variant ID;
- create/fallback/delete each call `endpointsApi.get` and render its canonical revision/order;
- last-Variant delete is disabled with `Every Endpoint requires a fallback response`;
- referenced/fallback delete sends impact revisions plus replacement ID;
- unreferenced non-fallback delete omits replacement options;
- clone/create/delete/fallback actions go through `onAttemptNavigation` when Endpoint or Variant drafts are dirty;
- a 409 preserves dialogs and current drafts.

Core clone expectation:

```ts
const bodyAssetId = 'a'.repeat(64);
expect(variantsApi.create).toHaveBeenCalledWith('prj_1', 'ep_1', 7, {
  name: 'Copied failure',
  description: 'Original description',
  status: 503,
  responseHeaders: { 'set-cookie': ['one=1', 'two=2'] },
  bodyAssetId: bodyAssetId,
  delayMs: 250,
});
```

- [ ] **Step 3: Run lifecycle tests and verify RED**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/NewVariantDialog.test.tsx \
  src/components/VariantDeleteDialog.test.tsx \
  src/components/EndpointEditor.test.tsx
```

Expected: FAIL because no lifecycle dialogs or structural Variant actions exist.

- [ ] **Step 4: Implement focused dialogs**

Keep each dialog controlled. `NewVariantDialog` owns only name/source inputs. `VariantDeleteDialog` owns only replacement selection and renders `impact.affectedStates` plus `impact.replacementVariants`. Neither dialog calls an API.

The delete requirement is:

```ts
const replacementRequired = impact.isFallback || impact.affectedStates.length > 0;
const canConfirm = !loading && (
  !replacementRequired || replacementVariantId !== undefined
);
```

- [ ] **Step 5: Add canonical reload and mutation guards**

Inside `EndpointEditor`, centralize canonical publication:

```ts
async function refreshCanonicalEndpoint(preferredVariantId?: string): Promise<void> {
  const refreshed = await endpointsApi.get(projectId, currentEndpoint!.id);
  setCurrentEndpoint(refreshed);
  setSelectedVariantId(current => {
    const preferred = preferredVariantId ?? current;
    return refreshed.variants.some(variant => variant.id === preferred)
      ? preferred
      : refreshed.defaultVariantId;
  });
  onSaved(refreshed);
}
```

Build the set of dirty keys from the Endpoint key and `dirtyVariantKey.current`, then route every structural action through `onAttemptNavigation(action, keys)` when nonempty.

- [ ] **Step 6: Implement clone, blank, fallback, and delete**

Construct create inputs without `undefined` fields. Clone arrays with `structuredClone(selectedVariant.responseHeaders)` and reuse `bodyAssetId` as an immutable reference. After create, select the returned Variant ID and reload canonical Endpoint detail.

Set fallback through:

```ts
await endpointsApi.update(
  projectId,
  currentEndpoint.id,
  currentEndpoint.revision,
  { defaultVariantId: selectedVariant.id },
);
await refreshCanonicalEndpoint(selectedVariant.id);
```

For delete, fetch impact immediately before opening the dialog. On confirmation, use `impact.variantRevision`; include replacement options only when selected. Reload detail and select the canonical fallback if the deleted tab was selected.

Use a small `<details>` action menu for `Clone Variant`, conditional `Set as fallback`, and `Delete Variant`. Keep the visible `New Variant` action next to the tab list.

- [ ] **Step 7: Run lifecycle tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/NewVariantDialog.test.tsx \
  src/components/VariantDeleteDialog.test.tsx \
  src/components/EndpointEditor.test.tsx \
  src/components/VariantEditor.test.tsx
```

Expected: PASS for clone/blank/fallback/delete, canonical reload, impact revisions, last-Variant defense, dirty guards, conflict retention, and body/header editing.

- [ ] **Step 8: Commit Variant lifecycle UI if authorized**

```bash
git add \
  packages/dashboard/src/components/NewVariantDialog.tsx \
  packages/dashboard/src/components/NewVariantDialog.test.tsx \
  packages/dashboard/src/components/VariantDeleteDialog.tsx \
  packages/dashboard/src/components/VariantDeleteDialog.test.tsx \
  packages/dashboard/src/components/EndpointEditor.tsx \
  packages/dashboard/src/components/EndpointEditor.test.tsx
```

Then run `git commit -m "feat: add multi-variant authoring"`.

### Task 7: Safe Endpoint And App State Deletion

**Files:**
- Modify: `packages/dashboard/src/components/ConfirmDialog.tsx:7-118`
- Create: `packages/dashboard/src/components/ConfirmDialog.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx:6-170`
- Modify: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Modify: `packages/dashboard/src/components/AppStateEditor.tsx:5-99`
- Modify: `packages/dashboard/src/components/AppStateEditor.test.tsx`
- Modify: `packages/dashboard/src/hooks/useEndpoints.ts:5-225`
- Modify: `packages/dashboard/src/hooks/useStates.ts:5-157`
- Modify: `packages/dashboard/src/hooks/versioned-core-hooks.test.tsx`
- Modify: `packages/dashboard/src/App.tsx:80-273`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: Endpoint deletion impact, current `Project.activeStateId/baseStateId`, existing deletion clients, publication ownership, and dirty navigation.
- Produces: impact-aware Endpoint deletion, stable/copyable App State IDs, selection-aware App State deletion, owner-safe detail reloads, and canonical cross-list refresh.

- [ ] **Step 1: Add failing dialog and editor tests**

Extend `ConfirmDialog` with `loading` and `confirmDisabled`, and test that both buttons are disabled while a mutation owns the dialog.

Endpoint deletion tests must show every affected state name from impact and call:

```ts
expect(endpointsApi.delete).toHaveBeenCalledWith('prj_1', 'ep_1', 4);
```

App State tests must assert:

- stable ID text and `Copy App State ID` action;
- clipboard receives the unchanged ID after rename;
- automation guidance names `/setMockServerflags`;
- the warning always says external iOS/Android references cannot be discovered;
- Active, Base, both, and neither selection labels are accurate;
- deletion uses the current state revision;
- HTTP 409 preserves the editor and warning.

Stub the clipboard per test:

```ts
const writeText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText } });
```

- [ ] **Step 2: Add failing hook ownership and App orchestration tests**

Add `reloadSelected()` tests to both hook suites. Start two reloads, resolve the older one last, and assert it cannot publish into a newer Project/selection/detail generation.

In `App.test.tsx`, assert successful Endpoint deletion:

- closes and clears the Endpoint editor;
- refreshes Endpoint summaries;
- refreshes App State summaries;
- reloads the currently selected App State detail.

Assert successful App State deletion:

- clears state selection;
- refreshes App State summaries;
- calls `refreshProjects()` so Active/Base and Project revision are canonical.

- [ ] **Step 3: Run deletion UI tests and verify RED**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/ConfirmDialog.test.tsx \
  src/components/EndpointEditor.test.tsx \
  src/components/AppStateEditor.test.tsx \
  src/hooks/versioned-core-hooks.test.tsx \
  src/App.test.tsx
```

Expected: FAIL because delete controls, stable ID copy, detail reload APIs, and structural refresh orchestration are absent.

- [ ] **Step 4: Add owner-safe selected-detail reloads**

Add to both hook result interfaces:

```ts
reloadSelected(): Promise<void>;
```

For Endpoints, capture `beginEndpointPublication()` before the request, own an AbortController, and publish only with that token:

```ts
const reloadSelected = useCallback(async () => {
  const publication = beginEndpointPublication();
  if (!projectId || !publication.selectedEndpointId) return;
  detailControllerRef.current?.abort();
  const controller = new AbortController();
  detailControllerRef.current = controller;
  try {
    const endpoint = await endpointsApi.get(
      projectId,
      publication.selectedEndpointId,
      controller.signal,
    );
    if (detailControllerRef.current !== controller) return;
    publishEndpoint(publication, endpoint);
  } catch (error) {
    if (!isAbort(error) && detailControllerRef.current === controller) {
      setState(current => current.projectId === projectId
        && current.generation === generation
        ? { ...current, error: clientError(error, 'Failed to reload endpoint') }
        : current);
    }
  } finally {
    if (detailControllerRef.current === controller) {
      detailControllerRef.current = null;
    }
  }
}, [beginEndpointPublication, projectId, publishEndpoint]);
```

For App States, add `const detailGenerationRef = useRef(0)`, increment it at the start of `selectState`, and implement reload without clearing visible detail:

```ts
const reloadSelected = useCallback(async () => {
  const selectedStateId = state.projectId === projectId
    && state.generation === generation
    ? state.selectedStateId
    : undefined;
  if (!projectId || !selectedStateId) return;

  const requestGeneration = ++detailGenerationRef.current;
  detailControllerRef.current?.abort();
  const controller = new AbortController();
  detailControllerRef.current = controller;
  setState(current => current.projectId === projectId
    && current.generation === generation
    && current.selectedStateId === selectedStateId
    ? { ...current, detailLoading: true, error: undefined }
    : current);
  try {
    const selectedState = await statesApi.get(projectId, selectedStateId, controller.signal);
    if (detailControllerRef.current !== controller
      || detailGenerationRef.current !== requestGeneration) return;
    setState(current => current.projectId === projectId
      && current.generation === generation
      && current.selectedStateId === selectedStateId
      ? { ...current, selectedState }
      : current);
  } catch (error) {
    if (!isAbort(error) && detailControllerRef.current === controller) {
      setState(current => current.projectId === projectId
        && current.generation === generation
        && current.selectedStateId === selectedStateId
        ? { ...current, error: clientError(error, 'Failed to reload state') }
        : current);
    }
  } finally {
    if (detailControllerRef.current === controller) {
      detailControllerRef.current = null;
      setState(current => current.projectId === projectId
        && current.generation === generation
        && current.selectedStateId === selectedStateId
        ? { ...current, detailLoading: false }
        : current);
    }
  }
}, [generation, projectId, state.generation, state.projectId, state.selectedStateId]);
```

- [ ] **Step 5: Implement Endpoint deletion and multi-backend copy**

Add `onDeleted(endpointId: string): void` to `EndpointEditorProps`. The Endpoint actions menu fetches impact, renders affected state names in `ConfirmDialog`, and deletes with `impact.endpointRevision`.

Add this helper copy below the optional host input:

```tsx
<p className="mt-1 text-xs text-gray-500">
  Set a host to select one backend service. Different Endpoints can use different
  hosts. Leave this empty to match the same request on any intercepted host.
</p>
```

Run delete through the same Endpoint/Variant dirty-key guard used by Task 6.

- [ ] **Step 6: Implement App State identity and guarded deletion**

Pass the current `Project`, `onDeleted`, and `onAttemptNavigation` into `AppStateEditor`. Derive selection text without server calls:

```ts
const active = project.activeStateId === state.id;
const base = project.baseStateId === state.id;
const selectionLabel = active && base
  ? 'Active and Base'
  : active
    ? 'Active'
    : base
      ? 'Base'
      : 'Neither Active nor Base';
```

Render the stable ID in `<code>`, copy with `navigator.clipboard.writeText(state.id)`, show automation guidance, and delete through `statesApi.delete(state.projectId, state.id, state.revision)`. The confirmation message includes `selectionLabel` and the external-reference warning. Route the action through the current draft key before opening the dialog.

- [ ] **Step 7: Coordinate canonical refresh in `AppContent`**

After Endpoint deletion:

```ts
const handleEndpointDeleted = async () => {
  endpoints.selectEndpoint(undefined);
  setEndpointEditorOpen(false);
  await Promise.all([endpoints.refresh(), states.refresh()]);
  await states.reloadSelected();
};
```

After App State deletion:

```ts
const handleStateDeleted = async (stateId: string) => {
  if (states.selectedStateId === stateId) states.selectState(undefined);
  await Promise.all([states.refresh(), refreshProjects()]);
};
```

Pass `activeProject`, deletion callbacks, and `onAttemptNavigation` into editors. Preserve stale publication and dirty-draft protections already used for save/navigation.

- [ ] **Step 8: Run deletion UI tests and verify GREEN**

Run:

```bash
npm run test --workspace=packages/dashboard -- --run \
  src/components/ConfirmDialog.test.tsx \
  src/components/EndpointEditor.test.tsx \
  src/components/AppStateEditor.test.tsx \
  src/hooks/versioned-core-hooks.test.tsx \
  src/App.test.tsx
```

Expected: PASS for dependency disclosure, stable IDs, accurate selection warnings, conflict retention, detail ownership, and all required canonical refreshes.

- [ ] **Step 9: Commit safe deletion UI if authorized**

```bash
git add \
  packages/dashboard/src/components/ConfirmDialog.tsx \
  packages/dashboard/src/components/ConfirmDialog.test.tsx \
  packages/dashboard/src/components/EndpointEditor.tsx \
  packages/dashboard/src/components/EndpointEditor.test.tsx \
  packages/dashboard/src/components/AppStateEditor.tsx \
  packages/dashboard/src/components/AppStateEditor.test.tsx \
  packages/dashboard/src/hooks/useEndpoints.ts \
  packages/dashboard/src/hooks/useStates.ts \
  packages/dashboard/src/hooks/versioned-core-hooks.test.tsx \
  packages/dashboard/src/App.tsx \
  packages/dashboard/src/App.test.tsx
```

Then run `git commit -m "feat: add safe endpoint and state deletion"`.

### Task 8: Mobile Automation Acceptance And Full Regression Gate

**Files:**
- Modify: `packages/server/src/integration/versioned-core.integration.test.ts`
- Verify without behavior changes: `packages/server/src/routes/automation.ts`
- Verify: all files changed in Tasks 1-7

**Interfaces:**
- Consumes: canonical Variant APIs, repeated headers, App State bindings, atomic replacement, both automation verbs, direct mock serving, and active workspace Project behavior.
- Produces: end-to-end proof that external sequential mobile suites select stable App State IDs and immediately receive newly published responses.

- [ ] **Step 1: Add the failing automation acceptance test**

Use the existing integration helpers to create two body assets, one Endpoint with two Variants, and one App State bound to the first Variant. Select the Project, then exercise `PUT`, preserving the historical HTTP 204 success response:

```ts
await request(app)
  .put('/setMockServerflags')
  .send({ projectId, stateId, clearTraffic: true })
  .expect(204);

const first = await request(app)
  .get('/mobile/profile')
  .buffer(true)
  .parse(binaryParser)
  .expect(201);
expect(first.headers['set-cookie']).toEqual(['session=one', 'theme=dark']);
expect(first.body).toEqual(Buffer.from('first body'));
```

Delete the bound Variant through the canonical replacement API, using current Variant and Endpoint revisions. Then exercise `POST` while omitting `projectId`, again preserving HTTP 204:

```ts
await request(app)
  .post('/setMockServerflags')
  .send({ stateId })
  .expect(204);

const second = await request(app)
  .get('/mobile/profile')
  .buffer(true)
  .parse(binaryParser)
  .expect(202);
expect(second.headers['set-cookie']).toEqual(['session=replaced', 'theme=light']);
expect(second.body).toEqual(Buffer.from('replacement body'));
```

Assert the App State stable ID did not change. Add an unknown-state request that expects the existing clear not-found code and verify a subsequent mock request still resolves using the previously valid state rather than silently selecting another state.

- [ ] **Step 2: Run the integration test and verify RED or expose a missing seam**

Run:

```bash
npm run test:integration --workspace=packages/server -- \
  src/integration/versioned-core.integration.test.ts
```

Expected before all prior tasks are present: FAIL at repeated headers or canonical replacement. If it passes after Tasks 1-7, retain it as an acceptance test and continue; its value is cross-subsystem coverage, while each production change already had a focused RED test.

- [ ] **Step 3: Make only acceptance-driven corrections**

If the test identifies a real integration mismatch, fix the narrow boundary that contradicts the approved contract. Do not alter `/setMockServerflags` payloads, add caller revisions, introduce client-scoped state, or bypass repository publication.

- [ ] **Step 4: Run focused authoring suites**

Run:

```bash
npm run test --workspace=packages/server -- --run \
  src/domain/schemas.test.ts \
  src/repository/compile-project.test.ts \
  src/repository/project-repository.test.ts \
  src/services/response-writer.test.ts \
  src/services/logger.test.ts \
  src/services/proxy-handler.test.ts \
  src/services/proxy-server.test.ts \
  src/routes/admin/versioned-core.test.ts \
  src/routes/admin/repository-integrations.test.ts
npm run test:integration --workspace=packages/server -- \
  src/integration/versioned-core.integration.test.ts
npm run test --workspace=packages/dashboard -- --run \
  src/api/client.test.ts \
  src/components/ConfirmDialog.test.tsx \
  src/components/HeadersTable.test.tsx \
  src/components/VariantEditor.test.tsx \
  src/components/NewVariantDialog.test.tsx \
  src/components/VariantDeleteDialog.test.tsx \
  src/components/EndpointEditor.test.tsx \
  src/components/AppStateEditor.test.tsx \
  src/components/TrafficView.test.tsx \
  src/hooks/versioned-core-hooks.test.tsx \
  src/App.test.tsx
```

Expected: every focused suite passes with zero failures.

- [ ] **Step 5: Run full regression, lint, build, and diff checks**

Run:

```bash
npm test
npm run test:integration:server
npm run lint
npm run build
```

Then run `git diff --check`; expected exit code is 0 with no whitespace errors.

Expected: all commands exit 0. The build must compile both dashboard and server distributions.

- [ ] **Step 6: Refresh Graphify and inspect final scope**

Run:

```bash
graphify update .
git status --short
```

Then run `git diff --stat` and confirm every changed path belongs to this plan or was pre-existing unrelated work.

Expected: Graphify update exits 0; only authoring-foundation implementation/tests/docs and expected generated graph metadata are changed. Do not stage generated graph output.

- [ ] **Step 7: Commit acceptance coverage if authorized**

```bash
git add packages/server/src/integration/versioned-core.integration.test.ts
```

Then run `git commit -m "test: preserve mobile state automation"`.

## Completion Evidence

Before reporting completion, record the fresh output for:

```text
Focused server tests: passing file/test counts
Focused dashboard tests: passing file/test counts
Server integration tests: passing file/test counts
Full npm test: passing workspace/test counts
Lint: exit 0
Build: exit 0
git diff --check: exit 0
graphify update .: exit 0
```

Also manually inspect the final diff against `docs/superpowers/specs/2026-08-29-mockmate-authoring-foundation-design.md` and confirm every Goal, Error Handling rule, Refresh rule, and Testing Strategy item has a corresponding implementation and assertion.
