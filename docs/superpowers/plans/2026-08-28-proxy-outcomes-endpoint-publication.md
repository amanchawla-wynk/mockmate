# Proxy Outcomes And Endpoint Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an intercepted TLS connection from processing queued requests after a terminal response and prevent delayed Endpoint saves from publishing into a changed selection.

**Architecture:** Make every intercepted response return one explicit `continue`, `close`, or `fatal` outcome to the serialized drain loop. Capture Endpoint publication ownership at save start with a Project, selected Endpoint, Project generation, and detail generation token; publish only while that exact owner is still current.

**Tech Stack:** TypeScript, Node.js streams/TLS, React 19, Vitest, Testing Library.

## Global Constraints

- Work only in `/Users/amanchawla/Documents/Projects/mockmate/.worktrees/mockmate-reliable-core` from starting HEAD `597be9e`.
- Use strict RED/GREEN: each production change follows a focused test that failed for the expected reason.
- Preserve stream backpressure, bounded response previews, cancellation, listener cleanup, active-Project checks, request ordering, and normal keep-alive.
- Preserve Endpoint and Variant draft ownership, authoritative normalization, guarded remount, and second-save behavior.
- Keep the fresh schema-v3-only architecture and all existing security boundaries; add no migration or compatibility behavior.
- Create one final non-amended commit. Never stage `.superpowers/`, `graphify-out/`, generated output, lockfiles, or unrelated files.
- Append exact RED/GREEN and final gate evidence to `.superpowers/sdd/fresh-app-task-4-report.md`, but leave that report unstaged.

---

### Task 1: Explicit Intercepted Response Outcomes

**Files:**
- Modify: `packages/server/src/services/proxy-server.test.ts`
- Modify: `packages/server/src/services/proxy-server.ts`

**Interfaces:**
- Consumes: `writeResolvedResponse`, `SocketResponseTarget`, parsed request version and headers, and the serialized TLS drain loop.
- Produces: `type InterceptedResponseOutcome = 'continue' | 'close' | 'fatal'`; every handled response returns one outcome and the drain loop discards its queue and exits for `close` or `fatal`.

- [ ] **Step 1: Add the failing pipelined fatal test**

Add a raw TLS test that writes two complete `/large` requests in one call. Make the first Body Asset source emit a partial body and close prematurely; assert the socket closes and `openBody` is called exactly once.

```ts
socket.write([
  'GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n',
  'GET /large HTTP/1.1\r\nHost: stream.example.test\r\n\r\n',
].join(''));
await closed;
expect(bodyOpens).toBe(1);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-server.test.ts`

Expected: FAIL because the current `writeResolvedProxyResponse` catches the first terminal failure and returns `void`, allowing `drainBuffer` to attempt the queued request.

- [ ] **Step 3: Return and consume explicit outcomes**

Make resolved-response success return `close` when the target closes and `continue` otherwise; return `fatal` after sanitized pre-header failure or post-header destruction. Make non-resolved and no-resolution paths produce the same outcome type. In `drainBuffer`, clear `buffer` and return for both terminal outcomes.

```ts
type InterceptedResponseOutcome = 'continue' | 'close' | 'fatal';

const outcome = await writeInterceptedResponse(/* current request context */);
if (outcome !== 'continue') {
  buffer = Buffer.alloc(0);
  return;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-server.test.ts`

Expected: PASS, including existing stream teardown and keep-alive cases.

### Task 2: Request And Response Close Ownership

**Files:**
- Modify: `packages/server/src/services/proxy-server.test.ts`
- Modify: `packages/server/src/services/proxy-server.ts`
- Modify: `packages/server/src/services/proxy-handler.ts`

**Interfaces:**
- Consumes: parsed HTTP version, normalized `Connection` request header, and final case-insensitive response headers on `SocketResponseTarget`.
- Produces: request-side close semantics for HTTP/1.1 `Connection: close` and HTTP/1.0 without `Connection: keep-alive`, plus response-side close semantics for a final configured `Connection: close` header.

- [ ] **Step 1: Add failing response-owned and version-owned close tests**

Configure a resolved Variant with mixed-case `Connection: close`, pipeline a second request, and assert one response/body open followed by socket closure. Add an HTTP/1.0 request without keep-alive and assert the same terminal behavior. Retain the existing HTTP/1.1 request-owned close and sequential keep-alive cases.

```ts
responseHeaders: { Connection: 'close' }
```

```ts
socket.write('GET /large HTTP/1.0\r\nHost: stream.example.test\r\n\r\n');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-server.test.ts`

Expected: FAIL because the current target only closes from the request's lower-case `connection: close` value and ignores HTTP version and configured response ownership.

- [ ] **Step 3: Compute close after final header normalization**

Add `httpVersion` to parsed proxy requests. Initialize `SocketResponseTarget` with request close ownership, determine response close ownership from its lower-cased header map in `writeHead`, force `Connection: close` whenever either side owns closure, and expose the final close decision to the response outcome.

```ts
const requestCloses = parsed.httpVersion === 'HTTP/1.0'
  ? parsed.headers.connection?.trim().toLowerCase() !== 'keep-alive'
  : parsed.headers.connection?.trim().toLowerCase() === 'close';
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test --workspace=packages/server -- --run src/services/proxy-server.test.ts src/services/response-writer.test.ts`

Expected: PASS with one close, no second queued resolution, and unchanged normal keep-alive.

### Task 3: Operation-Scoped Endpoint Publication

**Files:**
- Modify: `packages/dashboard/src/hooks/useEndpoints.ts`
- Modify: `packages/dashboard/src/hooks/versioned-core-hooks.test.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.tsx`
- Modify: `packages/dashboard/src/components/EndpointEditor.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes: current Project generation, selected Endpoint identity, and detail generation at the instant an Endpoint save starts.
- Produces: `beginEndpointPublication(): EndpointPublicationToken` and `publishEndpoint(token, endpoint): void`; `EndpointEditor` obtains a completion callback before awaiting the API.

- [ ] **Step 1: Add failing hook ownership tests**

Capture a publication token while `ep_1` is selected, then clear selection or select `ep_2` before publishing. Assert both completions are ignored. Also assert an unchanged owner accepts publication.

```ts
const token = result.current.beginEndpointPublication();
act(() => result.current.selectEndpoint(undefined));
act(() => result.current.publishEndpoint(token, saved));
expect(result.current.selectedEndpoint).toBeUndefined();
```

- [ ] **Step 2: Add a failing deferred App save test**

Defer `endpointsApi.update`, start saving `ep_playback`, navigate through the guard to New Endpoint while it is pending, resolve the old save, and assert the editor remains New Endpoint. Repeat selection of another Endpoint when useful to prove identity rather than only `undefined` handling.

```ts
await user.click(screen.getByRole('button', { name: 'Save Endpoint' }));
await user.click(screen.getByRole('button', { name: 'New Endpoint' }));
await user.click(screen.getByRole('button', { name: 'Discard' }));
pendingSave.resolve(saved);
expect(await screen.findByRole('button', { name: 'Create Endpoint' })).toBeVisible();
```

- [ ] **Step 3: Run dashboard tests and verify RED**

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/versioned-core-hooks.test.tsx src/components/EndpointEditor.test.tsx src/App.test.tsx`

Expected: FAIL because publication has no token argument and Endpoint save completion captures ownership only after the API returns.

- [ ] **Step 4: Implement token capture and save-start wiring**

Increment a detail generation on every `selectEndpoint` call. Capture immutable Project ID, selected Endpoint ID, Project generation, and detail generation in `beginEndpointPublication`. Publish only when every captured value still equals the current owner and the saved Endpoint belongs to the captured Project. Have `EndpointEditor` request its completion callback before calling create/update; leave Variant sibling publication and local draft handling unchanged.

```ts
export interface EndpointPublicationToken {
  readonly projectId: string | undefined;
  readonly selectedEndpointId: string | undefined;
  readonly projectGeneration: number;
  readonly detailGeneration: number;
}
```

- [ ] **Step 5: Run dashboard tests and verify GREEN**

Run: `npm run test --workspace=packages/dashboard -- --run src/hooks/versioned-core-hooks.test.tsx src/components/EndpointEditor.test.tsx src/App.test.tsx`

Expected: PASS for cleared/changed selections, normal publication, guarded remount, sibling drafts, and second save.

- [ ] **Step 6: Run final gates and create one commit**

Run the focused server/dashboard tests, complete workspace suites, both package TypeScript checks, `npm run build`, exact legacy/migration/compatibility absence greps, `git diff --check`, and `graphify update .`. Append outputs to the ignored evidence report, inspect status/diff/log, stage only the listed production/test paths plus this plan, and commit once with `git commit -m "fix: finalize proxy and endpoint ownership"`.
