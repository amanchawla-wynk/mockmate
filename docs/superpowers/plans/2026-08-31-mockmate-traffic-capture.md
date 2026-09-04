# MockMate Traffic Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver schema-v4 multi-origin Endpoint matching, authority-safe mock/passthrough routing, bounded Project-owned Traffic with exact optional body capture, exact-body inspection, and atomic state-aware `Mock This` promotion.

**Architecture:** Cut the canonical repository, server contracts, dashboard mirrors, and all fixtures directly from schema v3 to schema v4 before adding behavior. Route proxy and direct requests through one authority-first decision and Traffic outcome pipeline; stream application bytes independently from bounded preview and exact-capture sidecars into a Project-scoped ephemeral cache. Keep permanent publication in the existing one-generation repository queue, add streaming Body Store staging and append-only Variant receipts, and let the dashboard consume bounded metadata plus raw body streams through an owner-safe shared document cache and CodeMirror 6 surface.

**Tech Stack:** TypeScript, Node.js 20 streams/HTTP/HTTPS/crypto/filesystem primitives, Express 4, Zod 4, React 19.2, Vite 7, Tailwind CSS 4, CodeMirror 6, Vitest, Testing Library, Supertest, Playwright Chromium, immutable generation storage.

## Global Constraints

- Implementation starts from intentionally dirty HEAD `f43c50e`. Preserve every existing Authoring Foundation and Import Preview change; never revert, overwrite, stage, or commit unrelated work.
- Schema version `4` is a direct cutover. Retain no schema-v3 reader, migration, compatibility adapter, legacy fixture, or dual-shape API.
- `Project.baseUrl`, `matcher.host`, `passthroughEnabled`, `/logs`, `LogsView`, `useLogs`, the old captured-mock/create-mock path, hostname-only Import identity, and stale setup guidance must be absent at completion.
- `Project` stores `appStateMode: 'enabled' | 'disabled'`; disabled mode retains configured active/base IDs but ignores both bindings and uses fallback reason `app_state_mode_disabled` before Endpoint fallback.
- Every Endpoint has one required normalized HTTP/HTTPS origin in `baseUrl`, a complete method/path/query/header matcher, `mode: 'mock' | 'passthrough'`, and an optional fallback only where schema-v4 mode invariants allow it.
- Query parsing splits raw text on `&`, ignores empty segments, splits each field at its first `=`, maps `+` to space, then percent-decodes valid UTF-8. Raw non-ASCII, malformed escapes, and invalid UTF-8 produce `query_parse_invalid`; names are case-sensitive and no Unicode/case/whitespace/numeric normalization occurs.
- Query constraints are repeated-expression multisets. Every configured expression must match a distinct incoming occurrence through deterministic bipartite injective matching; extra incoming occurrences are allowed. Canonical arrays sort by operator then value using JavaScript code-unit order while preserving duplicate count.
- Authority errors are exact: `400 PROXY_AUTHORITY_INVALID`, `400 PROXY_CONNECT_AUTHORITY_MISMATCH`, `400 PROXY_HOST_AUTHORITY_MISMATCH`, and `400 DIRECT_ORIGIN_INVALID`. Invalid authorities are never forwarded.
- Canonical Traffic routes are exactly `GET /api/admin/projects/:projectId/traffic`, `GET /api/admin/projects/:projectId/traffic/:trafficId`, `DELETE /api/admin/projects/:projectId/traffic`, `GET /api/admin/projects/:projectId/traffic/:trafficId/bodies/request`, `GET /api/admin/projects/:projectId/traffic/:trafficId/bodies/response`, `POST /api/admin/projects/:projectId/traffic/:trafficId/mock`, and `GET /api/admin/projects/:projectId/interception-guidance`.
- Retain the newest `500` Traffic rows per Project. Traffic is runtime-owned, Project-scoped, cursor/incremental, ephemeral across restart, and never backed by a module-level global array.
- The bounded preview is always at most `16 KiB` and remains independent of exact-body descriptor state.
- The complete-body limit is `50 MiB` inclusive. Exact capture uses at most a `1 MiB` in-memory queue per active sidecar and never blocks or fails application delivery.
- Aggregate capture defaults are fixed and injectable only for tests: `32` active sidecars and `32 MiB` queued bytes per Project; `128` active sidecars and `128 MiB` queued bytes per process; `1 GiB` operation-owned in-progress files per Project; `2 GiB` in-progress files per process.
- Retained exact-body defaults are `1 GiB` physical unique bytes per Project and `4 GiB` per process. The process never evicts another Project's evidence; exhausted process admission records `retained_budget_exceeded`.
- Capture stores HTTP entity bytes after transfer framing and before `Content-Encoding` decoding. Exact body APIs omit `Content-Encoding`, set `X-MockMate-Original-Content-Encoding`, exact `Content-Length`, digest metadata, request ID, and attachment disposition for Download.
- `captureRawTraffic` is off for new Projects. When off, request and response descriptors are `unavailable` with `raw_capture_disabled`, including mock assets, bodyless responses, and verified zero-byte bodies; previews and metadata still record.
- Body descriptors use only the exact discriminated union in Task 5. A verified zero-byte body is available only when capture is enabled and uses SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Body cache references are row-generation-owned. Clear/retention tombstones a generation; finalization cannot resurrect it. Active stream, Download, and promotion operations hold digest-owned leases released exactly once.
- Promotion receipt identity is Traffic ID + Traffic generation + response identity + Endpoint target identity + State target identity, explicitly excluding expected revisions. Replay checks exact/conflicting canonical receipts before requiring a live Traffic row.
- Promotion follows the exact 16-step ordering in Task 8, publishes one generation/pointer/memory update, stages no 50 MiB `Buffer`, and preserves failure atomicity. After pointer publication, response loss is an unknown outcome and dashboard recovery performs GET-only canonical refresh.
- Body Assets remain immutable SHA-256 byte identities. Equal bytes with conflicting normalized media type or ordered encoding metadata return `409 ASSET_METADATA_CONFLICT`.
- Credential request headers, URL user information, password/token-like query values, and sensitive response-header values are masked in Traffic, promotion review, diagnostics, errors, and logs. The only exception is trusted loopback Endpoint configuration APIs/editors, which return exact authored matcher values; confirmed promotion persists exact hidden query values and exact sensitive response behavior after explicit warnings.
- Debug provenance headers are off by default, mock-only, reserved from user override, and contain IDs/reasons only: `X-MockMate-Project`, `X-MockMate-Endpoint`, `X-MockMate-Variant`, `X-MockMate-State`, `X-MockMate-Resolution-Source`, `X-MockMate-Fallback-Reason`, and `X-MockMate-Request-Id`.
- `BodyDocumentCache` permits at most `2` concurrent full-body loads and retains at most `12` clean documents or `256 MiB`, whichever is reached first. It never evicts the active document or dirty mock drafts.
- CodeMirror large-body mode begins above `1 MiB`, disables wrapping and expensive syntax parsing, and explains the policy. Binary or content-encoded Traffic never enters text decoding or CodeMirror.
- Chromium gates are exact: a `10 MiB` editable mock body becomes interactive within `400 ms`; after readiness, measured scroll/type/undo/full-document search/Worker validation/format publication has no Long Task over `50 ms`; a `50 MiB` Traffic body is judged on responsiveness/progress rather than total load time.
- Preserve stable IDs, optimistic revisions, immutable Body Assets, one queued generation publication, repeated response headers, owner-safe layout-commit invalidation, dirty guards, one mutation owner, stale callback rejection, and post-commit unknown-outcome recovery.
- Capture, cache, route, and repository errors expose no filesystem path, credential, raw body, stack trace, or upstream secret. Cleanup failure never replaces the initiating error.
- Use strict RED/GREEN: production behavior follows a focused test that failed for the named reason. Every task gets a fresh focused diff review before continuing.
- No task stages or commits by default. A commit checkpoint is optional only after explicit user authorization, must stage only a separately reviewed Slice 3 patch against Task 0's baseline, and is ineligible unless every dependency is already committed or included coherently. Checkpoints never run whole-file/path-based `git add`; if Slice 3 hunks cannot be separated from protected baseline hunks, defer the whole checkpoint unless the user separately authorizes those exact baseline hunks. Never partially commit an atomic cluster.
- Before Task 1, complete Task 0's external baseline archive. Use baseline-to-current diffs for every review so Slice 3 hunks are distinguishable from the intentionally dirty starting work. If a listed file contains pre-Slice-3 hunks, whole-file staging is prohibited unless the user separately authorizes those exact baseline hunks. Never use stash/reset/checkout to manufacture a clean tree.
- Tasks 2-7 are one atomic direct-cutover cluster: focused RED/GREEN tests and subtask reviews still run at each boundary, but no intermediate full-build claim or commit checkpoint is allowed while schema-v3 consumers are being replaced. The first full `npm run build` and optional cutover-cluster commit occur only at Task 7 GREEN.
- Dashboard CodeMirror dependencies are exactly `@codemirror/commands`, `@codemirror/lang-json`, `@codemirror/language`, `@codemirror/search`, `@codemirror/state`, and `@codemirror/view`. Add root `@playwright/test` only when Task 15 creates the Chromium harness.
- `package.json` manifests are tracked. `package-lock.json` exists but remains ignored under current repository policy; do not change `.gitignore` without explicit user authorization and never stage the ignored lockfile.
- Run `graphify update .` only at the final completion gate after all implementation reviews; never stage `graphify-out/`.

---

### Task 0: Capture The External Dirty Baseline

- [ ] **Step 1: Archive worktree and index evidence outside the repository**

Run from the repository root in one shell and retain the printed path for every later review:

```bash
set -euo pipefail
export SLICE3_BASELINE_DIR="${MOCKMATE_SLICE3_BASELINE_DIR:-$HOME/.local/state/mockmate/slice3-baseline-2026-08-31}"
test "${SLICE3_BASELINE_DIR#/}" != "$SLICE3_BASELINE_DIR"
export SLICE3_BASELINE_DIR="$(node - "$SLICE3_BASELINE_DIR" "$PWD" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
let cursor = path.resolve(process.argv[2]);
const suffix = [];
while (!fs.existsSync(cursor)) {
  suffix.unshift(path.basename(cursor));
  const parent = path.dirname(cursor);
  if (parent === cursor) process.exit(1);
  cursor = parent;
}
const candidate = path.join(fs.realpathSync(cursor), ...suffix);
const repository = fs.realpathSync(process.argv[3]);
if (candidate === repository || candidate.startsWith(repository + path.sep)) process.exit(1);
process.stdout.write(candidate);
NODE
)"
test ! -e "$SLICE3_BASELINE_DIR"
test "$(git rev-parse --short=7 HEAD)" = "f43c50e"
mkdir -p "$SLICE3_BASELINE_DIR"
baseline_complete=0
trap 'if test "$baseline_complete" -ne 1; then rm -rf "$SLICE3_BASELINE_DIR"; fi' EXIT
printf '%s\n' "$SLICE3_BASELINE_DIR" > "$SLICE3_BASELINE_DIR/LOCATION.txt"
git rev-parse HEAD > "$SLICE3_BASELINE_DIR/head.txt"
git status --porcelain=v1 -z > "$SLICE3_BASELINE_DIR/status.zlist"
git diff --binary > "$SLICE3_BASELINE_DIR/worktree.patch"
git diff --cached --binary > "$SLICE3_BASELINE_DIR/index.patch"
git diff --name-only --diff-filter=D -z > "$SLICE3_BASELINE_DIR/deleted-paths.zlist"
git archive --format=tar HEAD > "$SLICE3_BASELINE_DIR/head.tar"
git ls-files -co --exclude-standard -z \
  | while IFS= read -r -d '' path; do
      if test -e "$path" || test -L "$path"; then printf '%s\0' "$path"; fi
    done > "$SLICE3_BASELINE_DIR/existing-paths.zlist"
tar --null -T "$SLICE3_BASELINE_DIR/existing-paths.zlist" \
  -cf "$SLICE3_BASELINE_DIR/worktree-existing.tar"
tar -tf "$SLICE3_BASELINE_DIR/head.tar" > /dev/null
tar -tf "$SLICE3_BASELINE_DIR/worktree-existing.tar" > "$SLICE3_BASELINE_DIR/archived-paths.txt"
git rev-parse HEAD > "$SLICE3_BASELINE_DIR/head.after.txt"
git status --porcelain=v1 -z > "$SLICE3_BASELINE_DIR/status.after.zlist"
git diff --binary > "$SLICE3_BASELINE_DIR/worktree.after.patch"
git diff --cached --binary > "$SLICE3_BASELINE_DIR/index.after.patch"
git diff --name-only --diff-filter=D -z > "$SLICE3_BASELINE_DIR/deleted-paths.after.zlist"
git ls-files -co --exclude-standard -z \
  | while IFS= read -r -d '' path; do
      if test -e "$path" || test -L "$path"; then printf '%s\0' "$path"; fi
    done > "$SLICE3_BASELINE_DIR/existing-paths.after.zlist"
tar --null -T "$SLICE3_BASELINE_DIR/existing-paths.after.zlist" \
  -cf "$SLICE3_BASELINE_DIR/worktree-existing.after.tar"
cmp "$SLICE3_BASELINE_DIR/head.txt" "$SLICE3_BASELINE_DIR/head.after.txt"
cmp "$SLICE3_BASELINE_DIR/status.zlist" "$SLICE3_BASELINE_DIR/status.after.zlist"
cmp "$SLICE3_BASELINE_DIR/worktree.patch" "$SLICE3_BASELINE_DIR/worktree.after.patch"
cmp "$SLICE3_BASELINE_DIR/index.patch" "$SLICE3_BASELINE_DIR/index.after.patch"
cmp "$SLICE3_BASELINE_DIR/deleted-paths.zlist" "$SLICE3_BASELINE_DIR/deleted-paths.after.zlist"
cmp "$SLICE3_BASELINE_DIR/existing-paths.zlist" "$SLICE3_BASELINE_DIR/existing-paths.after.zlist"
cmp "$SLICE3_BASELINE_DIR/worktree-existing.tar" "$SLICE3_BASELINE_DIR/worktree-existing.after.tar"
rm "$SLICE3_BASELINE_DIR"/*.after.*
shasum -a 256 "$SLICE3_BASELINE_DIR/head.txt" \
  "$SLICE3_BASELINE_DIR/status.zlist" \
  "$SLICE3_BASELINE_DIR/worktree.patch" \
  "$SLICE3_BASELINE_DIR/index.patch" \
  "$SLICE3_BASELINE_DIR/deleted-paths.zlist" \
  "$SLICE3_BASELINE_DIR/head.tar" \
  "$SLICE3_BASELINE_DIR/existing-paths.zlist" \
  "$SLICE3_BASELINE_DIR/worktree-existing.tar" \
  "$SLICE3_BASELINE_DIR/archived-paths.txt" \
  "$SLICE3_BASELINE_DIR/LOCATION.txt" \
  > "$SLICE3_BASELINE_DIR/SHA256SUMS"
baseline_complete=1
trap - EXIT
printf '%s\n' "$SLICE3_BASELINE_DIR"
```

Expected: `head.txt` contains `f43c50e`; `head.tar` preserves committed HEAD, `worktree-existing.tar` contains every existing tracked and non-ignored untracked starting file, `status.zlist` preserves porcelain status with NUL-delimited paths, and `deleted-paths.zlist` records tracked deletions without asking `tar` to read missing paths. The second HEAD/status/patch/path/archive capture must byte-match the first or the trap removes the incomplete baseline and fails, detecting concurrent worktree/index changes. Fail-fast evidence, location, and hashes are in a durable user-owned directory outside the repository, not an OS-cleaned temporary directory. If the shell/session changes, restore `SLICE3_BASELINE_DIR` from `LOCATION.txt` before review. Do not stage or commit this evidence.

- [ ] **Step 2: Verify the baseline is readable and the index is untouched**

Run:

```bash
test -s "$SLICE3_BASELINE_DIR/status.zlist"
test -s "$SLICE3_BASELINE_DIR/head.tar"
test -s "$SLICE3_BASELINE_DIR/worktree-existing.tar"
test -s "$SLICE3_BASELINE_DIR/existing-paths.zlist"
test -s "$SLICE3_BASELINE_DIR/archived-paths.txt"
test "$(cat "$SLICE3_BASELINE_DIR/LOCATION.txt")" = "$SLICE3_BASELINE_DIR"
shasum -a 256 -c "$SLICE3_BASELINE_DIR/SHA256SUMS"
git diff --cached --quiet
```

Expected: all commands exit 0. Every later focused review compares the current file/archive member with this baseline, and every authorized checkpoint first proves the intended commit is dependency-complete and excludes baseline-only hunks. Before every dependent review or commit checkpoint, restore `SLICE3_BASELINE_DIR`, verify its external absolute location, and rerun `shasum -a 256 -c "$SLICE3_BASELINE_DIR/SHA256SUMS"`; stop if any original baseline artifact is missing or changed.

### Task 1: Pure Origin, Query, Interception, Metadata, And Redaction Primitives

**Files:**
- Create: `packages/server/src/domain/http-origin.ts`
- Create: `packages/server/src/domain/http-origin.test.ts`
- Create: `packages/server/src/domain/query-matcher.ts`
- Create: `packages/server/src/domain/query-matcher.test.ts`
- Create: `packages/server/src/domain/http-metadata.ts`
- Create: `packages/server/src/domain/http-metadata.test.ts`
- Create: `packages/server/src/domain/traffic-redaction.ts`
- Create: `packages/server/src/domain/traffic-redaction.test.ts`
- Modify: `packages/server/src/services/intercept.ts`
- Create: `packages/server/src/services/intercept.test.ts`

**Interfaces:**
- Consumes: existing `MatchExpression`, Node `domainToASCII`, `validateHeaderName`, `createHash`, and injected local-control hostname sets.
- Produces: `NormalizedOrigin`, `normalizeHttpOrigin(input: string): NormalizedOrigin`, `normalizeAuthority(scheme, authority): NormalizedOrigin`, `QueryEntry`, `QueryParseResult`, `parseRawQuery(rawQuery: string): QueryParseResult`, `canonicalizeQueryConstraints(source)`, `queryConstraintsMatch(constraints, entries): boolean`, `normalizeInterceptionPattern(input, localHosts): string`, `normalizeInterceptionPatterns(inputs, localHosts): string[]`, `hostMatchesPattern(pattern, hostname): boolean`, `normalizeMediaType(input): string`, `normalizeContentEncoding(input): string | undefined`, `normalizeResponseHeaders(headers)`, `redactTrafficHeaders(headers)`, and `redactTrafficQuery(entries)`.

- [ ] **Step 1: Write focused RED tests for origin and allowlist normalization**

```ts
it.each([
  ['HTTPS://API.Example.test.:443', 'https://api.example.test'],
  ['http://api.example.test:80/', 'http://api.example.test'],
  ['https://api.example.test:8443', 'https://api.example.test:8443'],
])('normalizes %s', (source, expected) => {
  expect(normalizeHttpOrigin(source).origin).toBe(expected);
});

it.each(['ftp://api.example.test', 'https://user:pass@api.example.test',
  'https://api.example.test/path', 'https://api.example.test?x=1',
  'https://api.example.test#x', 'https://api.example.test:00080'])(
  'rejects non-origin source %s', source => expect(() => normalizeHttpOrigin(source)).toThrow(),
);

expect(normalizeInterceptionPattern('*.EXAMPLE.test.', new Set())).toBe('*.example.test');
expect(hostMatchesPattern('*.example.test', 'a.b.example.test')).toBe(true);
expect(hostMatchesPattern('*.example.test', 'example.test')).toBe(false);
expect(() => normalizeInterceptionPattern('http://api.test', new Set())).toThrow();
expect(() => normalizeInterceptionPattern('localhost', new Set(['localhost']))).toThrow();
expect(() => normalizeInterceptionPatterns(
  ['API.example.test', 'api.example.test.'], new Set(),
)).toThrow();
```

- [ ] **Step 2: Run origin/interception tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/domain/http-origin.test.ts src/services/intercept.test.ts`

Expected: FAIL because the new modules and strict normalizers do not exist.

- [ ] **Step 3: Implement strict origin, authority, IDNA, port, and wildcard normalization**

```ts
export interface NormalizedOrigin {
  origin: string;
  scheme: 'http' | 'https';
  hostname: string;
  port?: number;
  effectivePort: number;
}

export function normalizeHttpOrigin(input: string): NormalizedOrigin;
export function normalizeAuthority(
  scheme: 'http' | 'https',
  authority: string,
): NormalizedOrigin;

export function normalizeInterceptionPattern(
  input: string,
  localHosts: ReadonlySet<string>,
): string;
export function normalizeInterceptionPatterns(
  inputs: readonly string[],
  localHosts: ReadonlySet<string>,
): string[];
```

Use `domainToASCII`, reject an empty conversion, credentials, ambiguous/zero-padded ports, non-root paths, search/hash, local/control hosts, malformed labels, and duplicate normalized patterns in the list normalizer. Preserve only `*` as a wildcard metacharacter; implement the exact apex behavior in the tests. Runtime-settings validation, runtime matching, and guidance must consume the list normalizer rather than independently deduplicating patterns.

- [ ] **Step 4: Write focused RED tests for the shared raw query parser and injective multiset matching**

```ts
it('splits before decoding and preserves repeated/empty fields', () => {
  expect(parseRawQuery('?a&a=&=x&&a=%26%3D&plus=a+b')).toEqual({
    ok: true,
    entries: [
      { name: 'a', value: '' }, { name: 'a', value: '' },
      { name: '', value: 'x' }, { name: 'a', value: '&=' },
      { name: 'plus', value: 'a b' },
    ],
  });
});

it.each(['?bad=%', '?bad=%GG', '?bad=%C3%28', '?raw=é'])(
  'rejects malformed query %s', raw => expect(parseRawQuery(raw)).toEqual({
    ok: false, reason: 'query_parse_invalid',
  }),
);

it('uses an injective assignment instead of greedy source order', () => {
  const constraints = {
    q: [
      { operator: 'glob', value: '*' },
      { operator: 'equals', value: 'fixed' },
    ],
  } as const;
  expect(queryConstraintsMatch(constraints, [
    { name: 'q', value: 'fixed' }, { name: 'q', value: 'other' },
  ])).toBe(true);
  expect(queryConstraintsMatch({ q: [constraints.q[1], constraints.q[1]] }, [
    { name: 'q', value: 'fixed' },
  ])).toBe(false);
});
```

- [ ] **Step 5: Run query tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/domain/query-matcher.test.ts`

Expected: FAIL because `parseRawQuery`, canonical multiset normalization, and bipartite matching are absent.

- [ ] **Step 6: Implement parser, canonicalization, and deterministic bipartite matching**

```ts
export interface QueryEntry { name: string; value: string }
export type QueryParseResult =
  | { ok: true; entries: QueryEntry[] }
  | { ok: false; reason: 'query_parse_invalid' };

export function canonicalizeQueryConstraints(
  source: Readonly<Record<string, readonly MatchExpression[]>> | undefined,
): Record<string, MatchExpression[]> | undefined;

export function queryConstraintsMatch(
  constraints: Readonly<Record<string, readonly MatchExpression[]>> | undefined,
  entries: readonly QueryEntry[],
): boolean;
```

Decode each component with a fatal UTF-8 `TextDecoder`, compare keys and operator/value pairs with explicit code-unit comparison (`left < right`, never locale collation), reject empty expression arrays, normalize `{}` to `undefined`, and use augmenting-path bipartite matching so every expression consumes one distinct occurrence.

- [ ] **Step 7: Write RED tests for media/encoding normalization and redaction**

```ts
expect(normalizeMediaType('Application/JSON; Charset="UTF-8"; profile=Mobile')).toBe(
  'application/json; charset=UTF-8; profile=Mobile',
);
expect(normalizeContentEncoding(' GZip, identity, BR, gzip ')).toBe('gzip, br, gzip');
expect(() => normalizeContentEncoding('gzip,,br')).toThrow();
expect(redactTrafficHeaders([
  ['Authorization', 'Bearer secret'], ['Set-Cookie', 'sid=secret'], ['Accept', 'text/plain'],
])).toEqual([
  ['authorization', '[REDACTED]'], ['set-cookie', '[REDACTED]'], ['accept', 'text/plain'],
]);
expect(redactTrafficQuery([
  { name: 'page', value: '2' }, { name: 'apiToken', value: 'secret' },
])).toEqual([
  { name: 'page', value: '2' }, { name: 'apiToken', value: '[REDACTED]' },
]);
```

- [ ] **Step 8: Run metadata/redaction tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/domain/http-metadata.test.ts src/domain/traffic-redaction.test.ts`

Expected: FAIL because strict token parsing, transport-managed response-header normalization, and Traffic-safe masking are absent.

- [ ] **Step 9: Implement exact metadata and redaction primitives**

`normalizeResponseHeaders` must lowercase names, preserve repeated end-to-end values and source order, and discard `content-length`, `transfer-encoding`, and `content-encoding`. `normalizeMediaType` must reject duplicate parameters, sort parameter names by code unit, and preserve case-sensitive values with canonical quoting/escaping. Redaction must mask `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, and password/token/key/secret-like query names without modifying canonical trusted Endpoint configuration.

- [ ] **Step 10: Run the complete Task 1 GREEN suite**

Run: `npm run test --workspace=packages/server -- --run src/domain/http-origin.test.ts src/domain/query-matcher.test.ts src/domain/http-metadata.test.ts src/domain/traffic-redaction.test.ts src/services/intercept.test.ts`

Expected: PASS with exact IDNA/origin, query edge-case, injective assignment, metadata, redaction, and allowlist assertions.

- [ ] **Step 11: Focused review checkpoint**

Review `git diff -- packages/server/src/domain packages/server/src/services/intercept.ts packages/server/src/services/intercept.test.ts`. Confirm no network/filesystem side effect entered these primitives, every invalid query converges on `query_parse_invalid`, code-unit ordering is explicit, empty constraint objects normalize away, and no secret appears in assertion output.

**Commit checkpoint (Only with explicit user authorization):** regenerate and verify the baseline-to-current evidence, derive/review a Task 1 Slice-3-only patch, and apply only that patch to the index. Defer if it cannot be separated from protected baseline hunks. Then run `git commit -m "feat: add traffic domain primitives"`.

### Task 2: Coherent Schema-V4 Direct Cutover

**Files:**
- Modify: `packages/server/src/domain/model.ts`
- Modify: `packages/server/src/domain/schemas.ts`
- Modify: `packages/server/src/domain/schemas.test.ts`
- Modify: `packages/server/src/domain/fresh-app-scope.test.ts`
- Modify: `packages/server/src/repository/compile-project.ts`
- Modify: `packages/server/src/repository/compile-project.test.ts`
- Modify: `packages/server/src/repository/referential-integrity.ts`
- Modify: `packages/server/src/repository/referential-integrity.test.ts`
- Modify: `packages/server/src/repository/load-project.ts`
- Modify: `packages/server/src/repository/project-repository.ts`
- Modify: `packages/server/src/repository/project-repository.test.ts`
- Create: `packages/server/src/repository/schema-v4-core.test.ts`
- Modify: `packages/server/src/repository/body-store.ts`
- Modify: `packages/server/src/repository/body-store.test.ts`
- Modify: `packages/server/src/repository/static-metadata.ts`
- Modify: `packages/server/src/test-support/project-builder.ts`
- Modify: `packages/server/src/routes/admin/projects.ts`
- Modify: `packages/server/src/routes/admin/endpoints.ts`
- Modify: `packages/server/src/routes/admin/states.ts`
- Modify: `packages/server/src/routes/admin/versioned-core.test.ts`
- Modify: `packages/server/src/routes/admin/repository-integrations.test.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/integration/versioned-core.integration.test.ts`
- Modify: `packages/server/src/performance/large-project-fixture.ts`
- Modify: `packages/server/src/performance/versioned-core.performance.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/api/client.test.ts`
- Modify: `packages/dashboard/src/hooks/versioned-core-hooks.test.tsx`
- Modify: `packages/dashboard/src/components/ProjectModal.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointList.tsx`
- Modify: `packages/dashboard/src/components/EndpointList.test.tsx`
- Modify: `packages/dashboard/src/components/VariantEditor.tsx`
- Modify: `packages/dashboard/src/components/VariantEditor.test.tsx`
- Modify: `packages/dashboard/src/components/AppStateEditor.tsx`
- Modify: `packages/dashboard/src/components/AppStateEditor.test.tsx`
- Modify: `packages/dashboard/src/components/AppStateSwitcher.tsx`
- Modify: `packages/dashboard/src/components/AppStateSwitcher.test.tsx`
- Modify: `packages/dashboard/src/components/UpdateForms.test.tsx`
- Modify: `packages/dashboard/src/components/HookLintRepairs.test.tsx`
- Modify: `packages/dashboard/src/components/PassthroughSettings.tsx`
- Modify: `packages/dashboard/src/components/StaticFilesView.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`
- Modify: `packages/dashboard/src/App.import-integration.test.tsx`

**Interfaces:**
- Consumes: Task 1 `NormalizedOrigin`, `normalizeHttpOrigin`, `QueryParseResult`, `parseRawQuery`, `canonicalizeQueryConstraints`, `queryConstraintsMatch`, `normalizeMediaType`, and `normalizeContentEncoding`.
- Produces: schema-v4 `Project`, `EndpointDetail`, `EndpointSummary`, `ResponseVariant`, `TrafficVariantProvenance`, `BodyAsset`, `ProjectRuntimeSettings`, strict `EndpointCreateInput`, `EndpointModeInput`, `AppStateModeInput`, `RuntimeSettingsUpdateInput`, `MatchRequest`, `CompiledProject`, `EndpointDecision`, `canonicalEndpointIdentity(endpoint)`, `matchRequest(compiled, request)`, `resolveEndpoint(compiled, match)`, and repository mode/settings methods consumed by Tasks 3-13.

- [ ] **Step 1: Write RED schema-v4 and direct-cutover absence tests**

```ts
expect(ProjectSchema.parse({
  schemaVersion: 4, id: 'prj_1', name: 'Project', appStateMode: 'enabled',
  revision: 0, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
})).not.toHaveProperty('baseUrl');
expect(ProjectSchema.safeParse({
  schemaVersion: 3, id: 'prj_1', name: 'Old', appStateMode: 'enabled',
  revision: 0, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
}).success).toBe(false);
expect(EndpointSchema.safeParse({ ...endpointRecord(), matcher: {
  ...endpointRecord().matcher, host: 'api.example.test',
} }).success).toBe(false);
expect(ProjectRuntimeSettingsSchema.safeParse({
  ...settingsRecord(), passthroughEnabled: true,
}).success).toBe(false);
```

Add API tests proving Project create rejects `baseUrl`, Endpoint create requires `baseUrl` and `mode`, all mutation objects reject unknown keys, and persisted generation pointers/workspace/static metadata use `schemaVersion: 4` only. Bind success statuses explicitly: Endpoint create is `201`; full Endpoint update, Endpoint mode update, and Project App State mode update are each `200`.

Place the displayed schema-v3 `safeParse(...).success === false` assertion in exactly one named test, `rejects schema-v3 persisted documents`, so Task 13 can narrowly distinguish this required negative input from forbidden positive fixtures/readers.

- [ ] **Step 2: Run schema/API tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/domain/schemas.test.ts src/routes/admin/versioned-core.test.ts src/routes/admin.test.ts`

Expected: FAIL because schema version remains 3 and old fields are still accepted/required in the wrong owners.

- [ ] **Step 3: Replace central model and strict mutation contracts atomically**

Use these exact core shapes:

```ts
export type SchemaVersion = 4;
export type AppStateMode = 'enabled' | 'disabled';
export type EndpointMode = 'mock' | 'passthrough';

export interface Project {
  schemaVersion: 4;
  id: string;
  name: string;
  description?: string;
  appStateMode: AppStateMode;
  activeStateId?: string;
  baseStateId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EndpointMatcherInput {
  method: string;
  path: string;
  query?: Record<string, MatchExpression[]>;
  headers?: Record<string, MatchExpression>;
}

export interface EndpointDetail {
  schemaVersion: 4;
  id: string;
  projectId: string;
  name: string;
  description?: string;
  baseUrl: string;
  matcher: EndpointMatcherInput;
  mode: EndpointMode;
  defaultVariantId?: string;
  variants: ResponseVariant[];
  revision: number;
}

export interface EndpointSummary {
  schemaVersion: 4;
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  mode: EndpointMode;
  method: string;
  path: string;
  queryConstraintCount: number;
  headerConstraintCount: number;
  variantCount: number;
  mockReady: boolean;
  revision: number;
}

export interface ProjectRuntimeSettings {
  schemaVersion: 4;
  projectId: string;
  interceptHosts: string[];
  captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean;
  revision: number;
}
```

Define `TrafficVariantProvenance` exactly as approved, including immutable `trafficId`, `trafficGeneration`, `responseIdentity`, target/action fields, all created/changed booleans, and optional `stateId`; add `trafficProvenance?: TrafficVariantProvenance[]` to `ResponseVariant`. Normalize Body Asset media type and encoding at every create/load boundary and emit schema version 4.

- [ ] **Step 4: Define strict command types and route schemas**

```ts
export type EndpointCreateInput = {
  name: string; description?: string; baseUrl: string;
  matcher: EndpointMatcherInput; mode: EndpointMode;
  variants?: CreateVariantInput[]; defaultVariantIndex?: number;
};
export type EndpointModeInput = { mode: EndpointMode; expectedRevision: number };
export type AppStateModeInput = {
  appStateMode: AppStateMode; expectedProjectRevision: number;
};
export type RuntimeSettingsUpdateInput = {
  interceptHosts: string[]; captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean; expectedRevision: number;
  confirmInterceptAll?: true;
};
```

Expose `PUT /api/admin/projects/:projectId/endpoints/:endpointId/mode` and `PUT /api/admin/projects/:projectId/app-state-mode`. Keep full Endpoint revisioned update at the existing Endpoint URL. Runtime settings now accept the full strict object, normalize all patterns, require `confirmInterceptAll: true` whenever normalized output contains exact `*`, and never persist the confirmation bit.

**Mandatory internal review boundary A:** Review only the central model/schema and strict route-command slice before continuing. Confirm schema-v3 inputs and unknown keys fail, ownership moved to the approved schema-v4 entities, and no compatibility reader or transient confirmation persistence was introduced. Record findings even though this boundary cannot be committed or full-built independently.

- [ ] **Step 5: Write RED matcher identity, multiset, mode, and App State mode tests**

```ts
expect(canonicalEndpointIdentity(endpointRecord({
  baseUrl: 'HTTPS://API.EXAMPLE.TEST:443/',
  matcher: { method: 'get', path: '/users', query: {
    q: [
      { operator: 'glob', value: 'a*' },
      { operator: 'equals', value: 'alpha' },
      { operator: 'equals', value: 'alpha' },
    ],
  } },
}))).toBe(canonicalEndpointIdentity(endpointRecord({
  baseUrl: 'https://api.example.test',
  matcher: { method: 'GET', path: '/users', query: {
    q: [
      { operator: 'equals', value: 'alpha' },
      { operator: 'equals', value: 'alpha' },
      { operator: 'glob', value: 'a*' },
    ],
  } },
})));

expect(resolveEndpoint(compiledDisabled, match)).toMatchObject({
  kind: 'mock', resolved: {
    resolutionSource: 'endpoint_default',
    fallbackReasons: ['app_state_mode_disabled'],
    selectedStateId: undefined,
  },
});
```

Cover origin-first specificity, same origin/method/path with distinct query/header constraints, duplicate canonical identity `ENDPOINT_IDENTITY_CONFLICT`, repeated expression count, exact/glob overlaps, deterministic stable Endpoint-ID ties, broader mock/specific passthrough, broader passthrough/specific mock, passthrough zero-Variant readiness, dormant binding preservation, and mock fallback requirements.

At the runtime-settings route boundary, assert a normalized `*` without `confirmInterceptAll: true` returns exactly `422 INTERCEPT_ALL_CONFIRMATION_REQUIRED` with a request ID before any repository mutation; the same strict payload with confirmation succeeds, persists no confirmation field, and an unknown key still fails strict validation.

- [ ] **Step 6: Run matcher/referential tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/repository/compile-project.test.ts src/repository/referential-integrity.test.ts src/repository/schema-v4-core.test.ts`

Expected: FAIL because matching still uses optional host and one expression per query name, every Endpoint requires a fallback, and disabled App State mode does not exist.

- [ ] **Step 7: Implement schema-v4 compilation, identity, resolution, and integrity**

```ts
export interface MatchRequest {
  origin: NormalizedOrigin;
  method: string;
  path: string;
  query: QueryParseResult;
  headers: Readonly<Record<string, readonly string[]>>;
}

export type EndpointDecision =
  | { kind: 'passthrough'; endpointId: string; endpointName: string; specificity: number }
  | { kind: 'mock'; endpointId: string; endpointName: string; specificity: number; resolved: ResolvedMock };

export function canonicalEndpointIdentity(endpoint: Pick<
  EndpointDetail, 'baseUrl' | 'matcher'
>): string;
export function matchRequest(
  compiled: CompiledProject, request: MatchRequest,
): CompiledEndpointMatch | null;
export function resolveEndpoint(
  compiled: CompiledProject, match: CompiledEndpointMatch,
): EndpointDecision;
```

Compile exact origin identity before query/header/path rank. Normalize request header names to lowercase, preserve values, count every repeated query expression in specificity, use Task 1 injective matching, and return no match for invalid query input. State coverage includes only mock Endpoints with a valid fallback. Deleting the last passthrough Variant clears fallback only when unreferenced; return `VARIANT_IN_USE` for dormant references and `ENDPOINT_FALLBACK_REQUIRED` for mock/non-ready mode transitions.

- [ ] **Step 8: Convert repository defaults, generations, and all server fixtures to v4**

New Project defaults are:

```ts
const project: Project = {
  schemaVersion: 4, id, name: input.name,
  ...(input.description === undefined ? {} : { description: input.description }),
  appStateMode: 'enabled', revision: 0, createdAt: now, updatedAt: now,
};
const settings: ProjectRuntimeSettings = {
  schemaVersion: 4, projectId: id, interceptHosts: [],
  captureRawTraffic: false, debugProvenanceHeaders: false, revision: 0,
};
```

Update every server fixture in the listed files in the same change so focused schema/core tests do not pass through an incoherent intermediate state. Preserve Import Preview source files and the full `project-repository.test.ts` gate for Task 3: that task converts the Import contracts loaded by the repository before either file may be claimed GREEN. `schema-v4-core.test.ts` owns only non-Import repository defaults, mutations, summaries, and persistence. Tasks 2-3 are an explicit RED/GREEN subcluster inside the larger Tasks 2-7 atomic cutover.

**Mandatory internal review boundary B:** Review only compilation, canonical identity, repository generations, integrity, and server-fixture conversion before dashboard edits. Confirm origin-first multiset matching, deterministic ties, reversible modes, physical Body metadata normalization, and schema-v4-only writes. Fix findings under the focused server gates before crossing this boundary.

- [ ] **Step 9: Write RED dashboard contract and authoring tests**

Assert Project creation has no base URL field, Endpoint authoring requires label `Endpoint base URL`, helper copy says it accepts only an origin, query rows preserve repeated names, headers remain one expression per normalized name, mode toggle retains Variant tabs, passthrough-with-no-Variant displays mock-readiness recovery, and Variant forms contain no request matching fields. Bind Endpoint summaries across repository, route, dashboard mirror, and list rendering: origin, mode, method, path, total repeated query-expression count, normalized header-name count, Variant count, and mock-readiness must all render from the summary without fetching detail.

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts src/components/EndpointEditor.test.tsx src/components/EndpointList.test.tsx src/components/ProjectList.test.tsx src/components/AppStateSwitcher.test.tsx src/components/VariantEditor.test.tsx src/App.test.tsx`

Expected: FAIL because dashboard mirrors and forms still expose Project base URL/optional host and lack mode/App State mode contracts.

- [ ] **Step 10: Cut dashboard contracts, fixtures, and authoring forms to v4**

Mirror server types exactly. Add dashboard script `"typecheck": "tsc -b"`; Endpoint save sends `{ baseUrl, matcher, mode, variants?, defaultVariantIndex? }`; update preserves complete query/header matcher data. Define summary counts as every repeated query expression and every normalized header constraint, `variantCount` as all dormant/active Variants, and `mockReady` as mode-switch readiness (at least one Variant plus valid fallback). Render separate revisioned Endpoint mode and App State mode controls without clearing dormant IDs/bindings. Temporarily cut `PassthroughSettings` to schema-v4 runtime settings so the atomic cluster typechecks until Task 12 replaces it; remove Project-origin assumptions from `StaticFilesView` and use relative local static-file URLs. Convert `HookLintRepairs.test.tsx` and every other listed dashboard fixture. Keep current dirty registrations, mutation ownership, canonical publication tokens, GET-only post-commit recovery, and selected Variant ownership.

- [ ] **Step 11: Run focused server/dashboard GREEN gates inside the atomic cutover cluster**

Run: `npm run test --workspace=packages/server -- --run src/domain/schemas.test.ts src/repository/compile-project.test.ts src/repository/referential-integrity.test.ts src/repository/schema-v4-core.test.ts src/routes/admin/versioned-core.test.ts`

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts src/hooks/versioned-core-hooks.test.tsx src/components/EndpointEditor.test.tsx src/components/EndpointList.test.tsx src/components/ProjectList.test.tsx src/components/AppStateSwitcher.test.tsx src/components/VariantEditor.test.tsx src/components/UpdateForms.test.tsx src/components/HookLintRepairs.test.tsx src/App.test.tsx`

Expected: focused schema/repository/authoring commands PASS with one schema-v4 contract and no compatibility reader. Do not run or claim the full build here: Import, runtime, logging, and proxy consumers are intentionally converted in Tasks 3-7 of the same no-commit atomic cluster. Task 7 must make the whole repository compile before any cutover commit is eligible.

- [ ] **Step 12: Focused review checkpoint**

Review all Task 2 files together. Confirm every persisted/public `schemaVersion` is 4; no Project owns `baseUrl`; no matcher owns `host`; no runtime setting owns `passthroughEnabled`; mutation schemas are strict; query duplicates survive canonicalization; mode toggles preserve dormant data; and existing Authoring/Import owner-safe work remains intact.

**Commit checkpoint:** none. Tasks 2-7 are one atomic direct-cutover cluster and may not be staged or committed here.

### Task 3: Import Preview Origin And Query Amendments

**Files:**
- Modify: `packages/server/src/import/contracts.ts`
- Modify: `packages/server/src/import/curl-parser.ts`
- Modify: `packages/server/src/import/curl-parser.test.ts`
- Modify: `packages/server/src/import/postman-parser.ts`
- Modify: `packages/server/src/import/postman-parser.test.ts`
- Modify: `packages/server/src/import/planner.ts`
- Modify: `packages/server/src/import/planner.test.ts`
- Modify: `packages/server/src/import/security.ts`
- Modify: `packages/server/src/import/security.test.ts`
- Modify: `packages/server/src/import/snapshot-token.test.ts`
- Modify: `packages/server/src/repository/project-repository.ts`
- Modify: `packages/server/src/repository/project-repository.test.ts`
- Modify: `packages/server/src/routes/admin/imports.ts`
- Modify: `packages/server/src/routes/admin/repository-integrations.test.ts`
- Modify: `packages/server/src/integration/import-preview.integration.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/hooks/useImportWizard.ts`
- Modify: `packages/dashboard/src/hooks/useImportWizard.test.tsx`
- Modify: `packages/dashboard/src/components/import/ImportReviewStep.tsx`
- Modify: `packages/dashboard/src/components/import/ImportResolveStep.tsx`
- Modify: `packages/dashboard/src/components/import/ImportResultStep.tsx`
- Modify: `packages/dashboard/src/components/import/ImportWizard.test.tsx`
- Modify: `packages/dashboard/src/App.import-integration.test.tsx`

**Interfaces:**
- Consumes: Task 1 `normalizeHttpOrigin`, `parseRawQuery`, `canonicalizeQueryConstraints`, redaction helpers; Task 2 `EndpointMatcherInput`, `EndpointCreateInput`, `canonicalEndpointIdentity`.
- Produces: `CanonicalImportRequest { baseUrl: string; matcher: EndpointMatcherInput }`, `ImportPreview.discoveredOrigins: string[]`, origin/query-inclusive `matcherIdentity(request)`, preview/item/digest scopes, and committed unbound mock Endpoints consumed by guidance in Task 12.

- [ ] **Step 1: Add RED parser tests for exact origin and enabled query occurrence preservation**

```ts
expect(parseCurlSource(`curl 'https://api.example.test:8443/items?a=1&a=1&a=2'`)
  .members[0]).toMatchObject({
  canonicalRequest: {
    baseUrl: 'https://api.example.test:8443',
    matcher: { method: 'GET', path: '/items', query: { a: [
      { operator: 'equals', value: '1' },
      { operator: 'equals', value: '1' },
      { operator: 'equals', value: '2' },
    ] } },
  },
});
```

Postman tests must prove structured query metadata overrides raw text, disabled entries are absent, explicit `:443`/`:80` normalize away, scheme/non-default port differentiate identity, and malformed authored query encoding is an item error rather than preview-only evidence.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/import/curl-parser.test.ts src/import/postman-parser.test.ts`

Expected: FAIL because parsers still emit hostname-only matchers and query evidence is not canonical matcher input.

- [ ] **Step 3: Amend parser and contract shapes without weakening redaction**

```ts
export interface CanonicalImportRequest {
  baseUrl: string;
  matcher: EndpointMatcherInput;
}

export interface NormalizedImportMember {
  provisionalId: string;
  location: ImportSourceLocation;
  breadcrumb: string[];
  name: string;
  description?: string;
  disabled: boolean;
  supportedMethod: boolean;
  canonicalRequest?: CanonicalImportRequest;
  request: ImportRequestSummary;
  responses: NormalizedImportResponse[];
  unresolvedVariables: string[];
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface ImportPreview {
  snapshotToken: string;
  sourceType: ImportSourceType;
  items: ImportPreviewItem[];
  unresolvedMembers: ImportUnresolvedMember[];
  unresolvedVariables: ImportVariableRequirement[];
  warnings: ImportMessage[];
  discoveredOrigins: string[];
  affectedStates: Array<{ id: string; name: string }>;
  summary: { valid: number; invalid: number; create: number; merge: number; skip: number };
}
```

Preview retains every source query occurrence in source order and masks sensitive values. Canonical matcher constraints receive every exact enabled value, including sensitive exact values, sorted only for identity/commit. Never persist request headers, auth, cookies, bodies, scripts, or source text.

- [ ] **Step 4: Add RED planner tests for multiset grouping, overlap, stale replay, and digests**

Prove these are different item identities: `http://api.test/x`, `https://api.test/x`, `https://api.test:8443/x`, and query multisets `{a:[1,2]}` versus `{a:[1,1,2]}`. Prove reordered equal multisets collapse, percent-equivalent valid UTF-8 collapses, and changed origin/query makes the snapshot/plan stale.

- [ ] **Step 5: Run planner/repository tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/import/planner.test.ts src/import/snapshot-token.test.ts src/repository/project-repository.test.ts src/routes/admin/repository-integrations.test.ts`

Run: `npm run test:integration --workspace=packages/server -- src/integration/import-preview.integration.test.ts`

Expected: FAIL because grouping, overlap, item IDs, canonical digest, and commit still use hostname-only matcher identity.

- [ ] **Step 6: Implement origin/query-inclusive planning and one-generation commit**

```ts
export function matcherIdentity(request: CanonicalImportRequest): string {
  return sha256Identity('import-matcher-v2', {
    baseUrl: normalizeHttpOrigin(request.baseUrl).origin,
    matcher: normalizedCompleteMatcher(request.matcher),
  });
}
```

Use Task 2 canonical identity for exact targets and duplicates. Create imported Endpoints as `mode: 'mock'`, first created Variant as fallback, no State binding, and no interception setting mutation. Preserve existing fallback and dormant bindings on merge. Carry `discoveredOrigins` through retained dashboard wizard state after successful canonical refresh.

- [ ] **Step 7: Add RED dashboard review tests**

Assert review displays full normalized origin, every repeated query occurrence, masked sensitive values plus the exact warning that hidden values will become local canonical matcher configuration, and a post-success reviewed interception checklist handoff without automatically saving settings.

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/useImportWizard.test.tsx src/components/import/ImportWizard.test.tsx src/App.import-integration.test.tsx`

Expected: FAIL because dashboard Import contracts still expose discovered hosts and hostname/path-only identity.

- [ ] **Step 8: Implement dashboard Import amendments with existing settlement ownership**

Rename `discoveredHosts` to `discoveredOrigins`, render exact origin and complete query multiset, preserve request evidence-only redaction, and retain origins until Task 12 consumes them. Do not weaken synchronous project/view invalidation, dirty guards, settlement ownership, unknown-outcome canonical refresh, or single publication behavior.

- [ ] **Step 9: Run Task 3 GREEN gates**

Run: `npm run test --workspace=packages/server -- --run src/import src/repository/project-repository.test.ts src/routes/admin/repository-integrations.test.ts`

Run: `npm run test:integration --workspace=packages/server -- src/integration/import-preview.integration.test.ts`

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/useImportWizard.test.tsx src/components/import/ImportWizard.test.tsx src/App.import-integration.test.tsx`

Expected: PASS with origin/query identity, stale replay, redaction, and explicit-settings handoff.

- [ ] **Step 10: Focused review checkpoint**

Review the Task 3 diff against both the Slice 2 baseline and Slice 3 amendments. Confirm scheme/non-default port enter identity, every enabled query occurrence enters canonical constraints, request headers remain evidence-only, imported Endpoints remain unbound, and no import action mutates interception settings.

**Commit checkpoint:** none. Tasks 2-7 are one atomic direct-cutover cluster and may not be staged or committed here.

### Task 4: Authority-First Runtime Decision And Streaming Upstream Transport

**Files:**
- Create: `packages/server/src/services/request-authority.ts`
- Create: `packages/server/src/services/request-authority.test.ts`
- Create: `packages/server/src/services/runtime-decision.ts`
- Create: `packages/server/src/services/runtime-decision.test.ts`
- Create: `packages/server/src/services/upstream-transport.ts`
- Create: `packages/server/src/services/upstream-transport.test.ts`
- Modify: `packages/server/src/services/proxy-handler.ts`
- Modify: `packages/server/src/services/proxy-handler.test.ts`
- Modify: `packages/server/src/services/proxy-server.ts`
- Modify: `packages/server/src/services/proxy-server.test.ts`
- Modify: `packages/server/src/test-support/proxy-test-client.ts`

**Interfaces:**
- Consumes: Task 1 `NormalizedOrigin`, `normalizeAuthority`, `parseRawQuery`, interception matching; Task 2 `EndpointDecision`, `MatchRequest`, and `ProjectRepository.resolve(projectId, request): EndpointDecision | null`.
- Produces: `RequestAuthority`, `deriveConnectAuthority`, `derivePlainProxyAuthority`, `deriveDirectAuthority`, `RuntimeRoutingDecision`, `decideRuntimeRequest(input)`, `HeaderTuple`, `UpstreamRequest`, `UpstreamResponse`, `UpstreamTransport`, `BlindTunnelConnector`, `createNodeUpstreamTransport()`, and `createNodeBlindTunnelConnector()` consumed by Task 7.

- [ ] **Step 1: Add RED authority agreement tests**

```ts
expect(derivePlainProxyAuthority({
  requestTarget: 'http://api.example.test:8080/x?a=1',
  hostHeaders: ['api.example.test:8080'], listenerScheme: 'http',
}).origin.origin).toBe('http://api.example.test:8080');

expect(() => deriveConnectAuthority({
  connectAuthority: 'api.example.test:443',
  innerHostHeaders: ['other.example.test'],
})).toThrow(expect.objectContaining({ code: 'PROXY_CONNECT_AUTHORITY_MISMATCH' }));

expect(() => derivePlainProxyAuthority({
  requestTarget: 'http://api.example.test/x', hostHeaders: ['other.example.test'],
  listenerScheme: 'http',
})).toThrow(expect.objectContaining({ code: 'PROXY_HOST_AUTHORITY_MISMATCH' }));

expect(() => deriveDirectAuthority({ listenerScheme: 'https', hostHeaders: [] }))
  .toThrow(expect.objectContaining({ code: 'DIRECT_ORIGIN_INVALID' }));
```

Cover duplicate/malformed/credential-bearing authorities, effective default ports, absolute-form authority priority, origin-form Host authority, CONNECT/inner agreement, and direct rejection of any reserved origin override header. Separately assert Node's inbound parser retains `IncomingMessage.url` as the exact raw request target, including percent encoding and raw query ordering, and exposes ordered duplicates through `rawHeaders` without making the target part of authority identity. Feed CONNECT headers and the first tunneled TLS bytes in one socket chunk and assert the `connect` event's exact `head` remainder reaches both blind upstream and selected MITM TLS handling before subsequent bytes.

- [ ] **Step 2: Run authority tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/request-authority.test.ts`

Expected: FAIL because current parsing overwrites duplicate headers and infers authority loosely.

- [ ] **Step 3: Implement transport-defined authority without forwarding invalid input**

```ts
export interface RequestAuthority {
  origin: NormalizedOrigin;
  rawAuthority: string;
}

export function deriveConnectAuthority(input: {
  connectAuthority: string; innerHostHeaders: readonly string[];
}): RequestAuthority;
export function derivePlainProxyAuthority(input: {
  requestTarget: string; hostHeaders: readonly string[]; listenerScheme: 'http';
}): RequestAuthority;
export function deriveDirectAuthority(input: {
  listenerScheme: 'http' | 'https'; hostHeaders: readonly string[];
  reservedOriginHeaders?: readonly string[];
}): RequestAuthority;
```

Retain raw header tuples and the exact raw request target as separate request-envelope fields in proxy/direct parsing. Never synthesize Host from an absolute target before agreement validation. Map all malformed proxy authority cases not covered by the two mismatch codes to `PROXY_AUTHORITY_INVALID`.

- [ ] **Step 4: Add RED runtime decision tests**

Prove non-allowlisted proxy returns `{ kind: 'blind' }`, allowlisted no-match returns `{ kind: 'upstream', reason: 'no_match_passthrough' }`, matched proxy passthrough returns `{ kind: 'upstream', reason: 'endpoint_passthrough' }` with the full selected Endpoint ID/name/specificity/mode evidence, and matched mock returns `{ kind: 'mock' }` with the same evidence. A direct request matching a passthrough Endpoint returns endpoint-bearing `direct_passthrough_unavailable`; direct no-match is endpoint-less `direct_miss`. An invalid proxy query passes through as no-match with `provenanceReason: 'query_parse_invalid'`; an invalid direct query is always endpoint-less direct miss with that provenance reason. Direct passthrough/no-match never performs upstream I/O.

- [ ] **Step 5: Run runtime decision tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/runtime-decision.test.ts`

Expected: FAIL because existing handlers mix selection, matching, passthrough permission, fetch, and logging.

- [ ] **Step 6: Implement a pure shared decision function**

```ts
export type RuntimeRoutingDecision =
  | { kind: 'blind'; inspected: false }
  | { kind: 'mock'; inspected: true; endpoint: EndpointDecision & { kind: 'mock' } }
  | { kind: 'upstream'; inspected: true; reason: 'endpoint_passthrough';
      endpoint: EndpointDecision & { kind: 'passthrough' } }
  | { kind: 'upstream'; inspected: true; reason: 'no_match_passthrough';
      provenanceReason?: 'query_parse_invalid' }
  | { kind: 'direct_unavailable'; inspected: true;
      reason: 'direct_passthrough_unavailable';
      endpoint: EndpointDecision & { kind: 'passthrough' } }
  | { kind: 'direct_unavailable'; inspected: true; reason: 'direct_miss';
      provenanceReason?: 'query_parse_invalid' };

export function decideRuntimeRequest(input: {
  transport: 'direct' | 'plain_http_proxy' | 'https_mitm';
  authority: RequestAuthority; rawRequestTarget: string;
  method: string; path: string; rawQuery: string;
  headers: Readonly<Record<string, readonly string[]>>;
  matchedAllowlistPattern?: string; repository: ProjectRepository; projectId: string;
}): RuntimeRoutingDecision;
```

Mode is evaluated only after selecting the most-specific matcher. The decision is the sole source of selected Endpoint ID/name/specificity/mode evidence consumed by Task 5/7; do not re-query a potentially changed repository snapshot for Traffic provenance. Passthrough always targets incoming authority/raw target, never stored Endpoint `baseUrl`.

- [ ] **Step 7: Add RED streaming upstream tests**

Use content-length and chunked inbound request bodies, unknown-length termination, malformed/conflicting framing, pipelined requests, slow readable request, slow upstream response, repeated `Set-Cookie`, content-length, chunked, and close-delimited responses, client abort, upstream abort, and backpressure-aware writable. Assert sidecars/upstream observe decoded entity chunks rather than chunk framing, the first response chunk is observable before the last upstream chunk is produced, and no `arrayBuffer()`/whole-body `Buffer.concat` path is used.

- [ ] **Step 8: Run upstream tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/upstream-transport.test.ts src/services/proxy-handler.test.ts src/services/proxy-server.test.ts`

Expected: FAIL because current proxy paths use fetch plus complete request/response buffering.

- [ ] **Step 9: Implement Node streaming transport and adapt proxy parsing**

```ts
export type HeaderTuple = readonly [name: string, value: string];
export interface UpstreamRequest {
  authority: RequestAuthority;
  rawRequestTarget: string;
  method: string;
  headers: readonly HeaderTuple[];
  body?: NodeJS.ReadableStream;
  signal: AbortSignal;
}
export interface UpstreamResponse {
  statusCode: number;
  headers: HeaderTuple[];
  body: NodeJS.ReadableStream;
  closeConnection: boolean;
}
export interface UpstreamTransport {
  forward(request: UpstreamRequest): Promise<UpstreamResponse>;
}
export interface BlindTunnelConnector {
  connect(authority: RequestAuthority, signal: AbortSignal): Promise<import('node:net').Socket>;
}
export interface NodeUpstreamTransportOptions {
  lookup?: import('node:net').LookupFunction;
  ca?: string | Buffer | readonly (string | Buffer)[];
}
export function createNodeUpstreamTransport(
  options?: NodeUpstreamTransportOptions,
): UpstreamTransport;
export function createNodeBlindTunnelConnector(options?: {
  lookup?: import('node:net').LookupFunction;
}): BlindTunnelConnector;
```

Replace the hand-written full-request parser with Node HTTP/1.1 parser ownership. The outer `http.Server` handles plain proxy `request` streams and `connect(req, socket, head)`; it derives authority from `req.url` plus ordered `req.rawHeaders`. For selected CONNECT, send 200, feed `head` into the server-side TLS socket before later client bytes, complete TLS, and hand that stream to an internal `http.Server` so MITM requests also arrive as `IncomingMessage` streams with decoded transfer framing, exact `url`, ordered raw headers, pipelining, and abort semantics. For blind CONNECT, write `head` to the connected upstream before piping. Handle parser `clientError` deterministically and never accept conflicting Content-Length/Transfer-Encoding. Sidecars receive request entity chunks after HTTP transfer framing but before content decoding.

Use `node:http`/`node:https` request streams, remove hop-by-hop fields using `Connection` tokens, preserve repeated end-to-end fields and the exact separate `rawRequestTarget`, propagate backpressure/abort, use 30-second timeout, and preserve the primary error when cleanup also fails. Both selected forwarding and blind CONNECT use explicitly injected DNS-capable owners; production composition supplies no overrides and therefore uses normal DNS/trust roots. Deterministic integration tests may inject only DNS lookup and a test CA, never `rejectUnauthorized: false`.

- [ ] **Step 10: Run Task 4 GREEN gates**

Run: `npm run test --workspace=packages/server -- --run src/services/request-authority.test.ts src/services/runtime-decision.test.ts src/services/upstream-transport.test.ts src/services/proxy-handler.test.ts src/services/proxy-server.test.ts`

Expected: PASS with authority/framing rejection before upstream I/O, exact CONNECT remainder ownership on blind and selected paths, decoded streaming request entities, direct/proxy decision parity, repeated headers, pipelining, streaming first-byte behavior, backpressure, and abort cleanup.

- [ ] **Step 11: Focused review checkpoint**

Review Task 4 files. Confirm original authority is transport-derived, direct calls cannot override it, no Endpoint origin rewrites passthrough, every matched branch retains its selected Endpoint evidence, invalid queries can only annotate endpoint-less no-match/direct-miss branches, unselected HTTPS remains a blind tunnel, unselected HTTP forwards without recording, selected request bodies are no longer wholly buffered, and authority failures cannot reach the transport.

**Commit checkpoint:** none. Tasks 2-7 are one atomic direct-cutover cluster and may not be staged or committed here.

### Task 5: Traffic Public Contracts, Outcome Builder, Retention, And Budgets

**Files:**
- Create: `packages/server/src/domain/traffic.ts`
- Create: `packages/server/src/domain/traffic.test.ts`
- Create: `packages/server/src/services/traffic-outcome.ts`
- Create: `packages/server/src/services/traffic-outcome.test.ts`
- Create: `packages/server/src/services/traffic-store.ts`
- Create: `packages/server/src/services/traffic-store.test.ts`
- Modify: `packages/server/src/types.ts`

**Interfaces:**
- Consumes: Task 1 normalized/redacted origins, query entries, and header tuples; Task 2 Endpoint/App State resolution vocabulary; Task 4 transport and routing decision vocabulary.
- Produces: exact `TrafficBodyUnavailableReason`, `TrafficBodyDescriptor`, `TrafficSummary`, `TrafficDetail`, `TrafficPage`, `TrafficOutcomeBuilder`, `TrafficStore`, `TrafficRowLeaseSnapshot`, `TRAFFIC_LIMITS`, and `TRAFFIC_CAPTURE_REPRESENTATION` consumed by Tasks 6-13.

- [ ] **Step 1: Write RED descriptor legality and public-bound tests**

```ts
expect(TrafficBodyDescriptorSchema.parse({
  side: 'response', state: 'available', observedSize: 0, retainedSize: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
})).toBeTruthy();
expect(TrafficBodyDescriptorSchema.safeParse({
  side: 'request', state: 'unavailable', observedSize: 4,
  retainedSize: 4, sha256: '0'.repeat(64), reason: 'capture_io_failed',
}).success).toBe(false);
expect(TrafficBodyDescriptorSchema.safeParse({
  side: 'response', state: 'truncated', observedSize: 50 * 1024 * 1024,
  reason: 'body_limit_exceeded',
}).success).toBe(false);
expect(TrafficBodyDescriptorSchema.parse({
  side: 'response', state: 'truncated', observedSize: 50 * 1024 * 1024 + 1,
  reason: 'body_limit_exceeded',
})).toMatchObject({ state: 'truncated', observedSize: 50 * 1024 * 1024 + 1 });
```

Add summary tests proving values/previews/full headers are absent and serialized detail never exceeds configured bounded evidence fields. Assert UTF-8 and base64 previews preserve exactly 16 KiB and truncate at 16 KiB + 1 independently for available, truncated, and unavailable body descriptors.

- [ ] **Step 2: Run domain tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/domain/traffic.test.ts`

Expected: FAIL because the exact descriptor union and Traffic contracts do not exist.

- [ ] **Step 3: Define the exact descriptor union and constants**

```ts
export type TrafficBodyUnavailableReason =
  | 'raw_capture_disabled' | 'sidecar_limit' | 'queue_saturated'
  | 'temporary_budget_exceeded' | 'retained_budget_exceeded'
  | 'capture_io_failed' | 'stream_cancelled' | 'body_unobservable';

export type TrafficBodyDescriptor =
  | { side: 'request' | 'response'; state: 'available'; mediaType?: string;
      contentEncoding?: string; observedSize: number; retainedSize: number; sha256: string }
  | { side: 'request' | 'response'; state: 'truncated'; mediaType?: string;
      contentEncoding?: string; observedSize: number; reason: 'body_limit_exceeded' }
  | { side: 'request' | 'response'; state: 'evicted'; mediaType?: string;
      contentEncoding?: string; observedSize: number; retainedSize: number; sha256: string;
      reason: 'retention_evicted' }
  | { side: 'request' | 'response'; state: 'unavailable'; mediaType?: string;
      contentEncoding?: string; observedSize: number; reason: TrafficBodyUnavailableReason };

export interface TrafficLimits {
  rowsPerProject: number; previewBytes: number; bodyBytes: number;
  sidecarQueueBytes: number;
  projectActiveSidecars: number; projectQueuedBytes: number;
  processActiveSidecars: number; processQueuedBytes: number;
  projectTemporaryBytes: number; processTemporaryBytes: number;
  projectRetainedBytes: number; processRetainedBytes: number;
}
export const TRAFFIC_LIMITS: Readonly<TrafficLimits> = Object.freeze({
  rowsPerProject: 500,
  previewBytes: 16 * 1024,
  bodyBytes: 50 * 1024 * 1024,
  sidecarQueueBytes: 1 * 1024 * 1024,
  projectActiveSidecars: 32, projectQueuedBytes: 32 * 1024 * 1024,
  processActiveSidecars: 128, processQueuedBytes: 128 * 1024 * 1024,
  projectTemporaryBytes: 1 * 1024 ** 3, processTemporaryBytes: 2 * 1024 ** 3,
  projectRetainedBytes: 1 * 1024 ** 3, processRetainedBytes: 4 * 1024 ** 3,
});
export const TRAFFIC_CAPTURE_REPRESENTATION =
  'http_entity_bytes_after_transfer_framing_before_content_encoding_decoding' as const;
```

Validate every size as a non-negative safe integer, every digest as 64 lowercase hex, `available`/`evicted` equality of observed and retained sizes, and illegal extra union keys through strict Zod members.

Define the complete bounded public contracts before any service consumes them:

```ts
export type TrafficTransport = 'direct' | 'plain_http_proxy' | 'https_mitm';
export type TrafficRoutingDecisionName =
  | 'mock' | 'endpoint_passthrough' | 'no_match_passthrough'
  | 'direct_miss' | 'direct_passthrough_unavailable' | 'failure';

export interface TrafficPreview {
  encoding: 'utf8' | 'base64';
  value: string;
  truncated: boolean;
}

export interface TrafficEndpointEvidence {
  id: string;
  name: string;
  specificity: number;
  mode: 'mock' | 'passthrough';
}

export interface TrafficAppStateContext {
  mode: 'enabled' | 'disabled';
  activeStateId?: string;
  baseStateId?: string;
  selectedStateId?: string;
  resolutionSource?: 'project_active_state' | 'project_base_state' | 'endpoint_default';
  fallbackReasons: Array<
    | 'app_state_mode_disabled' | 'active_state_not_set' | 'active_state_unbound'
    | 'base_state_not_set' | 'base_state_unbound'
  >;
}

export type TrafficRoutingEvidence =
  | { decision: 'mock'; endpoint: TrafficEndpointEvidence;
      variantId: string; bodyAssetId?: string; appState: TrafficAppStateContext }
  | { decision: 'endpoint_passthrough'; endpoint: TrafficEndpointEvidence;
      appState: TrafficAppStateContext }
  | { decision: 'direct_passthrough_unavailable'; endpoint: TrafficEndpointEvidence;
      appState: TrafficAppStateContext }
  | { decision: 'no_match_passthrough' | 'direct_miss';
      reason?: 'query_parse_invalid'; appState: TrafficAppStateContext }
  | { decision: 'failure'; reason: string; appState: TrafficAppStateContext };

export type TrafficTerminalOutcome =
  | { kind: 'response'; status: number; responseBytes: number;
      upstreamStatus?: number }
  | { kind: 'failure'; status: number; responseBytes: number;
      failure: { code: string; message: string } }
  | { kind: 'cancelled'; status: number; responseBytes: number };

export type TrafficPromotionInput = {
  expectedTrafficGeneration: string;
  expectedResponseIdentity: string;
  endpoint:
    | { action: 'create' }
    | { action: 'reuse'; endpointId: string; expectedRevision: number };
  state:
    | { action: 'unbound' }
    | { action: 'bind'; stateId: string; expectedRevision: number };
};

export type TrafficPromotionResult = {
  endpointId: string;
  endpointCreated: boolean;
  variantId: string;
  variantCreated: boolean;
  endpointModeChanged: boolean;
  stateId?: string;
  bindingChanged: boolean;
};

export interface TrafficPromotionReview {
  expectedTrafficGeneration: string;
  expectedResponseIdentity: string;
  request: {
    origin: string;
    method: string;
    path: string;
    query: QueryEntry[];
    headers: HeaderTuple[];
    sensitiveQueryNames: string[];
  };
  response: {
    status: number;
    headers: HeaderTuple[];
    mediaType: string;
    contentEncoding?: string;
    byteCount: number;
    sha256: string;
    sensitiveHeaderNames: string[];
  };
  endpoint:
    | { action: 'create'; targetMode: 'mock' }
    | { action: 'reuse'; endpointId: string; expectedRevision: number;
        currentMode: 'mock' | 'passthrough'; targetMode: 'mock' };
  variant:
    | { action: 'create'; deterministicName: string }
    | { action: 'reuse'; variantId: string };
  defaultStateId?: string;
  warnings: Array<'media_type_defaulted' | 'sensitive_query_values_persisted'
    | 'sensitive_response_headers_persisted'>;
}

export interface TrafficSummary {
  id: string;
  generation: string;
  projectId: string;
  requestId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  transport: TrafficTransport;
  allowlistPattern: string;
  origin: string;
  method: string;
  path: string;
  queryNames: Array<{ name: string; occurrenceCount: number; sensitive: boolean }>;
  endpoint?: TrafficEndpointEvidence;
  decision: TrafficRoutingDecisionName;
  routingReason?: 'query_parse_invalid';
  status: number;
  responseBytes: number;
  requestBodyState: TrafficBodyDescriptor['state'];
  responseBodyState: TrafficBodyDescriptor['state'];
}

export interface TrafficDetail extends TrafficSummary {
  request: {
    query: QueryEntry[];
    headers: HeaderTuple[];
    preview?: TrafficPreview;
    body: TrafficBodyDescriptor;
  };
  response: {
    headers: HeaderTuple[];
    preview?: TrafficPreview;
    body: TrafficBodyDescriptor;
  };
  appState: TrafficAppStateContext;
  variantId?: string;
  bodyAssetId?: string;
  upstream?: { status?: number; failure?: { code: string; message: string } };
  captureState: 'pending' | 'complete';
  promotion:
    | { state: 'blocked'; reason: 'body_unavailable' | 'body_truncated' | 'body_evicted'
        | 'invalid_content_encoding' | 'query_parse_invalid' }
    | { state: 'eligible'; review: TrafficPromotionReview }
      | { state: 'promoted'; result: TrafficPromotionResult };
}

export type TrafficStoredDetail = Omit<TrafficDetail, 'promotion'> & {
  promotion:
    | { state: 'blocked'; reason: 'body_unavailable' | 'body_truncated' | 'body_evicted'
        | 'invalid_content_encoding' | 'query_parse_invalid' }
    | { state: 'eligible' }
    | { state: 'promoted'; result: TrafficPromotionResult };
};

export interface TrafficCapturedEvidence {
  projectId: string;
  trafficId: string;
  generation: string;
  capturedAt: string;
  request: {
    origin: string;
    method: string;
    path: string;
    query: QueryParseResult;
  };
  response: {
    identity: string;
    status: number;
    headers: HeaderTuple[];
    contentEncoding:
      | { ok: true; value?: string }
      | { ok: false; reason: 'invalid_content_encoding' };
    body: TrafficBodyDescriptor;
  };
}

export interface TrafficAcceptedSnapshot extends Omit<TrafficCapturedEvidence, 'request' | 'response'> {
  request: Omit<TrafficCapturedEvidence['request'], 'query'> & {
    query: QueryEntry[];
  };
  response: Omit<TrafficCapturedEvidence['response'], 'body' | 'contentEncoding'> & {
    contentEncoding: { ok: true; value?: string };
    body: Extract<TrafficBodyDescriptor, { state: 'available' }>;
  };
  acceptedAt: string;
}

export interface TrafficQuery { afterId?: string; beforeId?: string; limit?: number }
export interface TrafficPage {
  entries: TrafficSummary[];
  latestId?: string;
  hasMore: boolean;
  reset?: boolean;
}

export interface TrafficBeginInput {
  projectId: string;
  requestId: string;
  transport: TrafficTransport;
  allowlistPattern: string;
  origin: NormalizedOrigin;
  method: string;
  path: string;
  query: QueryParseResult;
  headers: HeaderTuple[];
  appState: TrafficAppStateContext;
}

export interface TrafficExchange {
  readonly trafficId: string;
  readonly generation: string;
  observeRequest(bytes: Uint8Array): void;
  completeRequest(): Promise<TrafficBodyDescriptor>;
  setDecision(decision: TrafficRoutingEvidence): void;
  setResponse(status: number, headers: HeaderTuple[]): void;
  observeResponse(bytes: Uint8Array): void;
  completeResponse(): Promise<TrafficBodyDescriptor>;
  finalize(outcome: TrafficTerminalOutcome): Promise<TrafficStoredDetail>;
}
```

`QueryEntry` values and sensitive response-header values in public `TrafficDetail` and `TrafficPromotionReview` are already redacted. Private `TrafficCapturedEvidence` retains the complete exact `QueryParseResult` (including invalid-query failure), exact response-header values, and a discriminated Content-Encoding parse result with the row. An invalid query always sets public `routingReason: 'query_parse_invalid'` and blocked promotion reason `query_parse_invalid`; invalid Content-Encoding always sets blocked reason `invalid_content_encoding`. Either condition blocks review and acceptance even when exact response bytes are available. `TrafficAcceptedSnapshot` is created only when Task 7 atomically accepts a promotion, narrows query and encoding evidence to their valid branches, and freezes that live evidence for Task 8. Neither private shape crosses the Traffic API, error serialization, diagnostics, or logs. Public eligible review is never stored: `TrafficService.get()` recomputes exact create/reuse Variant, Endpoint mode/revision, and State revision targets from current canonical repository state on every detail GET. `TrafficSummary.queryNames` contains no values. Task 8 imports `TrafficPromotionInput` and `TrafficPromotionResult` from this file rather than redeclaring them.

- [ ] **Step 4: Write RED unified outcome-builder tests**

Build one table covering mock active/base/fallback/disabled, endpoint passthrough, no-match passthrough, direct miss, endpoint-bearing direct passthrough unavailable, query parse invalid, invalid Content-Encoding, authority failure, and sanitized upstream failure. Assert one finalization only, selected Endpoint ID/name/specificity/mode survives unchanged from the one routing decision (including direct matched passthrough), repeated response headers, configured active/base context on disabled/passthrough outcomes, no selected State for disabled/passthrough, and credential/path redaction. For malformed query with an otherwise available exact response, assert recorded `query_parse_invalid` provenance, blocked promotion with the same reason, no review, and no accepted snapshot. For malformed Content-Encoding with otherwise available exact bytes, assert blocked `invalid_content_encoding`, no review/acceptance, and public detail projection contains no unsafe normalized encoding.

- [ ] **Step 5: Run outcome tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/traffic-outcome.test.ts`

Expected: FAIL because provenance is split between logger and mock-only helper shapes.

- [ ] **Step 6: Implement one finalizable outcome builder**

```ts
export interface TrafficOutcomeBuilder {
  readonly trafficId: string;
  readonly generation: string;
  observeRequestPreview(bytes: Uint8Array): void;
  setRequestDescriptor(descriptor: TrafficBodyDescriptor): void;
  setDecision(decision: TrafficRoutingEvidence): void;
  setResponse(status: number, headers: readonly HeaderTuple[]): void;
  observeResponsePreview(bytes: Uint8Array): void;
  setResponseDescriptor(descriptor: TrafficBodyDescriptor): void;
  finalize(outcome: TrafficTerminalOutcome): TrafficStoredDetail;
}

export function createTrafficOutcomeBuilder(input: {
  projectId: string; requestId: string; now(): number; id(): string;
  transport: 'direct' | 'plain_http_proxy' | 'https_mitm';
  allowlistPattern: string; origin: NormalizedOrigin; method: string;
  path: string; query: QueryParseResult; headers: readonly HeaderTuple[];
  appStateContext: TrafficAppStateContext;
}): TrafficOutcomeBuilder;
```

Store start/completion/duration, actual origin, allowlist pattern, Endpoint match/mode/specificity, routing decision, State context/resolution/fallback, mock Variant/Body Asset, sanitized upstream failure, final status/repeated headers/byte count, descriptors/previews, and capture/promotion state. Finalization is idempotence-protected and throws on a second call in tests.

**Mandatory internal review boundary A:** GREEN and review the public-safe detail/descriptor model, private captured-evidence split, and unified outcome builder before introducing retention. Confirm exact hidden values cannot enter public serialization, all terminal decisions finalize once, previews/descriptors stay bounded, and blocked/eligible/promoted states are exhaustive.

- [ ] **Step 7: Write RED Project retention and row-generation race tests**

Inject a limit of 2, deterministic IDs/generations/clocks, and release spies. Pending registrations count against the same per-Project bound even when capture is disabled or sidecar admission fails. Assert a third never-finalized exchange tombstones the oldest pending generation; its late finalization cannot publish. Assert the third finalized append evicts only the oldest Project-local row; cursor reset behavior remains bounded; cross-Project get is indistinguishable missing; clear tombstones finalized and pending generations and releases descriptor references; clear before request completion and clear before response completion prevent later publication; retention never resurrects pending work; and captured row snapshots remain immutable across later updates. Task 6 owns body leases; Task 7 owns the combined promotion snapshot-plus-lease race.

- [ ] **Step 8: Run retention tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/traffic-store.test.ts`

Expected: FAIL because Traffic is still a process-global logger array without row generations or reference callbacks.

- [ ] **Step 9: Implement runtime-owned Project retention**

```ts
interface TrafficRowCapturedSnapshot {
  projectId: string;
  trafficId: string;
  generation: string;
  detail: Readonly<TrafficStoredDetail>;
  captured: Readonly<TrafficCapturedEvidence>;
}
export interface TrafficRowLeaseSnapshot {
  projectId: string;
  trafficId: string;
  generation: string;
  detail: Readonly<TrafficStoredDetail>;
  accepted: Readonly<TrafficAcceptedSnapshot>;
}
export interface TrafficStore {
  registerGeneration(projectId: string, trafficId: string, generation: string): void;
  append(detail: TrafficStoredDetail, captured: TrafficCapturedEvidence): Promise<boolean>;
  list(projectId: string, query?: TrafficQuery): TrafficPage;
  get(projectId: string, trafficId: string): TrafficStoredDetail | undefined;
  updateBody(projectId: string, trafficId: string, generation: string,
    side: 'request' | 'response', descriptor: TrafficBodyDescriptor): boolean;
  snapshotForAcceptance(projectId: string, trafficId: string,
    generation: string): TrafficRowCapturedSnapshot | undefined;
  attachPromotion(projectId: string, trafficId: string, generation: string,
    result: TrafficPromotionResult): boolean;
  clear(projectId: string): Promise<void>;
}
```

Clone/freeze stored returns and immutable captured evidence separately, preserve incremental `afterId`/`beforeId` behavior, and perform row eviction/clear in two phases. The short store/service transition tombstones rows and collects exact reference-detachment intents; only after releasing that queue may settlement await cache release callbacks. `TrafficService.begin()` allocates IDs and calls `registerGeneration` before returning the exchange or observing bytes. Pending registrations count against `rowsPerProject`; registering beyond the bound tombstones the oldest pending/finalized generation by one deterministic age order. They are also tombstoned by clear/disposal; `append` publishes only the same still-live generation and returns `false` after a tombstone. `TrafficExchange.finalize()` constructs both shapes from one outcome and awaits `TrafficStore.append`; public reads never expose captured/accepted evidence. `snapshotForAcceptance` and `attachPromotion` are internal owner protocols, not APIs for routes or repositories: only the private Task 7 accepted-promotion capability may call them under the Traffic-service operation queue. Acceptance rejects invalid query evidence, invalid Content-Encoding evidence, or a non-available response before lease acquisition, then acquires the matching response lease and revalidates row generation, successful query/encoding evidence, response identity, and descriptor identity before constructing `TrafficAcceptedSnapshot`. Task 7 owns public detail projection and the sole combined promotion acceptance/settlement operation. Keep this store instance-owned and injected through runtime.

- [ ] **Step 10: Run Task 5 GREEN gates**

Run: `npm run test --workspace=packages/server -- --run src/domain/traffic.test.ts src/services/traffic-outcome.test.ts src/services/traffic-store.test.ts`

Expected: PASS with strict descriptors, bounded serialization, unified outcomes, 500-row default, Project isolation, and tombstone-safe late completion.

- [ ] **Step 11: Focused review checkpoint**

Review Task 5 files. Confirm summaries omit large evidence, details remain bounded/redacted, descriptor reasons are exhaustive, exact bytes are not stored in rows, retention is not global, generation checks guard every update, and all limits are exact injectable defaults.

**Commit checkpoint:** none. Tasks 2-7 are one atomic direct-cutover cluster and may not be staged or committed here.

### Task 6: Exact Traffic Body Cache, Sidecars, Budgets, And Leases

**Files:**
- Create: `packages/server/src/services/traffic-body-budget.ts`
- Create: `packages/server/src/services/traffic-body-budget.test.ts`
- Create: `packages/server/src/services/traffic-body-cache.ts`
- Create: `packages/server/src/services/traffic-body-cache.test.ts`
- Create: `packages/server/src/services/capture-sidecar.ts`
- Create: `packages/server/src/services/capture-sidecar.test.ts`
- Modify: `packages/server/src/repository/file-system.ts`
- Modify: `packages/server/src/test-support/test-storage.ts`
- Modify: `packages/server/src/test-support/test-storage.test.ts`

**Interfaces:**
- Consumes: Task 5 `TRAFFIC_LIMITS`, `TrafficBodyDescriptor`, row generation, and `TRAFFIC_CAPTURE_REPRESENTATION`; Task 1 normalized metadata; existing containment/ancestor identity patterns from `body-store.ts` and injected `FileSystem`.
- Produces: `TrafficBodyBudgetManager`, `TrafficBodyCache`, `TrafficBodyLease`, `CaptureSidecar`, `CaptureObservation`, `createCaptureSidecar(input)`, startup cleanup, exact stream opening, attach/release/evict callbacks, and process-shared accounting consumed by Tasks 7-8.

- [ ] **Step 1: Write RED aggregate-budget reservation tests**

```ts
const budgets = createTrafficBodyBudgetManager({
  ...TRAFFIC_LIMITS,
  projectActiveSidecars: 1, processActiveSidecars: 2,
  projectQueuedBytes: 8, processQueuedBytes: 12,
  projectTemporaryBytes: 16, processTemporaryBytes: 24,
  projectRetainedBytes: 20, processRetainedBytes: 30,
});
const first = budgets.reserveSidecar('runtime_a', 'prj_a', 8, 16);
expect(first.ok).toBe(true);
expect(budgets.reserveSidecar('runtime_a', 'prj_a', 1, 1))
  .toEqual({ ok: false, reason: 'sidecar_limit' });
first.ok && first.reservation.release();
expect(budgets.snapshot()).toEqual({ activeSidecars: 0, queuedBytes: 0,
  temporaryBytes: 0, retainedBytes: 0, runtimes: {} });
```

Cover every Project/process active, queue, temporary, and retained limit; growing reservations; process retained rejection without cross-Project eviction; duplicate release; and all failure paths returning the exact descriptor reason. Create two runtime roots that both use Project ID `prj_1` and the same digest; prove they debit two physical retained files and that disposing either runtime releases only its namespaced reservations.

- [ ] **Step 2: Run budget tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/traffic-body-budget.test.ts`

Expected: FAIL because aggregate body accounting is absent.

- [ ] **Step 3: Implement exact-once reservations and physical-byte accounting**

```ts
export interface TrafficProjectBudgetSnapshot {
  activeSidecars: number;
  queuedBytes: number;
  temporaryBytes: number;
  retainedBytes: number;
}
export interface TrafficRuntimeBudgetSnapshot extends TrafficProjectBudgetSnapshot {
  projects: Record<string, TrafficProjectBudgetSnapshot>;
}
export interface TrafficBudgetSnapshot extends TrafficProjectBudgetSnapshot {
  runtimes: Record<string, TrafficRuntimeBudgetSnapshot>;
}
export interface TrafficBodyBudgetReservation {
  growQueued(delta: number): boolean;
  releaseQueued(delta: number): void;
  growTemporary(delta: number): boolean;
  convertTemporaryToRetained(digest: string, bytes: number):
    { ok: true; physicalBytesAdded: boolean } |
    { ok: false; reason: 'retained_budget_exceeded' };
  release(): void;
}
export interface TrafficBodyBudgetManager {
  reserveSidecar(runtimeNamespace: string, projectId: string,
    queueBytes: number, prospectiveTemporaryBytes: number):
    { ok: true; reservation: TrafficBodyBudgetReservation } |
    { ok: false; reason: 'sidecar_limit' | 'queue_saturated'
        | 'temporary_budget_exceeded' };
  releaseRetained(runtimeNamespace: string, projectId: string,
    digest: string, bytes: number): void;
  snapshot(): TrafficBudgetSnapshot;
}
```

Key every Project/process reservation by an opaque runtime/cache namespace plus Project ID. Count retained bytes once per namespace/Project/digest. Because cache files live below runtime Project roots, equal IDs and digests in two runtime roots occupy physical bytes twice and therefore count twice toward the process budget. Reservations must be idempotent and safe when abandonment races stream cancellation.

**Mandatory internal review boundary A:** GREEN and review budget accounting before cache work. Confirm every exact limit and descriptor reason, namespace isolation for identical Project IDs/digests, physical-byte accounting, and exact-once release under cancellation.

- [ ] **Step 4: Write RED cache publication, deduplication, lease, eviction, and cleanup tests**

Use reduced Project retained budget 6 bytes and two Projects. Assert complete observation/hash/fsync/atomic create-if-absent before availability; same Project equal digest deduplicates; references count by live row generation; oldest unleased reference evicts first and changes its descriptor to `evicted`; every candidate leased makes the new body `unavailable` with `retained_budget_exceeded`; another Project is never evicted; zero-byte bodies need no file; clear tombstones rows and detaches references immediately without waiting for active leases, keeps leased bytes readable, and deletes them after final release; startup removes previous ephemeral cache; and symlink/special file/malformed digest/replaced ancestor/escaped path fail safely without path text. Add clear-versus-promotion, clear-versus-Download, and deterministic clear-versus-eviction/descriptor-replacement tests proving no deadlock and exact-once deferred deletion.

- [ ] **Step 5: Run cache tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/traffic-body-cache.test.ts`

Expected: FAIL because no ephemeral content-addressed Traffic cache or digest lease exists.

- [ ] **Step 6: Implement Project-scoped cache and digest-owned leases**

```ts
export interface TrafficBodyLease {
  projectId: string; sha256: string; byteCount: number;
  openStream(): NodeJS.ReadableStream;
  release(): Promise<void>;
}
export interface TrafficBodyCache {
  initialize(): Promise<void>;
  finalize(input: {
    projectId: string; trafficId: string; generation: string;
    side: 'request' | 'response'; temporaryPath?: string;
    sha256: string; byteCount: number; mediaType?: string; contentEncoding?: string;
  }): Promise<TrafficBodyDescriptor>;
  attach(projectId: string, trafficId: string, generation: string,
    side: 'request' | 'response', descriptor: Extract<TrafficBodyDescriptor,
      { state: 'available' }>): Promise<boolean>;
  acquire(projectId: string, trafficId: string, generation: string,
    side: 'request' | 'response'): Promise<TrafficBodyLease | undefined>;
  releaseRow(projectId: string, trafficId: string, generation: string): Promise<void>;
  clearProject(projectId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

Place cache files under the configured data root in a dedicated ephemeral `traffic-cache/projects/<projectId>/sha256/<prefix>/<digest>` tree. Snapshot and reverify ancestor identities, reject links/special entries, hash while writing, sync content and directory where supported, and atomically publish create-if-absent. Serialize attach/release/lease/eviction transitions through one cache-owned operation queue. Cache transitions collect descriptor-publication intents and release the cache queue before invoking Traffic-service callbacks; Traffic-service transitions likewise release their queue before awaiting cache operations. No queue may call into the other while held. `clearProject()` tombstones/detaches references and returns after deleting unleased files; active leases keep their bytes alive and final release performs deferred deletion. Only `dispose()` rejects new work, aborts/awaits sidecars and queued filesystem operations, waits for owned leases to release, then containment-checks and removes the ephemeral cache root.

**Mandatory internal review boundary B:** GREEN and review cache publication/leases before sidecar work. Confirm containment and ancestor revalidation, create-if-absent deduplication, namespace-aware budget ownership, unleased Project-local eviction, clear/lease serialization, and awaited disposal.

- [ ] **Step 7: Write RED non-blocking sidecar tests**

Drive `observe()` synchronously while injected persistence remains stalled. Assert observation never awaits persistence, its queued memory stays bounded, preview and observed size continue after exact abandonment, queue saturation occurs at `1 MiB + 1`, exact body is available at `50 MiB`, truncation occurs at `50 MiB + 1`, unknown-length streams work, disk failure/cancellation removes operation-owned temporary files, and capture failure retains its initiating reason. Task 7 owns the tee test proving a blocked application delivery sink and stalled capture persistence cannot block or alter one another.

- [ ] **Step 8: Run sidecar tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/capture-sidecar.test.ts`

Expected: FAIL because no bounded independent observation sidecar exists.

- [ ] **Step 9: Implement non-blocking capture observation**

```ts
export interface CaptureObservation {
  preview?: string;
  previewEncoding?: 'utf8' | 'base64';
  observedSize: number;
  descriptor: TrafficBodyDescriptor;
}
export interface CaptureSidecar {
  observe(bytes: Uint8Array): void;
  complete(): Promise<CaptureObservation>;
  abandon(reason: TrafficBodyUnavailableReason): void;
}
export function createCaptureSidecar(input: {
  runtimeNamespace: string; projectId: string; trafficId: string; generation: string;
  side: 'request' | 'response'; enabled: boolean;
  mediaType?: string; contentEncoding?: string; textPreview: boolean;
  cache: TrafficBodyCache; budgets: TrafficBodyBudgetManager;
  fileSystem: FileSystem;
}): CaptureSidecar;
```

`observe` must return synchronously after bounded copying, never await disk, keep preview/observed accounting after abandonment, and enqueue no more than 1 MiB. A verified enabled empty completion returns the empty digest descriptor. Disabled capture returns `raw_capture_disabled` even for empty/bodyless/mock-known sources.

- [ ] **Step 10: Run Task 6 GREEN gates**

Run: `npm run test --workspace=packages/server -- --run src/services/traffic-body-budget.test.ts src/services/traffic-body-cache.test.ts src/services/capture-sidecar.test.ts src/test-support/test-storage.test.ts`

Expected: PASS with reduced-limit deterministic tests, exact bytes, deduplication, leases, eviction, containment, cancellation, and transport independence.

- [ ] **Step 11: Focused review checkpoint**

Review Task 6 files for unbounded buffers/queues, trusted `Content-Length`, cross-Project eviction, path leakage, non-idempotent release, and row resurrection. Confirm delivery code never awaits sidecar persistence and every owned temporary file has one containment-checked cleanup path.

**Commit checkpoint:** none. Tasks 2-7 are one atomic direct-cutover cluster and may not be staged or committed here.

### Task 7: Runtime Traffic Integration, Authority-First App Dispatch, And Canonical APIs

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/runtime/create-runtime.ts`
- Modify: `packages/server/src/runtime/create-runtime.test.ts`
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/src/index.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/app.test.ts`
- Modify: `packages/server/src/integration/integration-harness.ts`
- Modify: `packages/server/src/integration/versioned-core.integration.test.ts`
- Create: `packages/server/src/integration/traffic-route-contract.integration.test.ts`
- Modify: `packages/server/src/scripts/import-xstream-automation.ts`
- Modify: `packages/server/src/scripts/import-xstream-automation.test.ts`
- Modify: `packages/server/src/test-setup.ts`
- Modify: `packages/server/src/test-https.ts`
- Modify: `packages/server/src/routes/mock.ts`
- Modify: `packages/server/src/routes/setup.ts`
- Modify: `packages/server/src/routes/setup.test.ts`
- Modify: `packages/server/src/routes/setup-page.ts`
- Modify: `packages/server/src/services/certs/generator.test.ts`
- Modify: `packages/server/src/services/certs/test-certs.ts`
- Create: `packages/server/src/services/certs/test-certs.test.ts`
- Modify: `packages/server/src/routes/automation.ts`
- Create: `packages/server/src/routes/automation.test.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/routes/admin.test.ts`
- Modify: `packages/server/src/routes/admin/traffic.ts`
- Modify: `packages/server/src/routes/admin/repository-integrations.test.ts`
- Modify: `packages/server/src/routes/admin/versioned-core.test.ts`
- Modify: `packages/server/src/services/proxy-handler.ts`
- Modify: `packages/server/src/services/proxy-handler.test.ts`
- Modify: `packages/server/src/services/proxy-server.ts`
- Modify: `packages/server/src/services/proxy-server.test.ts`
- Modify: `packages/server/src/services/traffic-provenance.ts`
- Modify: `packages/server/src/services/traffic-provenance.test.ts`
- Modify: `packages/server/src/services/response-writer.ts`
- Modify: `packages/server/src/services/response-writer.test.ts`
- Modify: `packages/server/src/services/api-errors.ts`
- Modify: `packages/server/src/services/api-errors.test.ts`
- Delete: `packages/server/src/services/logger.ts`
- Delete: `packages/server/src/services/logger.test.ts`
- Delete: `packages/server/src/services/logger.test-d.ts`
- Delete: `packages/server/src/services/proxy.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/api/client.test.ts`
- Create: `packages/dashboard/src/hooks/useTraffic.ts`
- Create: `packages/dashboard/src/hooks/useTraffic.test.tsx`
- Delete: `packages/dashboard/src/hooks/useLogs.ts`
- Delete: `packages/dashboard/src/hooks/useLogs.test.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.tsx`
- Delete: `packages/dashboard/src/components/LogsView.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 4 authority/decision/upstream transport; Task 5 store/outcome contracts; Task 6 cache/sidecars/budgets; Task 2 repository resolution/settings.
- Produces: `ProcessTrafficContext`, `createProcessTrafficContext(limits)`, service-only `RuntimeContext`, `TrafficService`, `TrafficPromoter` interface, runtime-injected transport dependencies, `createSetupRouter(...)`, exact `startServers(options)` lifecycle, idempotent `ServerRuntimeOwner.close()`, authority-first Express dispatch, one proxy/direct/mock Traffic pipeline, the six canonical Traffic list/detail/clear/body/mock routes, the matching minimal dashboard Traffic API/hook/navigation cutover, exact body-stream headers, and debug provenance headers consumed by Tasks 8-13. Task 12 owns the seventh canonical interception-guidance route; Task 9 deepens dashboard ownership/metadata behavior but does not perform the route cutover.

- [ ] **Step 1: Write RED runtime composition, startup, and certificate-owner tests**

Assert two runtime instances have isolated Traffic stores while sharing one explicitly injected `ProcessTrafficContext`; every Project cache and both runtimes debit the same process budget manager; initialization clears only that runtime root's old `traffic-cache` state before requests; and disposal/cancellation releases only the disposing runtime's reservations/handles. Assert `RuntimeContext` exposes `traffic: TrafficService` but no logger singleton. Type-check that public `TrafficService` exposes neither raw store/cache fields nor any snapshot operation. Add `index.test.ts` for exact-once async signal close/partial startup rollback, setup/certificate tests for assigned-port and active-CA ownership, and `test-certs.test.ts` for missing, relative, equal-root, escaping, and valid strict-descendant utility paths.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/runtime/create-runtime.test.ts src/index.test.ts src/routes/setup.test.ts src/services/certs/generator.test.ts src/services/certs/test-certs.test.ts`

Expected: FAIL because runtime currently creates repository/app together, logger state is module-global, startup has no exact close owner, setup uses global ports/certificates, and the manual utility accepts implicit storage.

- [ ] **Step 3: Define and compose the Traffic service**

```ts
export interface TrafficPromoter {
  promote(projectId: string, trafficId: string,
    input: TrafficPromotionInput): Promise<TrafficPromotionResult>;
}
export interface ProcessTrafficContext {
  readonly limits: Readonly<TrafficLimits>;
  bodyBudgets: TrafficBodyBudgetManager;
}
export function createProcessTrafficContext(
  limits: Readonly<TrafficLimits> = TRAFFIC_LIMITS,
): ProcessTrafficContext;
export interface TrafficService {
  begin(input: TrafficBeginInput): TrafficExchange;
  list(projectId: string, query?: TrafficQuery): TrafficPage;
  get(projectId: string, trafficId: string): TrafficDetail | undefined;
  openBody(projectId: string, trafficId: string,
    side: 'request' | 'response'): Promise<{
      descriptor: Extract<TrafficBodyDescriptor, { state: 'available' }>;
      lease: TrafficBodyLease;
    }>;
  clear(projectId: string): Promise<void>;
  dispose(): Promise<void>;
  promoter: TrafficPromoter;
}

interface AcceptedTrafficPromotion {
  readonly snapshot: TrafficRowLeaseSnapshot;
  readonly lease: TrafficBodyLease;
  attachResult(result: TrafficPromotionResult): Promise<boolean>;
  settle(): Promise<void>;
}
interface TrafficPromotionAcceptor {
  accept(projectId: string, trafficId: string, expected: {
    generation: string; responseIdentity: string;
  }): Promise<AcceptedTrafficPromotion>;
}

export interface CreateRuntimeOptions extends AdminSecurityOptions {
  rootDirectory: string;
  processTraffic: ProcessTrafficContext;
  fileSystem?: FileSystem;
  upstreamTransport?: UpstreamTransport;
  blindTunnelConnector?: BlindTunnelConnector;
}

export interface StartServersOptions {
  runtime: RuntimeContext;
  requestedPorts: ServerPorts;
  certificateDirectory: string;
}

export interface RuntimeContext {
  rootDirectory: string;
  repository: ProjectRepository;
  traffic: TrafficService;
  readonly adminSecurity: AdminSecurityOptions;
  dispose(): Promise<void>;
}

export function createApp(options: {
  runtime: RuntimeContext;
  setupRouter: Router;
}): Application;

export function startServers(options: StartServersOptions): Promise<ServerRuntimeOwner>;

export interface SetupRouterDependencies {
  certificateDirectory: string;
  getPorts(): ServerPorts;
}
export function createSetupRouter(dependencies: SetupRouterDependencies): Router;
export interface SetupPageContext {
  host: string;
  localAddresses: readonly string[];
  ports: ServerPorts;
}
export function setupPageHTML(context: SetupPageContext): string;

export interface ServerRuntimeOwner {
  readonly ports: ServerPorts;
  readonly app: Application;
  close(): Promise<void>;
}
```

The process entry owner constructs one immutable-limit `ProcessTrafficContext` and explicitly injects it into every runtime in that Node process; tests that create multiple runtimes inject the same context when asserting process limits. Reduced process limits exist only by constructing a separate test context, never through a per-runtime override. Each runtime creates an opaque budget namespace so equal Project IDs/digests in different roots cannot alias. `createRuntime` constructs private `TrafficStore`/Project caches and uses injected `UpstreamTransport` and `BlindTunnelConnector` owners, or production owners with no DNS/CA override. An initially injected promoter stub throws sanitized `501 TRAFFIC_PROMOTION_UNAVAILABLE`; Task 8 replaces it before the promotion route GREEN gate. `TrafficService.begin()` registers pending generations before returning. Runtime composition alone holds the private `TrafficPromotionAcceptor`; `RuntimeContext.traffic`, routes, and repositories cannot obtain snapshots or leases. `dispose()` stops admissions, aborts/awaits sidecars and operation queues, waits for handles/leases, clears ephemeral Project caches, and is awaited only after listeners stop.

The Traffic-service operation queue serializes only short accept, append/finalization, clear, retention-callback, result-attachment, and descriptor-replacement state transitions; it is never held while waiting for a body lease, repository mutation, or lease release. Acceptance checks generation/response identity and rejects invalid query evidence, invalid Content-Encoding evidence, or a non-available response before lease acquisition; it acquires the matching response lease outside the queue, then re-enters the queue to revalidate generation, successful query/encoding evidence, response identity, and descriptor identity. If acquisition throws, revalidation throws, or any post-acquisition check rejects, `accept()` catches the path and awaits exact-once lease release before returning/throwing; no capability is constructed. Only successful revalidation returns an exact-once private `AcceptedTrafficPromotion`. `attachResult` briefly re-enters the queue and attaches only while the generation remains live. `settle` releases the lease exactly once without requiring a live row. `clear()` tombstones rows and detaches references without waiting for active promotion/Download leases; final lease release performs deferred physical deletion. Only runtime disposal awaits all leases.

`createRuntime()` initializes services only and does not construct an Express app. `startServers({ runtime, requestedPorts, certificateDirectory })` containment-checks the certificate directory beneath `runtime.rootDirectory`, creates certificates, creates a private assigned-port provider, builds `createSetupRouter({ certificateDirectory, getPorts })`, and only then creates the app. Bind HTTP/HTTPS/proxy with admissions closed, read the actual addresses for every requested port including `0`, publish them to the provider, attach/open request handling, and resolve one `ServerRuntimeOwner`; the setup getter throws before publication rather than advertising requested/default ports. This removes the app/startup dependency cycle.

The owner tracks HTTP, HTTPS, proxy, and accepted sockets and never falls back to developer/user certificate storage. Test that `/setup/ca.crt` byte-equals the active proxy CA and `setupPageHTML({ host, localAddresses, ports })` advertises every assigned port rather than a hard-coded default, with no read/write under developer/user certificate storage. `close()` stops admissions, closes all listeners/sockets, then awaits `runtime.dispose()`. Partial startup failure closes every listener/socket already started and disposes runtime. `index.ts` installs exact-once async SIGTERM/SIGINT shutdown and sets `process.exitCode` only after close; it does not call immediate `process.exit`. Update every direct `createApp`, `createRuntime`, `startServers`, setup-router/setup-page, certificate caller, and `test-setup.ts` in the listed files, including certificate tests and the versioned-core integration caller, to own/await the same lifecycle and explicit certificate directory; no manual utility may tear down with `process.exit()`. The manual `services/certs/test-certs.ts` utility requires explicit absolute `--test-root` and `--certificate-directory` arguments; the certificate directory must be a strict contained descendant of the test root. It passes that directory to certificate generation/path reads and rejects missing, relative, equal-root, or escaping values with no default user-storage path.

- [ ] **Step 4: Write RED authority-first Express dispatch tests**

Use direct requests whose Host is allowlisted backend authority and paths `/health`, `/setup`, `/api/admin/projects`, and `/static_files/x`; assert they enter backend matching and can never reach control routes. Add a raw `http.request` with a slow body larger than the Express JSON limit and assert it remains an `IncomingMessage` stream, no JSON/body parser executes, capture observes multiple chunks, and control routing never executes. Add a tee test with a blocked application sink and stalled capture persistence; releasing either side independently must not make the other await it or change delivered bytes/errors. Local control Host still reaches admin/setup/health/dashboard. Missing/malformed direct authority returns unrecorded `DIRECT_ORIGIN_INVALID` before allowlist selection because no valid authority can produce the matched pattern required on every retained row; non-allowlisted direct authority returns unrecorded `404 ENDPOINT_NOT_FOUND`; matched mock records; matched passthrough and unmatched allowlisted direct return recorded `404 ENDPOINT_NOT_FOUND` without upstream I/O.

- [ ] **Step 5: Run app/direct tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/app.test.ts src/routes/setup.test.ts src/routes/admin/repository-integrations.test.ts`

Expected: FAIL because Express dispatch is path-first and direct miss may consult old passthrough behavior.

- [ ] **Step 6: Implement authority-first control/backend dispatch**

Insert request ID first, then an authority classifier that chooses exactly one branch before path routing. Local MockMate authorities receive admin/setup/health/static/dashboard routes; allowlisted non-local authority receives a raw Node request stream and the direct runtime handler without passing through Express JSON/body parsers; non-allowlisted non-local direct authority gets unrecorded 404. Never allow a client header to override listener scheme or Host authority, and never buffer a selected direct request merely to adapt it to the old Express handler.

**Mandatory internal review boundary A:** Review runtime composition, disposal, and authority-first dispatch before integrating body observation. Confirm one authority branch, parser bypass for selected direct streams, no control-route crossover, no direct upstream I/O, instance-owned Traffic state, and an awaited cleanup owner. Fix findings under the runtime/app focused gates.

- [ ] **Step 7: Write RED proxy/direct unified Traffic integration tests**

Cover selected HTTP/HTTPS no-match passthrough, endpoint passthrough, direct matched-passthrough unavailable, direct miss, active/base/fallback/disabled mock, invalid query parity, invalid Content-Encoding, repeated request/response headers, streaming request/response/bodyless/zero bytes, upstream timeout/failure, cancellation, and raw-capture-off descriptors. Assert direct matched passthrough records the exact Endpoint ID/name/specificity/mode from the sole decision; invalid direct query is endpoint-less `direct_miss` with `query_parse_invalid` and blocked promotion. With exact available bytes plus malformed Content-Encoding, assert blocked detail, no accepted snapshot, no lease acquisition, and no repository-queue entry. Pause acceptance after lease acquisition, race clear and descriptor replacement before queue re-entry, and assert stale rejection releases that lease exactly once, constructs no capability, enters no repository queue, and permits deferred deletion/disposal. Assert exactly one Traffic row per inspected request and no row for blind/unselected requests. For an allowlisted CONNECT/inner-Host mismatch and allowlisted absolute-form/Host mismatch, assert the exact 400 code, no upstream observation, and exactly one sanitized Traffic failure row containing the matched allowlist pattern and request ID. Assert capture failure cannot alter delivered bytes/status/teardown.

- [ ] **Step 8: Run integration-focused service tests and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-handler.test.ts src/services/proxy-server.test.ts src/services/traffic-provenance.test.ts src/services/response-writer.test.ts`

Expected: FAIL because proxy/direct/mock paths still use separate logging and body observation behavior.

- [ ] **Step 9: Wire one Traffic exchange around every inspected request**

Create request/response sidecars only after allowlist selection, tee bytes toward application/upstream independently, feed bounded previews regardless of exact capture, call Task 4 decision once, and finalize one outcome on success/failure/cancellation. Mock Body Asset optimization may open permanent bytes behind the Traffic body API but must preserve capture-off semantics, row ownership, clear behavior, and descriptors.

Add only these mock debug headers when enabled and valid: `X-MockMate-Project`, `X-MockMate-Endpoint`, `X-MockMate-Variant`, optional `X-MockMate-State`, `X-MockMate-Resolution-Source`, repeated/combined stable fallback reason, and `X-MockMate-Request-Id`. Strip user attempts to set reserved names. Never add them to passthrough.

**Mandatory internal review boundary B:** Review only the unified proxy/direct/mock exchange and sidecar integration before route replacement. Confirm one finalization, delivery-independent capture, bounded queues/previews, exact mock-only provenance headers, cancellation ownership, and observational failures. Fix findings under the focused service gates.

- [ ] **Step 10: Write RED canonical Traffic route, live dashboard-client contract, and exact-body tests**

First add dashboard client tests for the six canonical methods, encoded relative URLs, raw body `Response`, and temporary promotion behavior. Run `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts` and verify RED because the minimal Traffic client methods are absent. Implement only the Task 5 public type mirrors and minimal `trafficApi.list/detail/clear/body/bodyDownloadUrl/promote` methods, then rerun that exact command to GREEN; do not implement any server route, hook, navigation, or metadata UI yet.

Now assert all six canonical server routes owned by this task, strict list query, bounded summary/detail, Project/Traffic/side indistinguishable 404, `409 TRAFFIC_BODY_UNAVAILABLE`, `409 TRAFFIC_BODY_TRUNCATED`, `410 TRAFFIC_BODY_EVICTED`, cancellation lease release, and exact headers. Assert `/api/admin/projects/:projectId/logs` and `/:trafficId/create-mock` return `404 ADMIN_ROUTE_NOT_FOUND`. Create `traffic-route-contract.integration.test.ts`: it starts the real server and imports the now-existing actual dashboard `trafficApi`, so its RED failure must come from real missing HTTP route behavior rather than a missing client method or duplicated test client. Add hook/App RED assertions that no `/logs`, `create-mock`, `useLogs`, or `LogsView` reference remains and every minimal Traffic action uses the canonical route. Task 12 separately binds the seventh canonical interception-guidance route.

```ts
expect(response.headers).toMatchObject({
  'content-type': 'application/json',
  'content-length': String(bytes.length),
  'x-mockmate-original-content-encoding': 'gzip, br',
  'x-mockmate-sha256': digest,
  'x-request-id': expect.any(String),
});
expect(response.headers).not.toHaveProperty('content-encoding');
```

- [ ] **Step 11: Run route tests and verify RED**

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts`

Expected: PASS after the narrow client-only GREEN inside Step 10.

Run: `npm run test --workspace=packages/server -- --run src/routes/admin/repository-integrations.test.ts src/routes/admin.test.ts src/app.test.ts`

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts src/hooks/useTraffic.test.tsx src/App.test.tsx`

Run: `npm run test:integration --workspace=packages/server -- src/integration/traffic-route-contract.integration.test.ts`

Expected: server route, hook/App, and live actual-dashboard-client tests FAIL because admin mounts `/logs`, canonical HTTP routes/hook/navigation do not exist, and old promotion naming remains. The client-only gate stays GREEN; a missing client method, missing test file, or duplicated test-only client is not acceptable live RED evidence.

- [ ] **Step 12: Implement canonical routes and sanitized stream ownership**

Mount only `/projects/:projectId/traffic`. List/detail/clear call `TrafficService`; body routes await one lease, set authoritative media type, exact length/digest/request ID, omit `Content-Encoding`, add original encoding metadata, and use `?download=1` for `Content-Disposition: attachment`. Release lease exactly once on finish, close, abort, or source error. Promotion route parses strict Task 8 input shape now and delegates to `traffic.promoter`. Migrate surviving automation behavior in `routes/automation.ts` to the injected `TrafficService`: `clearTraffic` awaits `clear()`, and data lookup reads bounded list/detail previews without importing deleted logger APIs.

In this same atomic cutover, retain the narrow Step 10 Task 5 dashboard type mirrors/minimal Traffic client; delete `serverApi.logs`/old create-mock methods; create a basic Project-owned `useTraffic`; switch App/navigation to Traffic; and delete `useLogs`/`LogsView`. This is route-coherence work only: Task 9 adds complete owner-safe polling, raw stream ownership, and rich metadata presentation. The Task 7 dashboard tests bind exact canonical URLs and prove no built runtime path can call a deleted route. The live integration test starts the real server on assigned ports, imports the actual dashboard `trafficApi`, installs a test fetch adapter that resolves only its relative URLs against that server, and exercises list/detail/clear/body/promote plus old-route 404s. It may not duplicate route strings in a test-only client.

Update the server `prebuild` script to remove `packages/server/dist` with Node before rebuilding/copying dashboard assets; the clean must occur before `dist/public` is created, not after it. This makes source deletions delete their emitted JavaScript/declarations rather than leaving runnable stale modules.

- [ ] **Step 13: Run Task 7 GREEN gates**

Run: `npm run test --workspace=packages/server -- --run src/runtime/create-runtime.test.ts src/app.test.ts src/routes/setup.test.ts src/routes/admin.test.ts src/routes/admin/repository-integrations.test.ts src/services/proxy-handler.test.ts src/services/proxy-server.test.ts src/services/traffic-provenance.test.ts src/services/response-writer.test.ts src/services/api-errors.test.ts`

Run: `npm run test --workspace=packages/server`

Run: `npm run test:integration --workspace=packages/server -- src/integration/traffic-route-contract.integration.test.ts src/integration/versioned-core.integration.test.ts src/integration/import-preview.integration.test.ts`

Run: `npm run test --workspace=packages/dashboard`

Run: `npm run typecheck --workspace=packages/dashboard`

Run: `npm run build`

Run: `node -e "const fs=require('node:fs'); const dir='packages/server/dist/services'; for (const name of fs.readdirSync(dir)) if (/^(logger|proxy)\./.test(name)) { console.error('stale build output: '+name); process.exitCode=1 }"`

Expected: focused tests, live server/dashboard canonical-route contract, complete server/dashboard suites, dashboard `tsc -b`, and the first full build after the Tasks 2-7 atomic cutover PASS, except the explicitly asserted temporary `501 TRAFFIC_PROMOTION_UNAVAILABLE` promotion behavior replaced in Task 8. No source, production build output, or test importer references deleted logger/schema-v3 fields, `/logs`, old create-mock methods, `useLogs`, or `LogsView`.

- [ ] **Step 14: Focused review checkpoint**

Review Task 7 files. Confirm one Traffic finalization per inspected request, no process-global rows, authority precedes path, direct paths never perform upstream I/O, sidecar failures are observational only, old routes/files are deleted, exact-body JSON is never materialized, debug headers are mock-only, and no error leaks a path/secret/body/upstream detail.

**Commit checkpoint (Only with explicit user authorization):** review the baseline-to-current diff for the complete Tasks 2-7 cutover cluster, derive one coherent Slice-3-only patch, and apply only that patch to the index. The cluster is ineligible for any commit if one required hunk must be deferred; never create a partial schema/runtime cutover. If required Slice 3 hunks cannot be separated from baseline hunks, defer unless the user separately authorizes those exact baseline hunks. Then run `git commit -m "feat: cut runtime to schema v4 traffic"`.

### Task 8: Streaming Body Store Staging And Atomic Promotion Receipts

#### Lean Execution Protocol For Tasks 8-15

Tasks 8-15 are reliability milestones, not single agent work units. For these
tasks, this protocol supersedes the plan header's sub-skill recommendation and
the earlier per-subtask review mechanics; it does not relax any domain,
security, ownership, cleanup, performance, or final acceptance requirement.

- Execute one packet at a time in the primary agent session. Do not invoke a
  skill or implementation/review subagent unless the user explicitly requests
  it. A fresh primary-agent conversation may be used between packets when
  context is large.
- Before a packet, read only its listed files, consumed interfaces, and packet
  text. Do not reread the complete plan or rescan the whole repository.
- For each behavior packet, add the focused regression first and run its listed
  focused command once to establish RED for the named reason. Implement the
  packet, then rerun that same command to GREEN. During diagnosis, rerun only
  the failing file or test name; do not repeatedly run the packet or workspace
  suite.
- Batch independent reads/searches and related edits. Keep one implementation
  owner and one todo item per packet; do not create a second agent to duplicate
  investigation or review.
- A packet's completion criteria are a direct inspection performed in the same
  session, not a separate review skill/tool call. Run the task milestone gate
  once after every packet is GREEN, then perform one direct task diff review.
  If that review changes code, rerun only affected focused tests and the task
  milestone gate once more.
- Do not clear npm, Vitest, Vite, TypeScript, Playwright, or `node_modules`
  caches proactively. Healthy caches reduce elapsed time and tool calls. Clear
  only the smallest implicated generated output after reproducing a stale-
  artifact failure; retain the explicit clean-build checks already required by
  this plan.
- Do not run full workspace tests, full builds, Chromium, Graphify, baseline
  capture, or whole-slice review between packets. Run them only at the named
  milestone/final gates below. Record a command once; do not rerun a passing
  unchanged gate for ceremony.
- Preserve strict RED/GREEN, but treat a compile/module-not-found failure as
  valid RED only when the packet intentionally introduces that new module or
  contract. Never weaken an assertion merely to make a packet smaller.

Recommended packet size is 3-8 directly owned files and one focused test
command. Integration files may span more dependencies, but production fixes
must return to the owning packet's focused regression before implementation.

**Files:**
- Modify: `packages/server/src/repository/body-store.ts`
- Modify: `packages/server/src/repository/body-store.test.ts`
- Modify: `packages/server/src/repository/atomic-write.ts`
- Modify: `packages/server/src/repository/atomic-write.test.ts`
- Modify: `packages/server/src/repository/project-repository.ts`
- Modify: `packages/server/src/repository/project-repository.test.ts`
- Modify: `packages/server/src/repository/referential-integrity.ts`
- Modify: `packages/server/src/repository/referential-integrity.test.ts`
- Create: `packages/server/src/repository/traffic-promotion.ts`
- Create: `packages/server/src/repository/traffic-promotion.test.ts`
- Modify: `packages/server/src/runtime/create-runtime.ts`
- Modify: `packages/server/src/routes/admin/traffic.ts`
- Modify: `packages/server/src/routes/admin/repository-integrations.test.ts`
- Modify: `packages/server/src/integration/traffic-route-contract.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 media/encoding/response-header/query normalization; Task 2 canonical Endpoint/response/Variant provenance and repository queue; Task 5 promotion/detail contracts; Task 6 exact response digest lease; Task 7 `TrafficPromoter`.
- Consumes from Task 5 without redeclaration: `TrafficPromotionInput` and `TrafficPromotionResult`.
- Produces: `BodyImportTransaction.stageStream(...)`, `TrafficPromotionReceiptKey`, `TrafficPromotionReceiptLookup`, `PublicationOperation`, `PublicationFailpoints`, `trafficPromotionReceiptKey(trafficId, input)`, repository receipt preflight/recheck operations, and `createTrafficPromoter(dependencies): TrafficPromoter`.

- [ ] **Packet 8A: Stream-stage exact Body Assets (RED/GREEN)**

Use a chunked source larger than the test's maximum single-buffer spy, expected digest/count, normalized media/encoding, pre-existing asset, concurrent same-digest staging, hash mismatch, size mismatch, metadata conflict, stream failure, promotion failure, and rollback cleanup. Assert no `BodyStore.put()` call and no complete source `Buffer` materialization.

**Packet 8A focused command:**

Run: `npm run test --workspace=packages/server -- --run src/repository/body-store.test.ts`

Expected: FAIL because `BodyImportTransaction` supports only `stage(Buffer, metadata)`.

**Packet 8A implementation:** Add the exact `stageStream` contract and share the staging lifecycle.

```ts
export interface BodyImportTransaction {
  stage(bytes: Buffer, metadata: PutBodyMetadata): Promise<BodyAsset>;
  stageStream(
    source: NodeJS.ReadableStream,
    expected: { sha256: string; byteCount: number },
    metadata: { mediaType: string; encoding?: string },
  ): Promise<BodyAsset>;
  getMetadata(assetId: string): Promise<BodyAsset>;
  promote(): Promise<void>;
  rollback(): Promise<void>;
  complete(): Promise<void>;
}
```

Hash/count while writing transaction-owned staging, reject mismatch before publication, normalize metadata first, reuse exact immutable canonical assets, preserve create-if-absent/ancestor identity/failure atomicity, and keep `stage(Buffer)` as the Import Preview adapter over `stageStream(Readable.from(bytes), expected, metadata)` rather than a separate publication path. Every caller awaits `complete()` after promote/rollback settlement. A cleanup failure is recorded/sanitized without replacing a primary operation result or primary error; tests prove no fire-and-forget rejection or leaked transaction-owned path.

- [ ] **Packet 8B: Add the atomic publication hook and receipt replay (RED/GREEN)**

In `atomic-write.test.ts`, first bind `write -> sync -> close -> beforePublish -> rename`, hook rejection cleanup, unchanged destination bytes, and no leaked temporary pointer. The hook must be operation-aware and independent of path naming.

```ts
const command: TrafficPromotionInput = {
  expectedTrafficGeneration: 'tg_1', expectedResponseIdentity: 'resp_1',
  endpoint: { action: 'reuse', endpointId: 'ep_1', expectedRevision: 4 },
  state: { action: 'bind', stateId: 'state_1', expectedRevision: 8 },
};
expect(trafficPromotionReceiptKey('trf_1', command)).toEqual({
  trafficId: 'trf_1', trafficGeneration: 'tg_1', responseIdentity: 'resp_1',
  endpointTarget: { action: 'reuse', endpointId: 'ep_1' },
  stateTarget: { action: 'bind', stateId: 'state_1' },
});
expect(trafficPromotionReceiptKey('trf_1', { ...command,
  endpoint: { ...command.endpoint, expectedRevision: 99 },
  state: { ...command.state, expectedRevision: 100 },
})).toEqual(trafficPromotionReceiptKey('trf_1', command));
```

Include Traffic ID in the stored receipt lookup key. Prove exact receipt returns 200 before live-row lookup/revision validation; same Traffic ID with a different generation/response/Endpoint/State target returns `TRAFFIC_PROMOTION_CONFLICT` even after clear; no receipt plus missing/cross-Project row is indistinguishable 404; live changed review target is `TRAFFIC_PROMOTION_STALE`.

**Packet 8B focused commands:**

Run: `npm run test --workspace=packages/server -- --run src/repository/atomic-write.test.ts`

Expected: FAIL because the atomic writer has no post-sync/pre-rename publication hook.

Run: `npm run test --workspace=packages/server -- --run src/repository/traffic-promotion.test.ts src/repository/project-repository.test.ts`

Expected: FAIL because old captured-mock promotion uses preview bytes/description identity and has no canonical receipt replay.

**Packet 8B implementation:** Import strict promotion contracts and define immutable receipt reconstruction.

```ts
import type {
  TrafficPromotionInput,
  TrafficPromotionResult,
} from '../domain/traffic';

export interface TrafficPromotionReceiptKey {
  trafficId: string; trafficGeneration: string; responseIdentity: string;
  endpointTarget: { action: 'create' } | { action: 'reuse'; endpointId: string };
  stateTarget: { action: 'unbound' } | { action: 'bind'; stateId: string };
}
export type TrafficPromotionReceiptLookup =
  | { state: 'none' }
  | { state: 'exact'; result: TrafficPromotionResult }
  | { state: 'conflict' };
export type PublicationOperation =
  | 'validation'
  | 'bodyStaging'
  | 'candidateCompile'
  | 'generationWrite'
  | 'generationRename'
  | 'bodyPromote'
  | 'pointerWrite'
  | 'pointerPublish'
  | 'memoryPublish'
  | 'resultAttach'
  | 'cleanup';
export interface PublicationFailpoints {
  before(operation: PublicationOperation): Promise<void>;
}
export interface RepositoryPromotionPublication {
  readonly result: TrafficPromotionResult;
  complete(): Promise<void>;
}
export interface AtomicWriteOptions {
  beforePublish?(): Promise<void>;
}
```

Extend the atomic writer's JSON operation with optional `AtomicWriteOptions`. Its `beforePublish` hook runs only after the temporary pointer file is fully written, synchronized, and closed, and immediately before the atomic rename. Hook rejection removes the unpublished temporary file and leaves the old pointer unchanged. Repository promotion calls `before('pointerWrite')` before entering the pointer writer and passes `beforePublish: () => failpoints.before('pointerPublish')`; ordinary atomic writes omit the hook.

Expose `lookupTrafficPromotionReceipt(projectId, trafficId, input): Promise<TrafficPromotionReceiptLookup>` and search append-only `ResponseVariant.trafficProvenance` in the requested Project without requiring live Traffic. Store the complete result booleans and reviewed targets in each receipt so replay does not infer current state. A `create` replay remains a create-target receipt even after its Endpoint exists. The queued mutation repeats the same lookup after entry to close concurrent replay. The binding durability scope is canonical receipt survival across Traffic clear, cache eviction, Variant response editing, and restart; explicitly test all four. Deliberate deletion of the containing canonical Variant/Endpoint follows the existing deletion contract and is outside that receipt-survival guarantee; do not invent an unapproved project-level ledger or deletion restriction.

- [ ] **Packet 8C: Implement canonical targets and the ordered publication core (RED/GREEN)**

Cover create/reuse by exact origin+method+path+query multiset; request headers evidence-only; passthrough-to-mock with dormant data retained; deterministic first equal Variant; append otherwise; existing fallback preserved; first new Variant fallback; delay 0; optional active/other/unbound State; dormant binding while State mode disabled; repeated response headers; discarded transport headers; malformed Content-Type fallback warning; invalid Content-Encoding rejection; encoded body digest/delivery parity; and `ASSET_METADATA_CONFLICT`.

**Packet 8C focused command:**

Run: `npm run test --workspace=packages/server -- --run src/repository/traffic-promotion.test.ts src/repository/referential-integrity.test.ts`

Expected: FAIL because canonical promotion behavior and append-only first-class provenance are absent.

**Packet 8C implementation:** Implement the exact 16-step promotion ordering.

Implement and test this ordering without reordering:

1. Check requested Project canonical receipts for exact Traffic ID/generation/response/Endpoint-target/State-target key, excluding revisions; return exact result.
2. Return `TRAFFIC_PROMOTION_CONFLICT` for any non-matching receipt with that Traffic ID.
3. Atomically acquire live immutable row-generation snapshot plus exact response digest lease; missing/cross-Project is 404 and changed generation/identity is stale.
4. Enter one Project mutation queue entry carrying that snapshot and lease.
5. Recheck exact/conflicting receipts and release if another command published.
6. Re-read canonical Project state and validate only the explicitly referenced Endpoint and App State revisions without reacquiring Traffic.
7. Recompute request and response identities from the accepted snapshot, derive the deterministic current create/reuse Endpoint and Variant targets from those identities, require the public Endpoint action/ID to match the reviewed command, and return `TRAFFIC_PROMOTION_STALE` when the live identity-derived review no longer matches. The public command has no Variant target and must not gain one.
8. Stream-stage exact leased bytes into the Body Store.
9. Clone one canonical Project snapshot.
10. Create/reuse Endpoint and Variant, set mode, append the full immutable receipt, and apply optional binding.
11. Validate referential integrity and compile candidate.
12. Write and rename one generation.
13. Promote operation-owned Body Assets.
14. Publish generation pointer and reconcile memory once.
15. Through the private accepted-promotion capability, attach result only if the same Traffic generation remains live.
16. Settle the accepted capability and complete repository/body cleanup exactly once.

Expose repository methods `lookupTrafficPromotionReceipt(projectId, trafficId, input): Promise<TrafficPromotionReceiptLookup>` for steps 1-2 and `promoteTraffic(snapshot: TrafficRowLeaseSnapshot, lease: TrafficBodyLease, input: TrafficPromotionInput): Promise<RepositoryPromotionPublication>` for steps 4-14. `promoteTraffic` enters the existing per-Project queue exactly once and performs the mandatory step-5 receipt recheck. On success it returns the immutable result plus an exact-once cleanup capability; on failure before return it completes its own rollback/cleanup before throwing. The private promoter, not the repository, owns steps 15-16. Do not call ordinary `BodyStore.put()`.

- [ ] **Packet 8D: Close failure atomicity and wire the real promoter (RED/GREEN)**

Inject failure at every `PublicationOperation`: validation, body staging, candidate compile, generation write, generation rename, Body Asset promotion, pointer write, pointer publication, post-pointer/pre-memory publication, result attachment, and cleanup. Call the injected `PublicationFailpoints.before(operation)` at each named semantic boundary in repository/Body transaction or private promoter code; never infer an operation from a filesystem path or fail an arbitrary next filesystem call. Extend `CreateRuntimeOptions` in this task with an optional no-op-by-default `publicationFailpoints` owner for deterministic unit/integration injection. Focused Task 8 tests exercise every operation; Task 14 may select representative publication boundaries while its harness exposes the complete typed operation union. Pointer rename is the durable commit point: if `memoryPublish` fails after it, the repository must reload the pointer-selected generation and install that canonical in-memory snapshot before surfacing the failure, so immediate same-process receipt preflight returns exact. Assert every pre-pointer failure publishes no Endpoint/Variant/binding/mode/pointer/owned asset; pointer-written but unpublished temporary state is cleaned; cleanup errors preserve the primary result/error; clear/row eviction after lease acquisition cannot cancel accepted promotion or deadlock result attachment; every post-pointer failure immediately replays to the exact 200 result in the same process and after restart; and response loss requires no second mutation.

**Packet 8D focused command:**

Run: `npm run test --workspace=packages/server -- --run src/repository/traffic-promotion.test.ts src/repository/project-repository.test.ts src/repository/body-store.test.ts src/repository/atomic-write.test.ts`

Expected: FAIL until all injected boundaries preserve one publication and exact receipt replay.

**Packet 8D implementation:** Wire the real promoter and canonical route.

Runtime-private composition obtains `{ service, promotionAcceptor }` from the Traffic implementation, exposes only `service` on `RuntimeContext`, and constructs `createTrafficPromoter({ repository, promotionAcceptor, publicationFailpoints })`. Replace the Task 7 stub, parse strict input, and return 200 for both first success and exact replay. Update the live actual-dashboard-client route contract to seed eligible Traffic and assert the real first `200` result plus exact `200` replay rather than Task 7's temporary `501`. The promoter first calls repository receipt preflight; exact returns immediately, conflict fails immediately, and only `none` accepts the private `AcceptedTrafficPromotion` with generation and response-identity guards. It passes that capability's snapshot/lease to queued repository steps 4-14, calls `before('resultAttach')`, then calls `accepted.attachResult(publication.result)` for step 15. Step 16 uses nested `try/finally` (or independent all-settled owners): a throwing `before('cleanup')` is recorded but cannot skip `publication.complete()` or `accepted.settle()`, each runs exactly once, and the initiating operation result/error remains primary if cleanup also fails. Every non-replay path obtains and settles its snapshot/lease only through this private capability, never through public `TrafficService` or direct store/cache access. Map unavailable/truncated/evicted/stale/conflict/revision/metadata/invalid/internal failures to approved codes and sanitized request-ID-bearing errors.

- [ ] **Milestone 8 gate: Run the combined promotion checks once**

Run: `npm run test --workspace=packages/server -- --run src/repository/body-store.test.ts src/repository/atomic-write.test.ts src/repository/traffic-promotion.test.ts src/repository/project-repository.test.ts src/repository/referential-integrity.test.ts src/routes/admin/repository-integrations.test.ts src/runtime/create-runtime.test.ts`

Run: `npm run test:integration --workspace=packages/server -- src/integration/traffic-route-contract.integration.test.ts`

Expected: PASS with streaming stage, exact target/replay, clear races, encoded parity, failure atomicity, and the live actual-dashboard-client promotion route returning/replaying the canonical result.

- [ ] **Milestone 8 direct review checkpoint**

Review Task 8 against the 16 ordered steps line-by-line. Confirm revisions are guards but not receipt-key fields, receipts precede live-row lookup, accepted snapshots never reacquire tombstoneable Traffic, no complete body Buffer exists, pointer publication occurs once, and every lease/body transaction has exact-once success/failure cleanup.

**Commit checkpoint (Only with explicit user authorization):** derive/review a Task 8 Slice-3-only patch against the external baseline and apply only that patch to the index; defer if baseline hunks cannot be separated. Then run `git commit -m "feat: add atomic traffic promotion receipts"`.

### Task 9: Harden Dashboard Traffic Ownership And Add The Metadata Inspector

**Files:**
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/api/client.test.ts`
- Modify: `packages/dashboard/src/hooks/useTraffic.ts`
- Modify: `packages/dashboard/src/hooks/useTraffic.test.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.test.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.tsx`
- Modify: `packages/dashboard/src/components/ProjectList.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 5 public Traffic contracts and Task 7's minimal canonical Traffic API, hook, navigation, and raw body `Response` ownership.
- Produces: complete dashboard Traffic mirrors, hardened owner-safe `UseTrafficReturn`, body-download URL ownership, and metadata-rich `TrafficView` selection consumed by Tasks 10-13.

- [ ] **Packet 9A: Confirm the canonical Traffic API baseline (GREEN regression)**

```ts
await trafficApi.list('prj/a', { afterId: 'trf/1', limit: 100 }, signal);
expect(fetch).toHaveBeenCalledWith(
  '/api/admin/projects/prj%2Fa/traffic?afterId=trf%2F1&limit=100',
  expect.objectContaining({ signal }),
);
const raw = await trafficApi.body('prj_1', 'trf_1', 'response', signal);
expect(raw).toBe(response);
expect(raw.text).not.toHaveBeenCalled();
expect(trafficApi.bodyDownloadUrl('prj/1', 'trf/1', 'response')).toBe(
  '/api/admin/projects/prj%2F1/traffic/trf%2F1/bodies/response?download=1',
);
```

Assert no client URL contains `/logs` or `create-mock`, promotion sends the exact strict union, ordinary body reads return raw `Response`, and `bodyDownloadUrl()` returns the canonical encoded route without starting fetch.

**Packet 9A focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts`

Expected: PASS because Task 7 already owns raw responses, encoded Download URLs, the strict promotion union, and complete Task 5 public mirrors. This is a regression gate, not a new-behavior RED step.

**Packet 9A completion criteria:** Keep exact mirrors and canonical client methods as the hook foundation.

```ts
export const trafficApi = {
  list(projectId: string, query: TrafficQuery = {}, signal?: AbortSignal): Promise<TrafficPage>,
  detail(projectId: string, trafficId: string, signal?: AbortSignal): Promise<TrafficDetail>,
  clear(projectId: string): Promise<void>,
  body(projectId: string, trafficId: string, side: 'request' | 'response',
    signal?: AbortSignal): Promise<Response>,
  bodyDownloadUrl(projectId: string, trafficId: string,
    side: 'request' | 'response'): string,
  promote(projectId: string, trafficId: string,
    input: TrafficPromotionInput): Promise<TrafficPromotionResult>,
};
```

Do not change these already-GREEN Task 7 methods unless the hook RED reveals an ownership defect. Keep generic JSON handling away from body routes, mirror repeated header tuples/descriptors/provenance exactly, and keep API errors sanitized. Task 9's first new-behavior RED is Packet 9B's hook ownership suite.

- [ ] **Packet 9B: Harden Traffic hook ownership and polling (RED/GREEN)**

Cover initial page, `afterId`, reset, deduplication, pause, no overlapping list request, detail ownership, clear ownership, selection removal on retention reset, synchronous project invalidation in `useLayoutEffect`, and stale success/error/progress/finally suppression by Project + generation + controller identity.

**Packet 9B focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/useTraffic.test.tsx`

Expected: FAIL on the first missing owner-safe polling/detail/clear behavior in the basic Task 7 `useTraffic`; module-not-found and old-Logs failures are not valid RED evidence here.

**Packet 9B implementation:** Implement owner-safe `useTraffic` without weakening current patterns.

```ts
export interface UseTrafficReturn {
  entries: TrafficSummary[];
  selected: TrafficDetail | null;
  detailLoading: boolean; loading: boolean; clearing: boolean;
  error: ApiClientError | Error | null;
  paused: boolean; setPaused(value: boolean): void;
  select(trafficId: string | null): void;
  refresh(): Promise<boolean>;
  refreshSelected(): Promise<TrafficDetail | null>;
  clear(): Promise<boolean>;
}
export function useTraffic(projectId: string | undefined, options?: {
  enabled?: boolean; pollIntervalMs?: number;
}): UseTrafficReturn;
```

Invalidate controllers/cursors/selection synchronously at layout commit on Project change. Preserve structured API errors, expose only owner-current selected detail/results, and return `false` for stale, aborted, or failed refresh/clear publication. Keep list polling independent of body and promotion work introduced later.

- [ ] **Packet 9C: Build the owner-safe metadata workspace (RED/GREEN)**

Assert only Traffic navigation remains; table/cards show origin, method/path/status/duration/size/outcome; inspector shows allowlist, matcher/Endpoint mode, routing decision, App State mode/active/base/selected IDs, resolution/fallback, repeated redacted headers, descriptor states, capture/promotion state, and immediate previews. Assert secrets never render and responsive table/card selection remains owner-safe.

**Packet 9C focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/components/TrafficView.test.tsx src/components/ProjectList.test.tsx src/App.test.tsx`

Expected: FAIL because the minimal Task 7 Traffic view does not yet render the complete provenance/descriptor metadata or responsive owner-safe inspector behavior.

**Packet 9C implementation:** Implement the complete metadata inspector.

Wire `useTraffic` only while Traffic is active, preserve incremental toolbar/pause/refresh/clear and split-pane ownership, render bounded previews immediately, and reserve body panes/promote controls for Tasks 11-12. Keep Task 7's completed Logs-route/name/component deletion intact; this task must not recreate aliases or perform a second cutover.

- [ ] **Milestone 9 gate: Run the combined dashboard checks once**

Run: `npm run test --workspace=packages/dashboard -- --run src/api/client.test.ts src/hooks/useTraffic.test.tsx src/components/TrafficView.test.tsx src/components/ProjectList.test.tsx src/App.test.tsx`

Run: `npm run typecheck --workspace=packages/dashboard`

Expected: PASS with canonical API calls, owner-safe polling/detail, metadata provenance, redaction, and no Logs navigation.

- [ ] **Milestone 9 direct review checkpoint**

Review Task 9 files. Confirm raw body `Response` ownership never enters generic JSON, Project switch invalidates at layout commit, list polling cannot be blocked by detail work, stale finally handlers cannot clear a newer owner, secrets remain masked, and old names/routes/components are absent from dashboard runtime code.

**Commit checkpoint (Only with explicit user authorization):** derive/review a Task 9 Slice-3-only patch against the external baseline and apply only that patch to the index; defer if baseline hunks cannot be separated. Then run `git commit -m "feat: harden dashboard traffic workspace"`.

### Task 10: Shared Body Document Cache, CodeMirror Surface, And Mock Body Editor Migration

**Files:**
- Modify: `packages/dashboard/package.json`
- Create: `packages/dashboard/src/state/bodyDocumentCache.ts`
- Create: `packages/dashboard/src/state/bodyDocumentCache.test.ts`
- Create: `packages/dashboard/src/components/BodyDocumentEditor.tsx`
- Create: `packages/dashboard/src/components/BodyDocumentEditor.test.tsx`
- Modify: `packages/dashboard/src/components/BodyEditor.tsx`
- Modify: `packages/dashboard/src/components/BodyEditor.test.tsx`
- Modify: `packages/dashboard/src/components/VariantEditor.tsx`
- Modify: `packages/dashboard/src/components/VariantEditor.test.tsx`
- Modify: `packages/dashboard/src/state/bodyDrafts.ts`
- Modify: `packages/dashboard/src/state/bodyDrafts.test.ts`
- Modify: `packages/dashboard/src/workers/json-worker-client.ts`
- Modify: `packages/dashboard/src/workers/json-worker-client.test.ts`
- Modify: `packages/dashboard/src/workers/json.worker.ts`

**Interfaces:**
- Consumes: Task 9 raw body `Response` ownership and existing Variant dirty/publication owners; CodeMirror packages installed in this task.
- Produces: `BodyDocumentIdentity`, `BodyDocumentCache`, `BodyDocumentHandle`, `BodyDocumentEditor`, CodeMirror `EditorState`/`Text`-backed mock drafts, and shared cache provider consumed by Task 11.

- [ ] **Packet 10A: Install the approved CodeMirror surface**

Run:

```bash
npm install --workspace=packages/dashboard @codemirror/commands @codemirror/lang-json @codemirror/language @codemirror/search @codemirror/state @codemirror/view
```

Expected: `packages/dashboard/package.json` records exactly those six dependencies. The ignored root `package-lock.json` may change locally but remains ignored and unstaged; `.gitignore` remains untouched.

- [ ] **Packet 10B: Build the shared body-document cache (RED/GREEN)**

```ts
const mockIdentity: BodyDocumentIdentity = {
  kind: 'mock', projectId: 'prj_1', endpointId: 'ep_1', variantId: 'var_1',
  variantRevision: 3, bodyAssetId: 'a'.repeat(64),
};
const trafficIdentity: BodyDocumentIdentity = {
  kind: 'traffic', projectId: 'prj_1', trafficId: 'trf_1', side: 'response',
  sha256: 'b'.repeat(64),
};
```

Assert same identity deduplicates concurrent loads; only two loads run; active selection is prioritized; a third distinct load cancels oldest inactive; Project switch rejects stale success/error/progress/finally; clean LRU caps at 12 and 256 MiB; active and dirty mock documents never evict; reopened clean document performs no load; and state preserves selection, scroll, undo, validation generation, and pending immutable Body Asset ownership.

**Packet 10B focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/state/bodyDocumentCache.test.ts`

Expected: FAIL because no shared full-document cache exists.

**Packet 10B implementation:** Implement immutable document identities and scheduler.

```ts
export type BodyDocumentIdentity =
  | { kind: 'mock'; projectId: string; endpointId: string; variantId: string;
      variantRevision: number; bodyAssetId?: string }
  | { kind: 'traffic'; projectId: string; trafficId: string;
      side: 'request' | 'response'; sha256: string };
export interface BodyDocumentSnapshot {
  state: 'queued' | 'loading' | 'ready' | 'error';
  progress: { loadedBytes: number; totalBytes?: number };
  documentGeneration: number;
  validationGeneration: number;
  byteCount: number;
  editorState?: EditorState;
  error?: string;
}
export interface BodyDocumentHandle {
  identity: BodyDocumentIdentity;
  getSnapshot(): BodyDocumentSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(transaction: Transaction, expectedDocumentGeneration: number): boolean;
  retry(): void; release(): void;
}
export interface BodyDocumentCache {
  acquire(input: { identity: BodyDocumentIdentity; active: boolean; dirty: boolean;
    load(signal: AbortSignal, progress: (loaded: number, total?: number) => void):
      Promise<{ text: Text; byteCount: number; editorState?: EditorState }>;
  }): BodyDocumentHandle;
  setActive(identity: BodyDocumentIdentity | undefined): void;
  setDirty(identity: BodyDocumentIdentity, dirty: boolean): void;
  invalidateProject(projectId: string): void;
}
```

Use request generations and owning component lifetimes for every publication. Keep handle identity stable and publish immutable snapshot objects only when state/progress/document/error changes; React consumers use `useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot)`. `dispatch` rejects stale generations and transactions whose `startState` is not the cache-owned current state; accepted transactions update the cache-owned `EditorState`, exact UTF-8 byte count from changed ranges, document generation, and validation generation before one immutable publication. No React-owned or adapter-private editor state side channel is permitted. Evict clean least-recently-used documents only and count full UTF-8 byte sizes toward 256 MiB.

**Packet 10B completion criteria (no separate review call):** Confirm the focused command is GREEN, then directly inspect two-load ownership, owner-safe progress/error/finally publication, immutable snapshots, exact LRU/byte limits, and active/dirty protection before editor work.

- [ ] **Packet 10C: Add the project-owned CodeMirror adapter (RED/GREEN)**

Assert editable/read-only modes, accessible label, keyboard edit/search/undo, complete-document search, viewport rendering, selection/scroll persistence, two consecutive transactions before a React rerender, stale generation and mismatched `startState` rejection, JSON extension below/equal 1 MiB, large-body mode only above 1 MiB with wrapping/parsing disabled and explanatory copy, and no controlled full string passed back on every keystroke.

**Packet 10C focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/components/BodyDocumentEditor.test.tsx`

Expected: FAIL because the shared CodeMirror adapter does not exist.

**Packet 10C implementation:** Implement the project-owned CodeMirror adapter.

```ts
export interface BodyDocumentEditorProps {
  ariaLabel: string;
  handle: BodyDocumentHandle;
  snapshot: BodyDocumentSnapshot & {
    state: 'ready'; editorState: EditorState;
  };
  mode: 'editable' | 'readonly';
  mediaType: string;
}
export const LARGE_BODY_MODE_BYTES = 1 * 1024 * 1024;
```

Create/destroy one `EditorView` per document identity, route every transaction through `handle.dispatch(transaction, handle.getSnapshot().documentGeneration)`, and synchronously update the view from the newly published cache snapshot so consecutive transactions before a React rerender still start from the cache-owned current state. Reject a stale generation or mismatched `transaction.startState`; never expose `onStateChange` or another React-owned mutation path. Use `EditorState.readOnly`, commands/search/history, `snapshot.byteCount` for the exact large-mode threshold, JSON language only at or below 1 MiB, no wrapping above 1 MiB, and preserve focus/clipboard/selection/undo. Materialize full strings only for Worker validate/format, upload, explicit copy/export, and tests.

**Packet 10C completion criteria (no separate review call):** Confirm the focused command is GREEN, then directly inspect complete-document search, accessible edit/read-only behavior, the exact large-mode threshold, absence of a controlled full-string render loop, and deterministic `EditorView` destruction before mock-editor migration.

- [ ] **Packet 10D: Migrate mock bodies without losing draft ownership (RED/GREEN)**

Assert opening a 10 MiB mock body keeps unrelated controls interactive, cache revisit does not redownload, edit/format/validation/upload remain generation-owned, pending assets are frozen, dirty guard survives Variant switching, revision conflict keeps draft/selection/undo, and post-commit canonical refresh failure uses existing GET-only recovery without repeating upload/update.

**Packet 10D focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/components/BodyEditor.test.tsx src/components/VariantEditor.test.tsx src/state/bodyDrafts.test.ts src/workers/json-worker-client.test.ts`

Expected: FAIL because mock editor remains a controlled textarea and draft state stores complete strings as React state.

**Packet 10D implementation:** Migrate mock documents to shared cache and CodeMirror.

Keep existing Body Editor layout, labels, notices, Save Body/Format JSON controls, dirty ownership, Variant save ownership, conflict recovery, and immutable pending asset behavior. Worker requests carry document identity plus validation/format generation; stale worker responses never mutate newer documents. Upload materializes one string at the explicit boundary only.

- [ ] **Milestone 10 gate: Run the dashboard body-document checks once**

Run: `npm run test --workspace=packages/dashboard`

Run: `npm run typecheck --workspace=packages/dashboard`

Run: `npm run build --workspace=packages/dashboard`

Expected: PASS with two-load/LRU limits, CodeMirror policy, owner-safe Worker/upload publication, and preserved mock dirty/recovery behavior.

- [ ] **Milestone 10 direct review checkpoint**

Review Task 10 files and `packages/dashboard/package.json`. Confirm exactly six CodeMirror packages, no `.gitignore` edit, no controlled textarea, no full-string render loop, active/dirty documents are protected, stale progress/finally is rejected, and package-lock remains ignored/untracked by policy.

**Commit checkpoint (Only with explicit user authorization):** derive/review a Task 10 Slice-3-only patch against the external baseline and apply only that patch to the index, excluding ignored `package-lock.json`; defer if baseline hunks cannot be separated. Then run `git commit -m "feat: add shared codemirror body documents"`.

### Task 11: Traffic Exact Body Pane, Text Streaming, And Binary Download

**Files:**
- Create: `packages/dashboard/src/components/TrafficBodyPane.tsx`
- Create: `packages/dashboard/src/components/TrafficBodyPane.test.tsx`
- Create: `packages/dashboard/src/state/trafficBodyLoader.ts`
- Create: `packages/dashboard/src/state/trafficBodyLoader.test.ts`
- Modify: `packages/dashboard/src/state/bodyDocumentCache.ts`
- Modify: `packages/dashboard/src/state/bodyDocumentCache.test.ts`
- Modify: `packages/dashboard/src/components/TrafficView.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 9 `TrafficDetail`, `TrafficBodyDescriptor`, `trafficApi.body(...)`, and `trafficApi.bodyDownloadUrl(...)`; Task 10 `BodyDocumentIdentity`, `BodyDocumentCache`, `BodyDocumentHandle`, and read-only `BodyDocumentEditor`.
- Produces: `TrafficBodyPresentation`, `classifyTrafficBody(input): TrafficBodyPresentation`, `TrafficBodyLoadResult`, `loadTrafficTextBody(input): Promise<TrafficBodyLoadResult>`, and `TrafficBodyPane` request/response exact-body behavior consumed by Task 12.

- [ ] **Packet 11A: Classify and stream exact Traffic text bodies (RED/GREEN)**

```ts
expect(classifyTrafficBody({
  descriptor: {
    side: 'response', state: 'available', mediaType: 'application/json; charset=utf-8',
    observedSize: 4, retainedSize: 4, sha256: 'a'.repeat(64),
  },
})).toEqual({ kind: 'text', mediaType: 'application/json; charset=utf-8' });

expect(classifyTrafficBody({
  descriptor: {
    side: 'response', state: 'available', mediaType: 'application/json',
    contentEncoding: 'gzip', observedSize: 4, retainedSize: 4, sha256: 'b'.repeat(64),
  },
})).toEqual({ kind: 'binary', reason: 'content_encoded' });

expect(classifyTrafficBody({
  descriptor: {
    side: 'request', state: 'truncated', observedSize: 50 * 1024 * 1024 + 1,
    reason: 'body_limit_exceeded',
  },
})).toEqual({ kind: 'blocked', reason: 'truncated' });
```

Drive `loadTrafficTextBody` with a `ReadableStream<Uint8Array>` split across UTF-8 code-point boundaries. Assert incremental progress, fatal decoding for malformed UTF-8, cancellation of the reader and fetch owner, no `response.text()`/`arrayBuffer()` call, and one final immutable CodeMirror `Text` publication.

**Packet 11A focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/state/trafficBodyLoader.test.ts`

Expected: FAIL because Traffic exact-body classification and streamed text loading do not exist.

**Packet 11A implementation:** Implement exact text/binary classification and streamed decoding.

```ts
export type TrafficBodyPresentation =
  | { kind: 'text'; mediaType: string }
  | { kind: 'binary'; reason: 'binary_media_type' | 'content_encoded' }
  | { kind: 'blocked'; reason: 'unavailable' | 'truncated' | 'evicted' };

export interface TrafficBodyLoadResult {
  text: Text;
  byteCount: number;
  mediaType: string;
}

export function classifyTrafficBody(input: {
  descriptor: TrafficBodyDescriptor;
}): TrafficBodyPresentation;

export async function loadTrafficTextBody(input: {
  response: Response;
  expected: { sha256: string; byteCount: number; mediaType: string };
  signal: AbortSignal;
  onProgress(loadedBytes: number, totalBytes: number): void;
}): Promise<TrafficBodyLoadResult>;
```

Treat `text/*`, JSON (`application/json` and `+json`), XML (`application/xml`, `text/xml`, and `+xml`), JavaScript, and form URL encoding as text only when `contentEncoding` is absent. Read with `response.body.getReader()`, use fatal streaming UTF-8 decoding, require `Content-Length` and `X-MockMate-Sha256` to equal the accepted descriptor, verify the observed byte count before publication, and reject any stale progress/success/error/finalization through the Task 10 cache owner. The server/cache remains the byte-digest verifier; the dashboard must not buffer a second complete byte copy merely to rehash it. Never decode binary or content-encoded bytes.

- [ ] **Packet 11B: Add the exact body pane and binary Download (RED/GREEN)**

```tsx
render(<TrafficBodyPane
  projectId="prj_1"
  trafficId="trf_1"
  side="response"
  descriptor={{
    side: 'response', state: 'available', mediaType: 'text/plain',
    observedSize: 5, retainedSize: 5, sha256: 'c'.repeat(64),
  }}
  preview={{ encoding: 'utf8', value: 'hello', truncated: false }}
  cache={cache}
/>);

expect(screen.getByText('hello')).toBeVisible();
expect(screen.getByLabelText('Response exact body progress')).toBeVisible();
await screen.findByRole('textbox', { name: 'Response exact body' });
```

Assert preview renders before the deferred body response settles; load progress does not replace or block the Traffic table; Retry creates a new generation; cached revisit sends no fetch and no full-panel loader; request and response identities remain independent; rapid row/side/Project switching suppresses stale work; binary preview remains bounded base64/hex and creates no editor; Download uses an anchor with `trafficApi.bodyDownloadUrl(...)` and does not call `fetch`; and unavailable/truncated/evicted states show distinct recovery copy and status.

**Packet 11B focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/components/TrafficBodyPane.test.tsx src/components/TrafficView.test.tsx`

Expected: FAIL because `TrafficView` only displays bounded previews and has no shared-cache exact body pane or binary Download.

**Packet 11B implementation:** Implement the exact Traffic body pane.

Acquire Traffic document identity `{ kind: 'traffic', projectId, trafficId, side, sha256 }` only for available text. Keep preview visible during queued/loading/error states, render Task 10 CodeMirror read-only after verified publication, expose complete-document search, and release the handle when its owning row/side/component lifetime ends. For binary/content-encoded bodies, retain the bounded preview and use a normal anchor/navigation to `trafficApi.bodyDownloadUrl(...)` so the browser streams the attachment without constructing `Text`, `EditorState`, a data URL, `Blob`, or a complete JavaScript buffer.

Render exact descriptor recovery:

```ts
const bodyStateCopy = {
  unavailable: 'Exact body was not retained. The bounded preview is still available.',
  truncated: 'Exact body exceeded the 50 MiB capture limit and cannot be promoted.',
  evicted: 'Exact body was evicted from the ephemeral cache and cannot be reloaded.',
} as const;
```

When an available text load fails, preserve preview and show Retry plus Download. Retry cancellation aborts the dashboard-owned fetch without changing the descriptor. Native anchor Download has no component `AbortController`; browser navigation/connection close owns cancellation, and the server route's finish/close/abort handlers release its lease exactly once.

- [ ] **Milestone 11 gate: Run the exact-body dashboard checks once**

Run: `npm run test --workspace=packages/dashboard -- --run src/state/trafficBodyLoader.test.ts src/state/bodyDocumentCache.test.ts src/components/TrafficBodyPane.test.tsx src/components/TrafficView.test.tsx src/App.test.tsx`

Run: `npm run typecheck --workspace=packages/dashboard`

Run: `npm run build --workspace=packages/dashboard`

Expected: PASS with immediate preview, verified lazy text, exact binary Download, cached revisit, two-load scheduling, and owner-safe cancellation.

- [ ] **Milestone 11 direct review checkpoint**

Review Task 11 files. Confirm no binary or content-encoded body reaches decoding/CodeMirror, no generic JSON client owns a body stream, descriptor/header/observed-length agreement precedes publication, preview survives every exact-load failure, Project/row/side/request generations guard all callbacks, and list interaction never waits on body work.

**Commit checkpoint (Only with explicit user authorization):** do not run a whole-file `git add` here because `TrafficView.tsx`, `TrafficView.test.tsx`, `App.tsx`, and `App.test.tsx` contain protected baseline work. Derive/review a Task 11 Slice-3-only patch and apply only that patch to the index. Defer unless the complete dependency cluster can be separated or the exact overlapping baseline hunks are separately authorized. Then run `git commit -m "feat: add exact traffic body inspection"`.

### Task 12: Mock This, App State, Endpoint, And Interception Orchestration

**Files:**
- Create: `packages/server/src/routes/admin/interception-guidance.ts`
- Create: `packages/server/src/routes/admin/interception-guidance.test.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Modify: `packages/server/src/repository/project-repository.ts`
- Modify: `packages/server/src/repository/project-repository.test.ts`
- Modify: `packages/dashboard/src/api/types.ts`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/api/client.test.ts`
- Create: `packages/dashboard/src/hooks/useInterceptionGuidance.ts`
- Create: `packages/dashboard/src/hooks/useInterceptionGuidance.test.tsx`
- Create: `packages/dashboard/src/components/MockThisDialog.tsx`
- Create: `packages/dashboard/src/components/MockThisDialog.test.tsx`
- Create: `packages/dashboard/src/components/InterceptionSettings.tsx`
- Create: `packages/dashboard/src/components/InterceptionSettings.test.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.tsx`
- Modify: `packages/dashboard/src/components/TrafficView.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointList.tsx`
- Modify: `packages/dashboard/src/components/EndpointList.test.tsx`
- Modify: `packages/dashboard/src/components/AppStateSwitcher.tsx`
- Modify: `packages/dashboard/src/components/AppStateSwitcher.test.tsx`
- Modify: `packages/dashboard/src/components/import/ImportWizard.tsx`
- Modify: `packages/dashboard/src/components/import/ImportWizard.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`
- Modify: `packages/dashboard/src/App.import-integration.test.tsx`

**Interfaces:**
- Consumes: Task 3 `ImportPreview.discoveredOrigins`; Task 5 `TrafficPromotionInput`/`TrafficPromotionResult`; Task 8 canonical receipt replay; Task 9 `useTraffic.refreshSelected`; Task 11 exact-body states; schema-v4 Endpoint/App State/runtime settings contracts from Task 2.
- Produces: `InterceptionGuidance`, `InterceptionGuidanceOrigin`, `MockThisChoice`, `MockThisOwner`, `interceptionGuidanceApi.get(projectId, origins, signal): Promise<InterceptionGuidance>`, `projectsApi.updateRuntimeSettings(projectId, input: RuntimeSettingsUpdateInput): Promise<ProjectRuntimeSettings>`, `useInterceptionGuidance(projectId, discoveredOrigins)`, reviewed `MockThisDialog`, and explicit single-save interception settings.

- [ ] **Packet 12A: Add deterministic read-only interception guidance (RED/GREEN)**

```ts
expect(buildInterceptionGuidance({
  endpointOrigins: ['https://api.example.test', 'http://events.example.test:8080'],
  importOrigins: ['https://upload.example.test'],
  configuredPatterns: ['*.example.test', 'unused.test'],
})).toEqual({
  configuredPatterns: ['*.example.test', 'unused.test'],
  origins: [
    { origin: 'http://events.example.test:8080', hostname: 'events.example.test',
      source: 'endpoint', coveredBy: '*.example.test', missing: false },
    { origin: 'https://api.example.test', hostname: 'api.example.test',
      source: 'endpoint', coveredBy: '*.example.test', missing: false },
    { origin: 'https://upload.example.test', hostname: 'upload.example.test',
      source: 'import', coveredBy: '*.example.test', missing: false },
  ],
  unusedPatterns: ['unused.test'],
});
```

Assert exact/wildcard coverage uses Task 1 semantics, duplicate origins collapse, origins remain scheme/port-specific while suggestions are exact hostnames, wildcard suggestions are never invented, local/control origins are rejected, and `GET /api/admin/projects/:projectId/interception-guidance?origin=<encoded>` is strict, bounded, Project-scoped, and read-only.

Add a configured pattern that covers only an ephemeral Import origin. Its Import-origin row has `coveredBy`, but the pattern remains in `unusedPatterns` because unused status is determined exclusively against canonical Endpoint hostnames.

**Packet 12A focused command:**

Run: `npm run test --workspace=packages/server -- --run src/routes/admin/interception-guidance.test.ts src/repository/project-repository.test.ts`

Expected: FAIL because no canonical Endpoint/import/settings guidance service or route exists.

**Packet 12A implementation:** Implement deterministic read-only guidance.

```ts
export interface InterceptionGuidanceOrigin {
  origin: string;
  hostname: string;
  source: 'endpoint' | 'import';
  coveredBy?: string;
  missing: boolean;
}

export interface InterceptionGuidance {
  configuredPatterns: string[];
  origins: InterceptionGuidanceOrigin[];
  unusedPatterns: string[];
}

export function buildInterceptionGuidance(input: {
  endpointOrigins: readonly string[];
  importOrigins: readonly string[];
  configuredPatterns: readonly string[];
}): InterceptionGuidance;
```

The repository supplies current Endpoint origins and configured patterns; repeated strict `origin` query fields carry the wizard's retained preview origins without server persistence. Compute `coveredBy` across every displayed Endpoint/Import origin, but compute `unusedPatterns` only against canonical Endpoint hostnames. Return exact-host suggestions through `origins.filter(value => value.missing).map(value => value.hostname)`. Do not mutate settings during Endpoint creation, import, Traffic capture, promotion, or guidance reads.

**Packet 12A completion criteria (no separate review call):** Directly inspect the GREEN server guidance contract before dashboard mutation orchestration. Confirm normalization is shared with Task 1, origins retain scheme/port, only exact-host suggestions are produced, all bounds/Project ownership are enforced, and the route is read-only.

- [ ] **Packet 12B: Add the reviewed `Mock This` promotion owner (RED/GREEN)**

```tsx
render(<MockThisDialog
  open
  projectId="prj_1"
  detail={promotableTrafficDetail}
  states={[{ id: 'state_active', name: 'Signed in', revision: 4 }]}
  defaultStateId="state_active"
  onClose={onClose}
  onPromoted={onPromoted}
  refreshCanonical={refreshCanonical}
/>);

expect(screen.getByText('https://api.example.test')).toBeVisible();
expect(screen.getByText('token=[REDACTED]')).toBeVisible();
expect(screen.getByText(/hidden query values will become local canonical matcher configuration/i))
  .toBeVisible();
expect(screen.getByText(/Set-Cookie values will be stored/i)).toBeVisible();
await user.click(screen.getByRole('button', { name: 'Confirm Mock This' }));
expect(trafficApi.promote).toHaveBeenCalledWith('prj_1', 'trf_1', {
  expectedTrafficGeneration: 'tg_1', expectedResponseIdentity: 'resp_1',
  endpoint: { action: 'reuse', endpointId: 'ep_1', expectedRevision: 7 },
  state: { action: 'bind', stateId: 'state_active', expectedRevision: 4 },
});
```

Assert the dialog renders captured origin/method/path/all query occurrences, redacted request evidence, exact response status/repeated normalized headers/media type/encoding/size/digest, create versus exact reuse, Variant create versus normalized reuse, post-promotion Endpoint mode, active/other/unbound State choices, disabled-State dormant-binding copy, dependency revisions, and body recovery. `unavailable`, `truncated`, `evicted`, preview-only response bodies, malformed query evidence, and invalid Content-Encoding disable confirmation. Bind distinct safe recovery copy for `query_parse_invalid` (request cannot become a canonical matcher) and `invalid_content_encoding` (captured entity cannot be reproduced safely); neither state renders a review or submits promotion.

Assert one promotion owner; double submit is ignored. Project/Traffic generation/response/target change invalidates the dialog synchronously. Revision conflict preserves choices and performs trusted GET refresh before allowing a newly reviewed command. A network/5xx loss after submit is an unknown outcome: call GET-only Endpoint/State/Traffic refresh, show created/reused result if canonical receipt is observed, and never automatically repeat POST.

**Packet 12B focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/components/MockThisDialog.test.tsx src/components/TrafficView.test.tsx`

Expected: FAIL because `Mock This` is still an immediate preview-based mutation without review, exact target choices, or unknown-outcome ownership.

**Packet 12B implementation:** Implement the reviewed promotion owner.

```ts
export type MockThisChoice = {
  endpoint:
    | { action: 'create' }
    | { action: 'reuse'; endpointId: string; expectedRevision: number };
  state:
    | { action: 'unbound' }
    | { action: 'bind'; stateId: string; expectedRevision: number };
};

export interface MockThisOwner {
  projectId: string;
  trafficId: string;
  trafficGeneration: string;
  responseIdentity: string;
  requestGeneration: number;
}
```

Build the strict promotion command only from current detail review targets and explicit user choice. Never use masked display text to form the command. Keep exact hidden query/header response values server-owned in the accepted Traffic snapshot. After known success, refresh Endpoint list/detail, State list/detail, and selected Traffic detail under owner tokens before navigation. After unknown outcome, perform the same GET-only reconciliation and leave the dialog recoverable if refresh fails.

**Packet 12B completion criteria (no separate review call):** Directly inspect the GREEN `Mock This` owner before settings and mode orchestration. Confirm current-detail target ownership, synchronous invalidation, no masked-value payload construction, one POST owner, no automatic POST retry, and receipt-based GET-only recovery.

- [ ] **Packet 12C: Orchestrate Endpoint and App State modes (RED/GREEN)**

Assert Endpoint `Mock`/`Passthrough` toggle is separately revisioned, preserves dirty matcher/Variant drafts, keeps dormant Variants/bindings, and explains why passthrough-with-zero-Variants cannot switch to Mock. Assert App State mode off/on retains active/base IDs, disabled mode excludes passthrough/non-ready Endpoints from coverage, and stale mode conflicts preserve selection.

**Packet 12C focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/components/EndpointEditor.test.tsx src/components/EndpointList.test.tsx src/components/AppStateSwitcher.test.tsx`

Expected: FAIL on the first missing mode-owner behavior, then PASS after implementation. Endpoint mode and App State mode mutations each acquire one owner, retain local drafts on `409`, and use GET-only canonical refresh after an unknown outcome. Promotion may bind while State mode is disabled. Coverage/count copy includes only mock-ready Endpoints.

- [ ] **Packet 12D: Orchestrate explicit interception settings and Import guidance (RED/GREEN)**

For settings, assert exact host checklist plus manual wildcard input, one reviewed save with all three fields, catch-all confirmation, no save while guidance/settings revision is stale, and no implicit mutation after import/promotion:

```ts
expect(projectsApi.updateRuntimeSettings).toHaveBeenCalledWith('prj_1', {
  interceptHosts: ['api.example.test', '*.events.example.test'],
  captureRawTraffic: true,
  debugProvenanceHeaders: false,
  expectedRevision: 9,
});
```

**Packet 12D focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/useInterceptionGuidance.test.tsx src/components/InterceptionSettings.test.tsx src/components/import/ImportWizard.test.tsx src/App.test.tsx src/App.import-integration.test.tsx`

Expected: FAIL because old settings update individual passthrough/Project-base-URL fields and reviewed Import guidance is absent.

**Packet 12D implementation:** Implement settings and Import authoring orchestration.

```ts
export function useInterceptionGuidance(
  projectId: string | undefined,
  discoveredOrigins: readonly string[],
): {
  guidance?: InterceptionGuidance;
  loading: boolean;
  error?: string;
  refresh(): Promise<void>;
};
```

Create `InterceptionSettings` as the sole Project runtime settings form. It edits `interceptHosts`, `captureRawTraffic`, and `debugProvenanceHeaders` as one draft and saves the exact full `RuntimeSettingsUpdateInput`; when normalized patterns contain `*`, require the reviewed confirmation and send `confirmInterceptAll: true`. Preserve dirty/navigation guards, settings revision ownership, synchronous Project invalidation, and stale callback suppression. Carry Import wizard `discoveredOrigins` only after successful canonical refresh and let the user choose exact hostname additions; closing/restarting the wizard drops ephemeral suggestions.

- [ ] **Milestone 12 gate: Run the combined orchestration checks once**

Run: `npm run test --workspace=packages/server -- --run src/routes/admin/interception-guidance.test.ts src/repository/project-repository.test.ts src/routes/admin/repository-integrations.test.ts`

Run: `npm run test --workspace=packages/dashboard`

Run: `npm run typecheck --workspace=packages/dashboard`

Run: `npm run build`

Expected: PASS with reviewed exact promotion, owner-safe unknown outcomes, reversible modes, explicit settings, and no implicit allowlist change.

- [ ] **Milestone 12 direct review checkpoint**

Review Task 12 files against the approved review fields and transaction contract. Confirm masked display values never become request payload values, exact Endpoint APIs remain the only trusted matcher-secret exception, POST is never auto-retried after unknown outcome, revision conflicts preserve choices/drafts, each mutation has one owner, import/promotion/guidance remain read-only toward interception until explicit save, and wildcard suggestions are never invented.

**Commit checkpoint (Only with explicit user authorization):** derive/review a Task 12 Slice-3-only patch against the external baseline and apply only that patch to the index; defer if baseline hunks cannot be separated. Then run `git commit -m "feat: orchestrate reviewed traffic promotion"`.

### Task 13: Old Contract, Setup Guidance, And Active Documentation Removal

**Files:**
- Delete: `packages/dashboard/src/components/PassthroughSettings.tsx`
- Modify: `packages/server/src/routes/setup-page.ts`
- Modify: `packages/server/src/routes/setup.test.ts`
- Modify: `README.md`
- Modify: `packages/dashboard/README.md`
- Modify: `docs/Development Plan.md`
- Modify: `docs/Mockmate V2 Passive Income AI.md`
- Create: `docs/traffic-capture.md`
- Create: `tools/traffic-contract-absence.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 2-12 canonical schema, route, settings, dashboard, and setup behavior.
- Produces: root script `test:traffic-absence`, active operator documentation containing only schema-v4 terminology, current setup guidance, and machine-enforced absence gates consumed by Task 15.

- [ ] **Packet 13A: Add the machine-enforced old-contract absence gate (intentional RED guard)**

Add this script to root `package.json`:

```json
{
  "scripts": {
    "test:traffic-absence": "node --test tools/traffic-contract-absence.test.mjs"
  }
}
```

The Node test must inspect the union of tracked and non-ignored untracked runtime source, fixtures, active setup, and active product docs, while deliberately excluding immutable historical Superpowers specs/plans/reviews and research records. Discover candidates from `git ls-files` plus `git ls-files --others --exclude-standard`, filter to paths whose worktree entries still exist before reading or applying active filename checks, then apply explicit active file groups rather than an unrestricted repository search. Separately assert each forbidden deleted path does not exist in the worktree; an unstaged deletion remaining in the index is not an active file. This must work before any staging or commit.

```js
test('schema-v4 direct cutover has no active old contracts', async () => {
  await assertAbsent([...runtimeFiles, ...fixtureFiles],
    /["']?schemaVersion["']?\s*[:=]\s*3\b|(?:SCHEMA_VERSION|SchemaVersion)\s*=\s*3\b|z\.literal\(\s*3\s*\)/,
    'schema v3 values and fixtures');
  await assertAbsent(runtimeFiles,
    /(?:schema(?:Version)?[^\n]{0,40}(?:migration|compat(?:ibility)?|legacy)|(?:migration|compat(?:ibility)?|legacy)[^\n]{0,40}schema(?:Version)?)/i,
    'schema-v3 reader/migration/compatibility entry points');
  await assertAbsent(runtimeFiles, /passthroughEnabled/, 'Project passthrough setting');
  await assertAbsent(runtimeFiles, /\/logs(?:\b|\/)|LogsView|useLogs/, 'Logs contract');
  await assertAbsent(runtimeFiles,
    /createCapturedMock|CapturedMockInput|create-mock|createMockFromTraffic/,
    'preview-based captured mock path');
  await assertAbsent(importFiles,
    /IMPORT_SCHEME_PORT_DISCARDED|discoveredHosts|matcher\.host/,
    'hostname-only Import identity');
});
```

`fixtureFiles` explicitly includes tracked and non-ignored untracked JSON plus TypeScript/JavaScript fixtures under server/dashboard test, integration, and fixture directories; it is not limited to production extensions. Narrowly allow exactly one `schemaVersion: 3` occurrence in `packages/server/src/domain/schemas.test.ts`, only inside the named negative test `rejects schema-v3 persisted documents` and only as the direct input to an assertion that schema-v4 parsing fails. Assert that occurrence count and test context explicitly before removing it from the absence input; no positive fixture, helper, alias, reader, migration, or compatibility path is allowlisted. Also reject active file names containing `schema-v3`, `schema3`, or `v3-fixture`. Add owner-specific assertions: Project model/create/patch/forms have no `baseUrl`; Endpoint matcher model/schema/compiler have no `host`; Endpoint still requires its own `baseUrl`; runtime settings require `debugProvenanceHeaders`; and the canonical `/traffic` route set is present exactly once.

**Packet 13A focused command:**

Run: `npm run test:traffic-absence`

Expected: FAIL and list active old-contract references in setup/product docs or runtime source that remain after Tasks 2-12. It must not fail on archived Superpowers design history.

This is the one intentional RED-only packet: the checker itself must execute and
report only real active-contract findings, but those findings remain RED until
Packet 13B removes them. Do not rerun the unchanged absence command between the
two packets; Milestone 13 runs it once for GREEN.

- [ ] **Packet 13B: Replace stale setup and active documentation (RED/GREEN)**

```ts
const html = setupPageHTML({
  host: '192.0.2.10',
  localAddresses: ['192.0.2.10'],
  ports: { http: 3457, https: 3458, proxy: 8888 },
});
expect(html).toContain('interception allowlist');
expect(html).toContain('Keep your app calling its real backend URL');
expect(html).toContain('192.0.2.10:8888');
expect(html).toContain('192.0.2.10:3457');
expect(html).toContain('192.0.2.10:3458');
expect(html).not.toContain("project's Base URL");
expect(html).not.toContain('Base URL domain');
expect(html).not.toContain('HTTPS URL (use this in your app)');
```

**Packet 13B focused command:**

Run: `npm run test --workspace=packages/server -- --run src/routes/setup.test.ts`

Expected: FAIL because setup still instructs users to point applications at MockMate and configure a Project Base URL/domain.

**Packet 13B implementation:** Replace stale setup and active documentation guidance.

Setup must tell users to install/trust the CA, configure the HTTP proxy, keep applications on their real backend origins, add exact/wildcard hostnames through the reviewed interception allowlist, and expect unselected HTTPS to remain blind/unrecorded. Explain that selected unmatched or passthrough Endpoints forward to the incoming original origin, Traffic exact body capture is off by default, `*` requires confirmation, and direct MockMate requests require a trusted backend Host authority and never perform passthrough.

Rewrite active README/API tables to use only `/traffic`, Endpoint `baseUrl`, Endpoint mode, App State mode, `captureRawTraffic`, and `debugProvenanceHeaders`. Replace old `/api/admin/logs` and Project-base-URL instructions in the two active planning/product documents with a short superseded notice linking `docs/traffic-capture.md`; do not rewrite historical Superpowers specs/plans/reviews because they are durable decision history.

`docs/traffic-capture.md` must contain these exact route lines:

```text
GET    /api/admin/projects/:projectId/traffic
GET    /api/admin/projects/:projectId/traffic/:trafficId
DELETE /api/admin/projects/:projectId/traffic
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/request
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/response
POST   /api/admin/projects/:projectId/traffic/:trafficId/mock
GET    /api/admin/projects/:projectId/interception-guidance
```

Document ephemeral `500` rows, `16 KiB` previews, optional `50 MiB` exact bodies, entity-byte encoding semantics, body-state errors, exact Download, `Mock This`, redaction/trusted Endpoint exception, and no implicit interception changes.

**Packet 13B cleanup:** Remove the remaining active old-contract file and names.

Delete `PassthroughSettings.tsx` after Task 12 has replaced its only import with `InterceptionSettings`. Tasks 7 and 9 already delete logger/proxy/Logs/useLogs source; this task verifies those paths remain absent and removes any surviving imports, exports, navigation, fixtures, or route mounts through normal edits. Do not add aliases, redirects, adapters, compatibility schemas, or deprecated exports. Keep `Endpoint.baseUrl`; remove only Project ownership and hostname matcher ownership.

- [ ] **Milestone 13 gate: Run the absence and focused contract checks once**

Run: `npm run test:traffic-absence`

Run: `npm run test --workspace=packages/server -- --run src/routes/setup.test.ts src/routes/admin.test.ts src/domain/schemas.test.ts`

Run: `npm run test --workspace=packages/dashboard -- --run src/components/ProjectList.test.tsx src/App.test.tsx`

Run: `npm run typecheck --workspace=packages/dashboard`

Expected: PASS with no active schema-v3, Project-base-URL, matcher-host, passthrough-setting, Logs, old captured-mock, hostname-only Import, or stale setup contract.

- [ ] **Milestone 13 direct review checkpoint**

Review deletions and active docs. Confirm the absence checker cannot hide a runtime path behind broad exclusions, Endpoint `baseUrl` was not accidentally removed, archived decision records remain intact, setup no longer tells callers to rewrite backend URLs, all product copy says Traffic rather than Logs, and `.gitignore`/ignored `package-lock.json` are unchanged.

**Commit checkpoint (Only with explicit user authorization):** derive/review a Task 13 Slice-3-only patch against the external baseline and apply only that patch to the index; defer if baseline hunks cannot be separated. Then run `git commit -m "docs: remove obsolete traffic contracts"`.

### Task 14: Multi-Origin Server And Dashboard Integration Acceptance

**Files:**
- Modify: `packages/server/src/integration/integration-harness.ts`
- Modify: `packages/server/src/test-support/proxy-test-client.ts`
- Create: `packages/server/src/test-support/cleanup-report.ts`
- Create: `packages/server/src/test-support/cleanup-report.test.ts`
- Create: `packages/server/src/integration/traffic-capture.integration.test.ts`
- Modify: `packages/server/src/integration/versioned-core.integration.test.ts`
- Modify: `packages/server/src/integration/import-preview.integration.test.ts`
- Create: `packages/dashboard/src/App.traffic-integration.test.tsx`
- Modify: `packages/dashboard/src/App.import-integration.test.tsx`

**Interfaces:**
- Consumes: all canonical server APIs, proxy/direct runtime, exact cache, promotion receipts, dashboard Traffic/document/promotion/settings owners, and the existing `IntegrationHarness`/`ProxyTestClient`.
- Produces: `IntegrationUpstream`, `CleanupManifest`, `CleanupOwnerCloseReport`, `CleanupReport`, streaming/repeated-header proxy client inputs, one complete server acceptance flow, and one complete dashboard owner flow used by final certification.

- [ ] **Packet 14A: Add typed cleanup evidence and owner settlement (RED/GREEN)**

Implement the cleanup-report and owner-close portions of the following contract
first. Defer controllable upstream/proxy behavior to Packet 14B so cleanup has a
small deterministic unit-test loop.

```ts
export interface IntegrationUpstream {
  origin: string;
  scheme: 'http' | 'https';
  hostname: string;
  port: number;
  requests: Array<{ method: string; url: string; headers: string[][]; body: Buffer }>;
  close(): Promise<void>;
}

export interface IntegrationHarness {
  request: SuperTest<Test>;
  repository: ProjectRepository;
  rootDirectory: string;
  tlsTrustBundle: readonly (string | Buffer)[];
  failNext(operation: PublicationOperation, error?: Error): void;
  restart(): Promise<void>;
  proxy(): Promise<ProxyTestClient>;
  readJson(relativePath: string): Promise<unknown>;
  listRootEntries(): Promise<string[]>;
  upstream(options: { scheme: 'http' | 'https'; hostname: string },
    handler: (request: IncomingMessage, response: ServerResponse) => void):
      Promise<IntegrationUpstream>;
  cleanupManifest(): CleanupManifest;
  closeOwners(): Promise<CleanupOwnerCloseReport>;
  dispose(): Promise<CleanupReport>;
}

export const CLEANUP_MANIFEST_FILE = 'cleanup-manifest.json';
export const CLEANUP_OWNER_CLOSE_FILE = 'cleanup-owner-close.json';

export function writeCleanupManifest(
  parentRoot: string,
  manifest: CleanupManifest,
): Promise<void>;
export function readCleanupManifest(parentRoot: string): Promise<CleanupManifest>;
export function extendCleanupManifest(
  parentRoot: string,
  additions: CleanupManifest,
): Promise<CleanupManifest>;
export function writeOwnerCloseReport(
  parentRoot: string,
  report: CleanupOwnerCloseReport,
): Promise<void>;
export function readOwnerCloseReport(
  parentRoot: string,
): Promise<CleanupOwnerCloseReport>;
export function validateOwnerCloseReport(
  parentRoot: string,
  report: CleanupOwnerCloseReport,
): Promise<void>;
export function finalizeCleanup(
  parentRoot: string,
  report: CleanupOwnerCloseReport,
): Promise<CleanupReport>;

export interface CleanupManifest {
  listeners: readonly string[];
  socketOwners: readonly string[];
  roots: readonly Array<{
    owner: 'runtime' | 'traffic-cache' | 'certificates' | 'body-staging'
      | 'upstream' | 'playwright-output' | 'playwright-traces';
    relativePath: string;
    afterOwnerClose: 'absent-or-empty' | 'contained-until-parent-removal';
  }>;
}

export interface CleanupOwnerCloseReport {
  manifest: CleanupManifest;
  closedListeners: readonly string[];
  closedSocketOwners: readonly string[];
  rootsAfterOwnerClose: readonly Array<{
    owner: CleanupManifest['roots'][number]['owner'];
    relativePath: string;
    state: 'absent' | 'empty' | 'contained';
  }>;
}

export interface CleanupReport extends CleanupOwnerCloseReport {
  parentRemoved: boolean;
  rootsAfterParentRemoval: readonly Array<{
    owner: CleanupManifest['roots'][number]['owner'];
    relativePath: string;
    state: 'absent';
  }>;
}
```

Extend proxy methods with independently controlled request-target, CONNECT authority, inner Host authority, ordered headers, streamed body chunks, SNI, and trusted CA. Preserve CONNECT bytes coalesced after its headers, and decode content-length, chunked, and close-delimited responses while exposing a first-byte observation promise/time rather than only a final body. Do not auto-add `Host` when the caller supplies any Host field:

```ts
requestPlain(target: {
  requestTarget: string; method?: string;
  headers?: Array<[string, string]>; bodyChunks?: Buffer[];
}): Promise<ProxyTestResponse>;
requestTls(target: {
  connectAuthority: string;
  connectHeaders?: Array<[string, string]>;
  servername: string;
  ca: string | Buffer | readonly (string | Buffer)[];
  path?: string; method?: string;
  innerHeaders?: Array<[string, string]>; bodyChunks?: Buffer[];
}): Promise<ProxyTestResponse>;
```

Assert harness disposal closes every manifest listener/socket owner and removes only its containment-checked `mockmate-integration-*` root, even after injected failures. The manifest assigns `absent-or-empty` to ephemeral Traffic-cache/body-staging roots and `contained-until-parent-removal` to canonical runtime repository/Body Asset data, certificates, upstream fixture files, and Playwright output/trace artifacts. After owners close but before parent removal, record each root with the same `(owner, relativePath)` identity: ephemeral roots must be `absent`/`empty`, while persistent or diagnostic roots may be nonempty only as `contained` descendants of the parent. Then remove the parent and require every manifest root plus the parent to be absent. `CleanupReport` records both phases with `parentRemoved: true`. Tests require exact one-to-one manifest/report comparisons at both phases and reject duplicate, omitted, additional, escaped, or policy-incompatible entries.

Implement the shared artifact/settlement functions in `cleanup-report.ts` and test them directly. Reads strictly parse the declared schema and reject unknown keys, invalid policies/states, duplicates, escapes, and mismatched manifest identity. Manifest/report writes use temporary-file-plus-rename beneath the checked parent. The launcher writes its output/trace manifest before spawning Playwright; the fixture atomically extends it with runtime-owned identities before starting those owners, then atomically writes the owner-close report after teardown. `IntegrationHarness.closeOwners()` returns phase one and `dispose()` composes `closeOwners()` with `finalizeCleanup()`. If a worker exits before publishing its report, the launcher still containment-removes the parent but records missing cleanup evidence as a cleanup failure. The initiating test/browser error or exit code remains primary; cleanup diagnostics are attached, and cleanup becomes primary only when the initiating operation succeeded. Final certification records the returned report rather than relying on an informal cleanup claim.

**Packet 14A focused command:**

Run: `npm run test --workspace=packages/server -- --run src/test-support/cleanup-report.test.ts`

Expected: FAIL because the typed cleanup settlement helpers do not exist, then
PASS after implementing only the cleanup-report and owner-close lifecycle.

- [ ] **Packet 14B: Extend the upstream and proxy integration harness (RED/GREEN)**

Use the upstream/proxy portions of the contract above for this packet.

**Packet 14B focused command:**

Run: `npm run test:integration --workspace=packages/server -- src/integration/traffic-capture.integration.test.ts`

Expected: FAIL because the controllable streaming upstream/proxy harness is
absent or incomplete, then PASS for its harness-focused assertions before the
complete acceptance flow is added in Packet 14C.

**Packet 14B implementation:** Implement the test-only upstream and exact proxy inputs.

Use loopback `http.createServer` and `https.createServer`, ephemeral ports, test-CA-signed certificates for the requested fixture hostnames, raw ordered headers, chunked request/response helpers, and deterministic close ownership. Expose one harness-owned `tlsTrustBundle` containing the proxy and upstream trust roots. Compose the real Task 4 Node transport and blind-tunnel connector with injected lookup mapping only registered fixture hostnames to loopback; give the transport the fixture CA and inject both owners through Task 7 `CreateRuntimeOptions`. Never disable TLS verification. `ProxyTestClient` trusts the harness bundle for selected MITM and blind upstream TLS, permits absolute-form/Host disagreement, duplicate Host fields, CONNECT/inner-Host mismatch, and separate SNI, and never couples those authorities implicitly. Assert the harness trust bundle succeeds and an unrelated CA fails. Production composition tests prove both Node owners receive no override. Wire Task 8's complete typed operation-specific one-shot failpoint union; a generic next-rename/filesystem hook is insufficient. Task 8 unit tests exercise every operation, while the sequential acceptance invokes generation rename, Body Asset promotion, and pointer publication as representative cross-layer failures. Construct a reduced-limit `ProcessTrafficContext` for the acceptance harness; do not override immutable process limits per runtime. Separate unit tests retain exact production constants.

**Packet 14B completion criteria (no separate review call):** GREEN the harness/runtime transport/lifecycle slice before writing acceptance behavior, then directly inspect independent authority controls, ordered duplicate headers, fixture-CA verification with no `rejectUnauthorized: false`, process-budget injection, partial-start cleanup, and containment-owned teardown.

- [ ] **Packet 14C: Complete the sequential server acceptance flow (RED/GREEN)**

One sequential `it` must perform all approved steps against one runtime unless restart is explicitly required:

```ts
it('captures, explains, promotes, replays, clears, and restarts multi-origin traffic', async () => {
  const httpsUpstream = await harness.upstream(
    { scheme: 'https', hostname: 'api.example.test' }, apiHandler);
  const httpUpstream = await harness.upstream(
    { scheme: 'http', hostname: 'events.example.test' }, eventsHandler);
  const wildcardUpstream = await harness.upstream(
    { scheme: 'https', hostname: 'upload.wild.example.test' }, uploadHandler);
  const created = await harness.request.post('/api/admin/projects')
    .send({ name: 'Acceptance' }).expect(201);
  const project = created.body as Project;
  expect(project).not.toHaveProperty('baseUrl');

  const settingsResponse = await harness.request
    .get(`/api/admin/projects/${project.id}/runtime-settings`).expect(200);
  await harness.request.put(`/api/admin/projects/${project.id}/runtime-settings`).send({
    interceptHosts: ['api.example.test', 'events.example.test', '*.wild.example.test'],
    captureRawTraffic: true,
    debugProvenanceHeaders: true,
    expectedRevision: settingsResponse.body.revision,
  }).expect(200);

  await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
    name: 'Page one', baseUrl: httpsUpstream.origin, mode: 'mock',
    matcher: { method: 'GET', path: '/items', query: {
      page: [{ operator: 'equals', value: '1' }],
    } },
    variants: [{ name: 'Default', status: 200, responseHeaders: {}, delayMs: 0 }],
    defaultVariantIndex: 0,
  }).expect(201);

  await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
    name: 'Page two', baseUrl: httpsUpstream.origin, mode: 'passthrough',
    matcher: { method: 'GET', path: '/items', query: {
      page: [{ operator: 'equals', value: '2' }],
    } },
  }).expect(201);

  await harness.request.post(`/api/admin/projects/${project.id}/endpoints`).send({
    name: 'Events', baseUrl: httpUpstream.origin, mode: 'passthrough',
    matcher: { method: 'POST', path: '/events', query: {} },
  }).expect(201);
}, 120_000);
```

The explicit `120_000 ms` timeout belongs to this sequential acceptance test only; do not use sleeps or relax focused unit-test timeouts.

Create separate HTTP and HTTPS upstream fixtures on non-default ports. Retain the same-origin HTTPS `/items` query-differentiated pair and the HTTP Endpoint so multiple canonical origins coexist. Send a no-Endpoint request to `upload.wild.example.test`, selected only by `*.wild.example.test`, and assert that exact matched pattern, one Traffic row, and original-origin forwarding; send the wildcard apex `wild.example.test` and assert it remains unselected/unrecorded. Use concrete assertions for origin-specific identity/matching/mode, original scheme/hostname/port passthrough, matched allowlist pattern, Endpoint specificity, active/base/fallback reasons, State-disabled retained configured IDs, pre-content-decode encoded digest, repeated `Set-Cookie`, content-length/chunked/close-delimited response decoding, first-byte-before-completion streaming, exact body headers/Download, and mock-only debug headers. Prove unselected HTTPS reaches the loopback fixture through the injected blind connector while remaining client-verified, blind, and unrecorded, and unselected HTTP forwards unrecorded. Add negative HTTPS cases for an untrusted CA, hostname/SNI mismatch, and injected DNS failure: lookup receives the original hostname, never rewrites/falls back, and each selected failure creates one sanitized Traffic outcome without certificate/DNS/secret detail. Wrong-CA blind HTTPS fails client verification and remains unrecorded. For allowlisted CONNECT/inner-Host and absolute-form/Host mismatches, assert exact 400 codes, zero upstream observations, and exactly one sanitized Traffic row with allowlist pattern/request ID. Prove the remaining malformed proxy authorities are never observed upstream and return the exact proxy errors; missing/malformed direct authority returns unrecorded `DIRECT_ORIGIN_INVALID` before allowlist selection.

Add one named redaction-to-promotion round trip: capture a token-like query value and sensitive repeated response header, then prove Traffic list/detail/review/errors contain neither exact secret nor a promotion-input placeholder; the client promotion payload contains neither masked nor exact secret; the private accepted snapshot supplies exact values server-side; and the resulting trusted Endpoint/Variant GET-edit-GET round trip preserves the exact query and response-header values without mask corruption. Promote once with an exact body and explicit State target; assert one Endpoint/Variant/Body Asset/binding generation publication, append-only receipt, `200` exact replay, replay after Traffic clear, receipt survival after response editing, and exact bytes/receipt replay after restart. Force truncated/unavailable bodies and assert no partial mock. Invoke `failNext` separately for generation rename, Body Asset promotion, and pointer publication and assert no canonical/cache orphan and primary error ownership at each boundary.

**Packet 14C focused command:**

Run: `npm run test:integration --workspace=packages/server -- src/integration/traffic-capture.integration.test.ts`

Expected: FAIL at the first unimplemented cross-layer assertion; continue strict RED/GREEN within this task until the one flow passes without weakening assertions.

**Packet 14C implementation rule:** Implement only integration defects exposed by the acceptance flow.

Keep fixes in the owning Task 1-13 modules and add the matching focused regression there before changing production code. Do not add acceptance-only adapters, retries, sleeps, global state, larger limits, or broad catch blocks. Preserve nonblocking delivery, immutable accepted snapshots, one queued publication, exact-once leases, and owner-safe errors while closing each defect.

**Packet 14C completion criteria (no separate review call):** GREEN the complete sequential server acceptance unit before dashboard work, then directly inspect that every required HTTP/HTTPS/origin/authority/capture/promotion/replay/clear/restart/failure assertion has concrete evidence and no test-only production adapter.

- [ ] **Packet 14D: Complete the dashboard ownership integration flow (RED/GREEN)**

Render `App` with controlled fetch streams and real hook/component boundaries. Assert Project switch synchronously invalidates list/detail/body/guidance/promotion owners; previews remain interactive during two exact body loads; a third cancels oldest inactive; cached revisit does not fetch; binary creates no editor; mode/settings drafts survive revision conflict; Import origins enter a reviewed unsaved checklist; `Mock This` known success refreshes canonical owners; and unknown outcome performs GET-only reconciliation without a second POST.

```ts
expect(fetch.mock.calls.filter(([url, init]) =>
  String(url).endsWith('/traffic/trf_1/mock') && init?.method === 'POST')).toHaveLength(1);
expect(screen.getByText(/change may have been saved/i)).toBeVisible();
await user.click(screen.getByRole('button', { name: 'Refresh saved changes' }));
expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
```

**Packet 14D focused command:**

Run: `npm run test --workspace=packages/dashboard -- --run src/App.traffic-integration.test.tsx src/App.import-integration.test.tsx`

Expected: FAIL until cross-component owner handoffs, exact body cache, guidance retention, and promotion reconciliation satisfy the assertions.

**Packet 14D completion criteria (no separate review call):** GREEN the dashboard owner-flow unit, then directly inspect synchronous invalidation, two-load ownership, absence of a binary editor, reviewed settings/import choices, and exactly one promotion POST under unknown-outcome recovery.

- [ ] **Milestone 14 gate: Run the complete integration checks once**

Run: `npm run test --workspace=packages/server -- --run src/test-support/cleanup-report.test.ts`

Run: `npm run test:integration --workspace=packages/server -- src/integration/traffic-capture.integration.test.ts src/integration/traffic-route-contract.integration.test.ts src/integration/versioned-core.integration.test.ts src/integration/import-preview.integration.test.ts`

Run: `npm run test --workspace=packages/dashboard`

Run: `npm run typecheck --workspace=packages/dashboard`

Expected: PASS with the full multi-origin, capture, promotion, clear/restart, failure-atomicity, and dashboard ownership flows.

- [ ] **Milestone 14 direct review checkpoint**

Review Task 14 as acceptance code, then inspect every production fix it exposed in its owning module. Confirm the harness does not bypass public contracts, no timing sleep substitutes for ownership, no selected request is buffered solely for assertions, restart proves Traffic ephemerality and Body Asset permanence, failure tests inspect disk/canonical state, and the dashboard never repeats an unknown mutation.

**Commit checkpoint (Only with explicit user authorization):** derive/review one Slice-3-only patch for Task 14 plus its separately reviewed owning-module regression fixes and apply only that patch to the index; defer if baseline hunks cannot be separated. Then run `git commit -m "test: certify traffic capture integration"`.

### Task 15: Chromium Performance And Full Completion Certification

**Files:**
- Modify: `package.json`
- Create: `tools/slice3-review-artifacts.mjs`
- Create: `tools/slice3-review-artifacts.test.mjs`
- Create: `playwright.config.ts`
- Create: `e2e/run-traffic-chromium.mjs`
- Create: `e2e/traffic-large-body.spec.ts`
- Create: `e2e/body-editor-workflows.spec.ts`
- Create: `e2e/support/traffic-fixture.ts`
- Create: `docs/superpowers/reviews/2026-08-31-mockmate-traffic-capture-verification.md`

**Interfaces:**
- Consumes: Task 13 `test:traffic-absence`; Task 14 acceptance harness and all production behavior.
- Produces: root scripts `test:chromium` and `test:traffic-certification`, NUL-safe `slice3-review-artifacts` capture/diff/seal/verify commands, an E2E launcher that owns all browser artifacts, `TrafficBrowserFixture`, `openMockBody(page: Page, byteCount: number): Promise<number>`, `measureLongTaskPhase(page, phase, action): Promise<{ phase: string; maximumMs: number }>`, exact phase-isolated performance evidence, fresh whole-change spec/quality review, Graphify evidence, whitespace/status/no-stage evidence, and the final implementation handoff.

- [ ] **Packet 15A: Add certification scripts and the review-artifact utility (RED/GREEN)**

Run:

```bash
npm install --save-dev @playwright/test
```

Expected: root `package.json` adds only `@playwright/test` for the browser harness. The ignored `package-lock.json` may change locally but stays ignored and unstaged; `.gitignore` is unchanged.

Add these root scripts:

```json
{
  "scripts": {
    "test:slice3-review-artifacts": "node --test tools/slice3-review-artifacts.test.mjs",
    "test:chromium": "node e2e/run-traffic-chromium.mjs",
    "test:traffic-certification": "npm run test:slice3-review-artifacts && npm run test:traffic-absence && npm run test && npm run test:integration:server && npm run test:performance:server && npm run typecheck --workspace=packages/dashboard && npm run lint && npm run build && npm run test:chromium"
  }
}
```

Write `tools/slice3-review-artifacts.test.mjs` first, run `node --test tools/slice3-review-artifacts.test.mjs` once, and verify focused RED because the CLI behavior is absent. Implement `tools/slice3-review-artifacts.mjs` with the exact capture/diff/seal/verify contract in the preliminary-artifact packet below, then rerun the same command to GREEN before continuing. This utility exists before final certification invokes its test script; Task 0 remains a standalone shell capture because the utility did not exist at the dirty-baseline instant.

- [ ] **Packet 15B: Build the deterministic Chromium launcher and fixtures (RED/GREEN)**

Create `playwright.config.ts` with one Chromium desktop project, `workers: 1`, `fullyParallel: false`, trace on first retry, and `outputDir`/trace paths strictly beneath the required external `MOCKMATE_E2E_ROOT`. Do not configure Playwright `webServer`: test fixtures run after `webServer` startup and therefore cannot supply its root or port. `e2e/run-traffic-chromium.mjs` creates one containment-checked `mockmate-e2e-*` root, sets `MOCKMATE_E2E_ROOT`, spawns Playwright with all forwarded CLI arguments, validates the fixture's owner-close report and browser output/trace ownership, removes the entire parent on pass or failure, verifies absence, and emits the sanitized final cleanup report/exit status. `e2e/support/traffic-fixture.ts` exports the extended `test` used by this spec and owns a worker-scoped MockMate runtime on listener port `0` beneath that root. Never use developer data or a fixed occupied port.

Write the Chromium tests for exact thresholds and body-cache behavior as this packet's RED evidence.

```ts
test('10 MiB mock document is responsive after readiness', async ({ page }) => {
  const openDuration = await openMockBody(page, 10 * 1024 * 1024);
  await expect(page.getByRole('textbox', { name: 'Response body' })).toBeVisible();
  expect(openDuration).toBeLessThanOrEqual(400);

  const phases = [
    ['scroll', () => scrollDocument(page)],
    ['type', () => typeInDocument(page)],
    ['undo', () => undoDocumentEdit(page)],
    ['full-document-search', () => searchFullDocument(page)],
    ['worker-validation', () => validateThroughProductionWorker(page)],
    ['format-publication', () => formatAndAwaitEditorPublication(page)],
  ] as const;

  for (const [phase, action] of phases) {
    const result = await measureLongTaskPhase(page, phase, action);
    expect(result).toEqual({ phase, maximumMs: expect.any(Number) });
    expect(result.maximumMs).toBeLessThanOrEqual(50);
  }
});
```

In `body-editor-workflows.spec.ts`, retain the binding Large-Body browser workflows with real built production code: repository diagnostics, lazy body opening, invalid JSON blocking save, Body Asset upload/Variant attachment, a real revision conflict preserving text/undo/pending upload/current revision, dirty navigation guard, and App State active/base/fallback behavior. Instrument the browser before app startup by wrapping the native `Worker` constructor without replacing its implementation; record the built Worker script URL and validation/format request-response message pairs, then assert both operations completed through that production Worker and no main-thread fallback handled them.

In `traffic-large-body.spec.ts`, add separate tests proving rapid switching among large Traffic entries leaves previews/settings responsive, at most two body requests are active, the third cancels oldest inactive, cached revisit issues no new body request/full-panel loader, a 50 MiB Traffic stream exposes progress while controls respond, and binary Download constructs no CodeMirror `.cm-editor`.

Add a measurement-harness self-test that runs a deliberate browser main-thread block longer than `50 ms` at the end of a phase and proves `measureLongTaskPhase` reports it. This test must fail if the observer's final queued records are discarded.

**Packet 15B focused commands:**

Run: `npx playwright install chromium`

Run: `npm run build`

Run: `npm run test:chromium -- e2e/body-editor-workflows.spec.ts e2e/traffic-large-body.spec.ts`

Expected: FAIL because the Chromium fixture/workflow/performance tests and production-Worker instrumentation are not complete, or because an exact workflow/`400 ms`/`50 ms`/two-load assertion exposes a regression.

**Packet 15B implementation:** Implement deterministic browser fixtures and measurement.

```ts
export interface TrafficBrowserFixture {
  baseUrl: string;
  projectId: string;
  tenMiBAssetId: string;
  trafficIds: { text: string[]; binary: string; fiftyMiB: string };
  cleanupManifest(): CleanupManifest;
  closeOwners(): Promise<CleanupOwnerCloseReport>;
}
```

Implement `e2e/run-traffic-chromium.mjs` together with the fixture using Task 14's shared cleanup constants, atomic writers, validator, and finalizer. Before spawning Playwright, the launcher writes the manifest containing output/trace roots. The worker fixture atomically extends it with its runtime root and containment-checked certificate directory before starting those owners, passes that directory through the real startup API, starts the real built server programmatically on port `0`, waits for its health route, seeds through public admin/test-owned runtime interfaces, exposes the assigned `baseUrl`, and on teardown awaits `closeOwners()` and atomically writes `CleanupOwnerCloseReport`. No certificate read/write may resolve to developer or user storage. After service owners close, ephemeral cache/staging roots are absent/empty, while canonical runtime/Body Asset data, certificates, and Playwright output/traces remain containment-checked and may be nonempty. The launcher validates that first-phase report, calls `finalizeCleanup`, verifies every manifest root and parent are absent, constructs the final `CleanupReport`, and prints final evidence even when Playwright fails. A missing/invalid report is a cleanup failure but never replaces an existing Playwright exit/error; when Playwright succeeds it makes the launcher fail. Its page fixture navigates with the dynamic URL; no environment handoff to Playwright server startup is involved.

`openMockBody` measures opening separately: create a browser `performance.mark` immediately before the opening action, wait until the CodeMirror view is focusable and the document reports ready, then return the browser-measured interval to that readiness point. Do not install a buffered Long Task observer for opening. For each post-readiness phase, `measureLongTaskPhase` installs a new non-buffered `PerformanceObserver` only after readiness, calls `takeRecords()` before the action, runs exactly one named action, waits for that action's semantic completion and two animation frames, appends one final `observer.takeRecords()` result to the callback-collected entries immediately before disconnecting, then returns that phase's maximum (or zero) across every observed entry without duration/type filtering. Never reuse entries or one observation window across phases. Track body-route request start/end/abort counts through Playwright routing without delaying production responses. Use animation-frame probes for progress responsiveness rather than total 50 MiB completion time.

**Packet 15B regression rule:** Fix measured regressions without relaxing gates.

Any production fix follows focused RED in the owning dashboard/server test before implementation. Do not raise `400 ms`, raise `50 ms`, exclude a measured operation, reduce the 10/50 MiB fixture, disable digest verification, allow a third load, or special-case browser tests. Preserve large mode only above `1 MiB`, complete-document search, Worker-generation ownership, and exact Download.

**Packet 15B completion criteria (no additional rerun):** The final Packet 15B
focused command must be GREEN with canonical diagnostics/lazy/invalid/upload/
conflict/navigation/App-State workflows, production Worker validation/format
proof, `10 MiB <= 400 ms`, every measured Long Task `<= 50 ms`, no more than two
full-body requests, cached revisit without fetch/loader, responsive 50 MiB
progress, and no binary editor. Proceed directly to the complete certification;
do not repeat the same build/Chromium pair as a separate milestone command.

- [ ] **Milestone 15 certification gate: Run the complete automated certification once**

Run: `npm run test:traffic-certification`

Expected: PASS for all workspace unit tests, tooling/absence tests, server integration/performance tests, lint, strict TypeScript production builds, and Chromium gates. If an existing unrelated dirty change causes a failure, record the exact command/failure without reverting or modifying that work.

- [ ] **Packet 15C: Materialize the preliminary patch and perform a direct preflight inventory**

Run:

```bash
npm run test:slice3-review-artifacts
node tools/slice3-review-artifacts.mjs capture-diff \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --label preliminary
node tools/slice3-review-artifacts.mjs verify-capture \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --label preliminary
```

The checked-in tool must fail fast, refuse a repository-contained artifact directory, verify Task 0's immutable `SHA256SUMS`, enumerate existing tracked plus non-ignored untracked paths with NUL delimiters, separately record tracked deletions and porcelain status, and create `preliminary-current.tar`, path/member manifests, `preliminary-baseline-to-current.patch`, `preliminary-whitespace-check.txt`, and `preliminary-hashes.json` atomically beneath the external baseline directory. Preserve file modes and symlinks. Extract the initial and current archives into fresh external directories with stable logical names so repeated patch bytes are deterministic. Run `git diff --no-index --binary --check` across those exact extracted trees, accept only ordinary no-difference/difference status, require empty whitespace diagnostics, and record/hash that PASS; this must cover every new untracked archive member that ordinary `git diff --check` cannot see. Reject every other diff exit and any unreadable/hash-mismatched output. The Node tests cover spaces/newlines in names, symlinks, executable modes, unstaged deletion, non-ignored untracked files (including a deliberate whitespace-error rejection), changed-during-capture rejection, diff exits, and deterministic repeated captures. Do not write comparison trees or patches inside the repository.

In the primary session, inspect `preliminary-baseline-to-current.patch` and quote `preliminary-hashes.json`, not only the last task and not the dirty-HEAD diff. Perform a preflight inventory of concrete file/test evidence for schema-v4 direct cutover; origin/query/authority semantics; exact runtime decisions; Traffic descriptors/retention/budgets; cache/sidecars/leases; canonical APIs; stage/replay ordering; redaction/debug headers; document cache/CodeMirror; exact pane; promotion/settings/import orchestration; absence gates; integration; and Chromium thresholds. Use the diff from intentionally dirty HEAD `f43c50e` only as a dependency-completeness inventory, never as evidence that pre-Slice-3 hunks were preserved. This is a direct completeness pass, not a skill/subagent review; the single fresh whole-change review occurs at the final exact-patch packet.

The preflight evidence inventory must use this table shape with no unverified status:

```md
| Requirement | Implementation paths | Test/command evidence | Status |
| --- | --- | --- | --- |
| Schema-v4 direct cutover | `packages/server/src/domain/model.ts` | `npm run test:traffic-absence` | PASS |
```

Record quality findings first, ordered by severity with file/line references. Resolve every blocker/high finding through focused RED/GREEN and rerun affected/full gates. Record residual medium/low risks explicitly; do not write `none` unless the fresh review found none.

- [ ] **Packet 15D: Update Graphify once after implementation settles**

Run: `graphify update .`

Expected: exits 0 and updates only ignored `graphify-out/`. Then run:

```bash
graphify query "Where are schema-v4 traffic capture, body retention, promotion receipts, dashboard document caching, and interception guidance implemented and tested?"
```

Expected: names the Task 1-15 owning modules/tests and no active `LogsView`, `useLogs`, `/logs`, schema-v3 reader, or Project-base-URL path. Record the command/output summary in the verification document; never stage `graphify-out/`.

- [ ] **Packet 15E: Run whitespace, status, ignored-lockfile, and no-stage gates once**

Run:

```bash
git diff --check
git status --short
git diff --cached --quiet
git check-ignore package-lock.json graphify-out/graph.json
```

Expected: `git diff --check` exits 0; status shows the intended Slice 3 implementation/review plus any pre-existing user changes, with no `.superpowers/`, `dist/`, coverage, certificate/private-key, or secret artifact; `git diff --cached --quiet` exits 0; and both ignored paths are reported by `git check-ignore`. Inspect `git diff --name-only f43c50e --` only for dependency completeness. Use the external baseline-to-current patch and manifests to confirm no unrelated baseline file was reverted or overwritten.

Also rerun `node tools/slice3-review-artifacts.mjs verify-capture --baseline-dir "$SLICE3_BASELINE_DIR" --label preliminary` and record its exact-tree whitespace PASS. The ordinary Git command covers tracked diffs; the artifact check is the authoritative whitespace gate for tracked plus non-ignored untracked files.

- [ ] **Packet 15F: Record final completion evidence and handoff**

In `docs/superpowers/reviews/2026-08-31-mockmate-traffic-capture-verification.md`, record exact command, exit code, date, and relevant result counts for every focused/full/integration/performance/Chromium/absence/Graphify/whitespace/status/no-stage gate. Include final task dependency order, known residual risks, ignored `package-lock.json` policy, intentionally dirty `f43c50e` baseline, and explicit statement that no staging/commit occurred without authorization.

Rerun after writing evidence:

```bash
git diff --check
git diff --cached --quiet
git status --short
```

Expected: whitespace and no-stage gates remain clean and status contains only understood worktree changes.

- [ ] **Milestone 15 final gate: Regenerate and review the exact final patch once**

After Graphify, evidence writing, and all review fixes, rerun Task 0 baseline verification, then run:

```bash
: "${SLICE3_REVIEW_ATTEMPT:?set a new monotonically increasing integer}"
export SLICE3_REVIEW_LABEL="final-reviewed-$SLICE3_REVIEW_ATTEMPT"
node tools/slice3-review-artifacts.mjs capture-diff \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --label "$SLICE3_REVIEW_LABEL"
node tools/slice3-review-artifacts.mjs verify-capture \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --label "$SLICE3_REVIEW_LABEL"
```

Open one fresh review-only primary-agent conversation, not a skill or subagent, and perform the single independent whole-change spec/executability review against the exact archive/patch hashes for `$SLICE3_REVIEW_LABEL`. The artifact tool refuses an existing label and never overwrites or removes an earlier attempt. If review causes any file change, rerun affected focused gates plus the complete certification once, refresh Graphify/evidence, assign a new monotonically unique `SLICE3_REVIEW_LABEL`, recapture, and repeat review. Only after a review returns with no required file change, retain that approved label, seal its exact hashes, and make a second fresh uniquely labelled capture:

```bash
export SLICE3_VERIFIED_LABEL="final-verified-$SLICE3_REVIEW_ATTEMPT"
node tools/slice3-review-artifacts.mjs seal-reviewed \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --label "$SLICE3_REVIEW_LABEL"
node tools/slice3-review-artifacts.mjs capture-diff \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --label "$SLICE3_VERIFIED_LABEL"
node tools/slice3-review-artifacts.mjs verify-reviewed \
  --baseline-dir "$SLICE3_BASELINE_DIR" \
  --reviewed-label "$SLICE3_REVIEW_LABEL" \
  --candidate-label "$SLICE3_VERIFIED_LABEL"
```

`seal-reviewed` writes an immutable reviewed-hash record only after reviewer approval. `verify-reviewed` mechanically compares current archive, patch, status, path manifest, deletion manifest, membership, and exact-tree whitespace-check hashes, reruns baseline hash verification, and fails on any mismatch, whitespace diagnostic, or changed-during-capture signal. Completion is forbidden until it passes and a fresh status check is unchanged.

Read the complete verification document and exact reviewed patch once more. Completion requires every design goal and test matrix section mapped to passing evidence, all blocker/high findings resolved, all old-contract gates passing, Graphify current, exact constants unchanged, recorded teardown manifests proving cleanup roots empty/removed after tests, and no staged files. Do not claim completion from partial/focused results.

**Commit checkpoint (Only with explicit user authorization):** derive/review the final Slice-3-only patch containing source/tests/manifests/active docs and `docs/superpowers/reviews/2026-08-31-mockmate-traffic-capture-verification.md`, then apply only that patch to the index. Exclude ignored `package-lock.json`, `graphify-out/`, `.superpowers/`, build output, coverage, temporary roots, and unrelated dirty work; defer if protected baseline hunks cannot be separated. Then run `git commit -m "feat: deliver traffic capture workspace"`.
