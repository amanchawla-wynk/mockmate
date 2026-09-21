# Traffic Observer Search, Breakpoints, And Endpoint Folder View

Date: 2026-09-16
Status: Draft for implementation

## Summary

MockMate will add four independently releasable capabilities to the Traffic and
Endpoint workspaces:

1. an explicit search bar in captured request and response JSON viewers;
2. project-wide search across retained request and response JSON bodies;
3. an origin-and-path folder view for configured Endpoints; and
4. persistent request rules that pause matching exchanges before routing and
   again before response delivery so an operator can edit, execute, reject, or
   drop them.

The first three capabilities extend existing dashboard and Traffic retention
models. Breakpoints require a new runtime hold service and a shared direct/proxy
request pipeline seam. They intentionally delay matching application traffic,
but they must not remove the existing bounds on memory, temporary disk
ownership, open sockets, or shutdown.

## Approved Product Decisions

- Overall search is scoped to completed Traffic in the active Project.
- Overall search examines currently retained, valid JSON request and response
  bodies only. It does not create a durable search index.
- Search is case-insensitive plain-text matching over JSON property names and
  scalar values.
- Overall search lives in a panel within Traffic. It does not replace the
  existing metadata filter.
- Results are newest-first, one result per matching body, with up to 100 results
  per page and Load more pagination.
- Selecting a result opens its Traffic row, request or response body tab, and
  the matching text in the body viewer.
- Captured Traffic JSON viewers have a visible search field, match count, and
  previous/next controls.
- `Breakpoint This` creates an enabled persistent rule matching the captured
  normalized origin, method, and exact path. Query and headers are not rule
  constraints.
- An existing rule with the same canonical matcher is reused and enabled.
- An eligible finite matching exchange pauses after its complete request body
  has arrived and again after its complete response body has arrived but before
  delivery. Streaming or collection-timed-out stages bypass unchanged.
- Request edits cover end-to-end headers and valid JSON body content. Origin,
  method, path, query, authority headers, and transport-managed headers remain
  immutable.
- Response edits cover status, end-to-end headers, and valid JSON body content.
- Execute resumes normal MockMate routing. It does not force upstream
  passthrough.
- Reject sends an editable synthetic HTTP response. Drop closes the client
  connection without an HTTP response.
- Non-JSON bodies are retained for the held exchange and shown read-only.
  Metadata remains editable where applicable.
- Breakpoint bodies have no independent per-body size limit. They use
  bounded-memory disk spooling and aggregate temporary-storage budgets.
- At most 20 matching exchanges per Project may own breakpoint runtime state.
  Additional matches continue unchanged.
- A hold automatically executes its original, unedited stage after 30 seconds.
- A client disconnect releases runtime resources and produces a completed,
  cancelled Traffic row when enough trusted request context exists.
- Breakpoint rules survive restart. Paused exchanges and Traffic do not.
- Clear Traffic retains breakpoint rules and releases paused exchanges by
  continuing their original content unchanged.
- Endpoint folder view groups by normalized origin and literal configured path
  components. Matcher segments are not inferred or rewritten.
- Endpoint navigation retains the existing flat list and adds a locally
  remembered List/Tree toggle.

## Goals

- Find a value or key across all currently retained JSON Traffic evidence
  without loading every body into the browser.
- Make visible-body search discoverable and usable without requiring a keyboard
  shortcut.
- Navigate from an overall search result to the exact Traffic side and local
  match.
- Turn a completed Traffic row into a reusable breakpoint rule with one action.
- Allow safe JSON request and response modification while preserving HTTP
  authority and framing invariants.
- Make timeout, overflow, disconnect, clear, and shutdown behavior explicit and
  deterministic.
- Offer a compact Endpoint hierarchy without changing Endpoint identity or API
  ordering.
- Preserve Project ownership, optimistic revisions, immutable Traffic body
  identity, and stale-result protection.

## Non-Goals

- Searching configured Endpoints, Variants, App States, imports, or static
  files.
- Searching non-JSON Traffic bodies, bounded previews, evicted bodies, or
  unavailable bodies in overall search.
- Durable indexing or Traffic history across process restarts.
- Regular expression, glob, JSONPath, whole-word, or case-sensitive overall
  search in the first release.
- Editing URL, origin, method, path, query, binary content, or arbitrary raw
  text at a breakpoint.
- Wildcard breakpoint rules, header/query breakpoint constraints, manual rule
  authoring, response-only rules, or one-shot rules in the first release.
- Persisting paused exchanges or recovering their sockets after restart.
- Inferring dynamic Endpoint path segments or adding user-defined folders.
- Replacing the current Endpoint list or changing Endpoint matcher semantics.

## Delivery Order

Each slice is independently testable and releasable.

1. **Visible JSON viewer search.** This establishes the navigation target used
   by overall search.
2. **Overall Traffic JSON search.** This adds server-side retained-body search
   and the Traffic search panel.
3. **Endpoint folder view.** This is client-derived and independent of Traffic
   runtime changes.
4. **Request and response breakpoints.** This is the largest and highest-risk
   slice and lands only after the proxy hold lifecycle is integration-tested.

## Slice 1: Visible JSON Viewer Search

### Scope

The first release applies to captured Traffic request and response bodies shown
as JSON. Endpoint body editors and import review are unchanged.

The existing `TrafficBodyPane` and `BodyDocumentEditor` remain the document and
cache owners. `BodyDocumentEditor` already installs CodeMirror search support;
this slice adds a stable application-owned toolbar rather than creating another
editor implementation. The dashboard keeps its existing read-time JSON
pretty-printing for readability; local search operates over that displayed
document. Search coordinates are therefore displayed-document coordinates, not
raw byte offsets, and every navigation and count in this slice is defined
against the shown text. Slice 2 navigation seeds this local search rather than
depending on raw source offsets, so display fidelity and search stay
self-consistent without a source/display offset map.

### JSON Qualification

A visible body receives JSON search controls when either condition is true:

- its normalized media type is `application/json` or has a `+json` suffix; or
- its complete displayed UTF-8 document parses as JSON.

The second rule covers JSON served with a generic text media type such as
`text/plain`. Parsing is bounded so a large mislabelled text body cannot stall
the main thread; above that bound only the media-type rule applies. A body that
is not shown as text (binary or content-encoded binary) has no displayed
document and does not qualify.

An exact decoded representation of a content-encoded text body is the searchable
document.

### UI

The toolbar appears directly above the JSON document and contains:

- an input labelled `Find in request JSON` or `Find in response JSON`;
- a current/total match count such as `2 of 7`;
- previous and next buttons; and
- a no-match state that does not replace or hide the document.

Matching is case-insensitive plain text over the complete displayed document.
Matches are highlighted and the active match scrolls into view. Search state is
owned by Project, Traffic ID, side, and body digest so switching Traffic rows
cannot apply a stale query or selection to a different body.

Overall-search navigation seeds this local search with the overall query and
selects the first displayed match. It does not pretend the overall semantic
query is the same as local displayed-text search; for example, a semantic `é`
match may be represented by `\u00e9` in the displayed JSON. Ordinary Traffic
selection starts with an empty local query.

### Acceptance Criteria

- A request and response JSON body each expose independent search state.
- Previous and next wrap at the first and last occurrence.
- The count updates after every query change and is accurate for content outside
  the rendered viewport.
- Opening another Traffic row does not retain match state from the prior body.
- Large-body mode keeps syntax parsing and wrapping disabled while search still
  spans the complete CodeMirror document.
- Non-JSON and binary body panes do not show JSON search controls.
- Exact-body load failure preserves existing retry and download behavior.

## Slice 2: Overall Traffic JSON Search

### Search Semantics

Search operates on a snapshot of completed rows currently retained by the
active Project's `TrafficStore`. Open breakpoint exchanges are excluded.

For each request and response side, a body is searchable only when all of the
following are true:

- the Traffic body descriptor is `available`;
- a body-cache lease can still be acquired;
- the entity can be decoded according to its supported Content-Encoding;
- decoded bytes are valid UTF-8; and
- the complete decoded document is valid JSON.

Media type is advisory. A retained body that parses as JSON is searchable even
if its media type is missing or generic. A body that does not parse as complete
JSON, including one labelled as JSON, is skipped and reported under `notJson`.

The query is trimmed and must contain at least one non-whitespace code point.
Matching uses locale-independent case folding. It examines:

- every object property name;
- every string scalar value after JSON escape decoding;
- the canonical text of number, boolean, and null scalar values.

Container punctuation, indentation, and whitespace do not match. A substring
may occur more than once in one key or scalar and each occurrence contributes to
the body's match count.

### Result Contract

One result represents one request or response body:

```ts
interface TrafficJsonSearchResult {
  traffic: TrafficSummary;
  side: 'request' | 'response';
  matchCount: number;
  matches: Array<{
    jsonPointer: string;
    kind: 'key' | 'value';
    occurrence: number;
    snippet: string;
  }>;
}

interface TrafficJsonSearchPage {
  searchSessionId: string;
  query: string;
  results: TrafficJsonSearchResult[];
  nextCursor?: string;
  skipped: {
    unavailable: number;
    truncated: number;
    evicted: number;
    unsupportedEncoding: number;
    invalidUtf8: number;
    notJson: number;
    changedDuringSearch: number;
    searchBudgetExceeded: number;
  };
}
```

`matches` contains at most three representative snippets per body. Snippets are
bounded around the matching scalar, never contain filesystem paths, and are
returned only through the loopback admin API with the same trust model as exact
Traffic body viewing. `jsonPointer`, `kind`, and `occurrence` identify the
semantic match for display; the client navigates by seeding the local
displayed-document search with the query, not by raw byte offsets. `matchCount`
remains the complete count for that body.

The first request creates an ephemeral server-owned `TrafficSearchSession`. It
captures an ordered list of current completed row identities, summaries, and
baseline side descriptors but does not pin body bytes. Each baseline descriptor
contains state and, when available, digest, retained size, media type, and
content encoding. Ordering is `completedAt` descending, then Traffic ID as a
stable tie-breaker, with request before response for one row. Rows completed
after session creation are excluded.

The server returns at most 100 result bodies per page. `nextCursor` identifies
the session and next candidate offset; it is opaque, Project-bound, and
query-bound. Sessions expire five minutes after their last access and are
removed on Project clear or process restart. If a candidate body is evicted or
changed after the snapshot, it is counted under `changedDuringSearch` and the
scan continues. An expired cursor returns `410 TRAFFIC_SEARCH_EXPIRED`; the
dashboard reruns the query from a new snapshot rather than silently mixing
snapshots.

Skipped counters cover candidates consumed while producing that page. The
dashboard accumulates them across pages from the same session and labels
`notJson` as `Not valid JSON` rather than claiming the body was unavailable.

The service retains at most four sessions per Project and sixteen process-wide.
Creating another session evicts the least-recently-used idle session. If every
candidate is serving an active page, creation returns `429 TRAFFIC_SEARCH_BUSY`.
At most two page scans and two body leases run process-wide; additional page
requests wait in a bounded queue or return the same busy response before work
begins. Limits and expiry are injectable for tests.

### API

Add:

```text
GET /api/admin/projects/:projectId/traffic/search?q=:query&limit=100&cursor=:cursor
DELETE /api/admin/projects/:projectId/traffic/search/:searchSessionId
```

Validation rules:

- `q` is required after trimming;
- `limit` is an integer from 1 through 100;
- malformed or cross-query cursors return a sanitized `400`;
- a cursor for a missing, expired, or cross-Project session returns `410`, so a
  cross-Project cursor cannot be distinguished from an expired one;
- a cancelled HTTP request cancels pending decoding/search work and releases all
  body leases; and
- DELETE releases an idle session immediately or marks an active session for
  disposal when its current page settles.

Sessions are built from the existing bounded `TrafficService.list` snapshot
rather than a new store operation; that page is already immutable and
row-limited, so a second snapshot API would duplicate it. The search service
scans session candidates and holds at most one body lease at a time.

The first release decodes and parses one candidate body at a time into memory
rather than streaming tokenization. Two ceilings bound that choice: at most
32 MiB decoded per body, and at most 256 MiB decoded per page. A body over the
per-body ceiling is skipped as `searchBudgetExceeded` and remains readable
through the ordinary body route; a page that exhausts its aggregate ceiling
stops early and returns a cursor so continuing is deliberate. Streaming
tokenization remains a later optimization, not a correctness requirement.

Per-result snippets and paths are bounded, and the scan stops descending past a
fixed nesting depth so adversarial documents cannot exhaust the stack. There is
no search index to maintain when a body is evicted; eviction skips only that
candidate as `changedDuringSearch`. Traffic clear and restart destroy the
complete session.

Search uses locale-independent Unicode `toLowerCase` semantics without Unicode
normalization. Server and dashboard tests use the same definition.

Body eviction and Traffic clear serialize with leases as they do for body
viewing and `Mock This`. A leased body may finish its active search. Its result
is emitted only if the same Project, Traffic ID, generation, and side remain
current when the match is committed to the page. Generation is the identity
guard: a re-captured row always takes a new generation, so carrying a separate
per-side digest baseline in the session would add cost without adding a
distinct protection.

### Traffic UI

The existing `Filter traffic...` field remains the fast client-side metadata
filter. A separate `Search JSON` control opens an inline Traffic search panel.

The panel contains:

- one plain-text input;
- a Search action;
- automatic submission after a short debounce once a non-empty query exists;
- loading and cancellation states;
- skipped-body summary;
- newest-first result rows; and
- `Load more` when a cursor is present.

Changing the query aborts the previous request and clears its pagination chain.
Live Traffic polling may continue, but new rows do not enter an existing search
snapshot until the query reruns.

A result row shows method, origin/path, status, completion time, request or
response side, complete match count, and representative snippets. Selecting it:

1. selects the Traffic row;
2. loads canonical detail;
3. opens the matching request or response body tab;
4. loads the exact/decoded body through `BodyDocumentCache`;
5. switches the body pane to JSON text presentation when the search service
   validated a generic media type as JSON; and
6. seeds the visible JSON toolbar with the overall query and selects the first
   displayed match.

Search navigation selects the matching row and pins its matching body tab until
the operator selects another row. Holding a pinned summary for results outside
the incrementally loaded Captured list, and marking a result stale when its
evidence is evicted between search and navigation, are deferred follow-ups; the
first release relies on the normal evicted-body state in the body pane.

If evidence is evicted between search and navigation, the normal evicted-body
state is shown and the search panel marks the result stale. It does not fall
back to pretending a preview is the matched exact body.

### Acceptance Criteria

- Search finds keys and scalar values in retained request and response JSON.
- Search does not match JSON punctuation or formatting whitespace.
- Search handles supported gzip, deflate, and Brotli content encodings through
  the decoded view while retaining encoded body identity.
- Unavailable, truncated, evicted, invalid UTF-8, non-JSON/invalid JSON, search
  budget, and unsupported
  encoding cases are skipped without failing the complete search.
- Results are one per body, newest-first, bounded to 100 per page, and load more
  without duplicates.
- Stale searches and stale result navigation cannot update a new Project or
  query owner.
- Search cancellation releases body leases and bounded decoder/tokenizer state.
- Clear Traffic immediately clears search results and aborts active search.

## Slice 3: Endpoint Folder View

### Derivation

No Endpoint API or persisted model changes are required. The dashboard derives
the tree from `EndpointSummary[]`.

The hierarchy is:

```text
normalized Endpoint baseUrl
  / first literal matcher path component
    / next literal matcher path component
      METHOD Endpoint name
```

Rules:

- normalized origin is the root folder;
- leading and trailing `/` do not create empty folders;
- `/` Endpoints appear directly under the origin;
- percent-encoded text, glob characters, and parameter-looking text remain
  literal configured segment labels;
- `/users/123` and `/users/{id}` are distinct branches;
- Endpoints sharing origin, method, and path because of query/header constraints
  remain distinct leaves;
- origin and folder labels sort lexicographically;
- leaves sort by method, then Endpoint name, then stable Endpoint ID; and
- leaves display a method badge and configured Endpoint name.

### UI

Add a `List | Tree` toggle to the Endpoint list header. List remains the current
card presentation. Tree uses collapsible origin and path rows. The preference is
stored locally for the dashboard and does not mutate Project data. The versioned
key is `mockmate.endpoint-view.v1` with values `list` or `tree`. Missing,
invalid, or inaccessible browser storage defaults to `list` and never blocks
rendering.

Selecting a tree leaf invokes the existing Endpoint selection flow. Switching
views preserves selection. Tree mode expands the selected Endpoint's ancestors.
Create, Import, loading, empty state, and Endpoint editor behavior remain
unchanged.

### Acceptance Criteria

- Every Endpoint appears exactly once in List and Tree modes.
- Multi-origin Projects create separate normalized origin roots.
- Root paths, repeated paths, parameter-looking segments, and query/header
  matcher variants remain selectable without collisions.
- The selected Endpoint survives List/Tree switching and Project refresh.
- The view preference survives dashboard reload but does not cross into server
  state.
- Keyboard focus and expand/collapse semantics use accessible tree roles.

## Slice 4: Request And Response Breakpoints

### Product Language

- A **Breakpoint Rule** is persistent Project configuration matching one
  normalized origin, normalized method, and exact captured path.
- A **Paused Exchange** is ephemeral runtime state owned by one live client
  exchange and one matching rule.
- **Execute** continues with accepted edits.
- **Reject** sends an operator-authored synthetic HTTP response.
- **Drop** closes the client connection without an HTTP response.
- **Auto-continue** executes original unedited content after timeout or safe
  bypass.

`Abort` is not used in the UI because it does not distinguish an HTTP rejection
from a connection drop.

### Persistent Rule Model

```ts
interface BreakpointRule {
  schemaVersion: 1;
  id: string;
  projectId: string;
  matcher: {
    origin: string;
    method: string;
    path: string;
  };
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

Origin uses the existing normalized HTTP origin. Method uses the same canonical
method normalization as Endpoints. Path is the exact captured path string after
only separating its query; it is not passed through Endpoint matcher
normalization and is not a glob expression. Trailing slashes, repeated slashes,
dot segments, character case, and percent-escape spelling therefore remain
distinct exactly as they do in captured runtime request targets. Breakpoint This
and runtime matching use the same shared `breakpointRequestPath` projection.
Canonical rule identity is origin, method, and this exact path. Duplicate
identities in one Project are prohibited.

Rules are stored in a strict generation-root `breakpoints.json` collection with
its own collection schema version, not in `ProjectRuntimeSettings`. Existing
generations without this newly introduced file load it as empty; the first rule
mutation publishes a complete generation containing the collection. The
validated Project snapshot, clone/load/prepare paths, generation writer, and
repository diagnostics all gain the collection together.

Rule mutation uses the existing Project mutation queue, full atomic generation
publication, strict validation, and optimistic revisions. The repository owns
the immutable compiled rule lookup and exposes synchronous
`matchBreakpoint(projectId, origin, method, path)`. Publishing a candidate swaps
canonical repository state and compiled rule lookup at the same memory
linearization point, so no separate BreakpointService refresh can lag the API
result. This avoids coupling interception settings revisions to debugger rule
changes and avoids a persisted/runtime split-brain window.

### Rule APIs

Add:

```text
GET    /api/admin/projects/:projectId/breakpoints
PUT    /api/admin/projects/:projectId/breakpoints/:breakpointId
DELETE /api/admin/projects/:projectId/breakpoints/:breakpointId
POST   /api/admin/projects/:projectId/traffic/:trafficId/breakpoint
```

`POST .../traffic/:trafficId/breakpoint` accepts the expected Traffic generation.
It derives origin, method, and path from trusted retained Traffic metadata. It:

- creates and enables a missing rule;
- enables an existing disabled rule using one canonical mutation; or
- returns an already enabled exact rule without incrementing its revision.

The response identifies whether the rule was created, enabled, or already
enabled. Missing/cross-Project Traffic is an indistinguishable `404`; generation
change is `409 TRAFFIC_BREAKPOINT_STALE`.

Rule update initially supports only `enabled` with `expectedRevision`. Delete
also requires `expectedRevision`. Disabling or deleting a rule affects future
matching only; already paused exchanges keep their timeout and available
actions.

### Breakpoint This UI

Add `Breakpoint This` beside `Mock This` in the selected Traffic overview. It is
available whenever canonical origin, method, and path evidence exists; it does
not depend on response-body promotion eligibility.

On success the dashboard shows `Breakpoint enabled` and links to the matching
rule in the Breakpoints panel. Repeated clicks do not create duplicates.

Traffic gains three workspace modes without changing primary navigation:

- `Captured` for the existing list/detail workspace;
- `Breakpoints` for persistent rules; and
- `Paused` with a live count for held exchanges.

Overall JSON search opens as a panel from Captured rather than becoming another
primary application view.

### Runtime Hold Service

Add a Project-scoped `BreakpointService` owned by the server runtime. It asks
the repository's current compiled snapshot to match new requests and owns:

- up to 20 admitted matching exchange sessions per Project;
- request and response hold state machines;
- original and optional edited body spools;
- timeout ownership;
- client disconnect ownership;
- action generation tokens;
- recent terminal reason needed to complete Traffic evidence; and
- disposal and Clear Traffic release.

There is no module-global hold map. Every handle is scoped by Project, opaque
exchange ID, random generation token, stage, and stage revision. Dashboard
commands with a stale stage or generation return `409 BREAKPOINT_STAGE_STALE`
and cannot affect a reused or advanced exchange.

One matching exchange reserves one of the 20 Project session slots from request
admission until final response delivery, response-collection bypass, rejection,
drop, disconnect, or terminal failure. This guarantees that an admitted request
can also reach its paired response breakpoint. Twenty is a hard session ceiling,
not a guarantee that storage admission will accept 20 large bodies. A
twenty-first match bypasses both breakpoint stages and continues unchanged. The
resulting Traffic detail records the bypass reason `queue_full`.

### Resource Model

Breakpoint body capture is intentionally blocking for the matched exchange but
bounded for the process:

- bytes stream to operation-owned temporary files;
- memory contains only bounded stream queues, metadata, snippets, and editor
  transfer chunks;
- there is no independent per-body byte ceiling;
- temporary bytes count against explicit per-Project and process aggregate
  breakpoint budgets owned by a separate `BreakpointSpoolBudgetManager`;
- original and edited copies are accounted independently;
- a spool is containment checked and never follows symlinks;
- all paths remain server-private; and
- every timeout, disconnect, action, error, clear, and shutdown path releases
  logical file/reservation ownership exactly once and schedules failed physical
  cleanup for safe retry.

The spool budget manager has distinct reservations for original spools and body
drafts and does not consume Traffic sidecar concurrency slots. A shared
byte-only temporary-storage ledger caps the combined Traffic-capture and
breakpoint footprint at 1 GiB per Project and 2 GiB per process. Existing
Traffic sidecar count/queue reservations remain independent. Storage admission
may bypass an exchange even when fewer than 20 sessions exist.

If temporary admission or disk writing fails before a complete request body is
held, the service replays the already spooled prefix followed by the remaining
live source into normal routing unchanged. If it fails while buffering a
response, it sends the already spooled prefix followed by the remaining source
unchanged. That stage is not paused, and Traffic records a sanitized bypass
reason such as `temporary_budget_exceeded` or `spool_io_failed`.

This fallback is required because “no per-body limit” cannot mean unbounded
memory, disk, elapsed collection time, or a failed application exchange.

Every body collection phase also has a 30-second collection deadline distinct
from the operator action deadline. Request collection starts when the rule is
admitted. Response collection starts when prepared response headers are
available. If the source does not complete before that deadline, the service
replays the spooled prefix followed by the live remainder unchanged, records
`collection_timeout`, and does not publish that stage as paused. Known streaming
media such as `text/event-stream` bypass response collection immediately. This
keeps long uploads and indefinite streaming responses on a correct passthrough
path without claiming they were editable.

### Traffic Admission Seam

Current Traffic creation freezes request headers and body metadata before the
request can be edited. Breakpoints therefore add a pre-routing
`TrafficRequestAdmission` rather than mutating a live `TrafficExchange`.

The admission owns immutable trusted identity and timing: Project, request ID,
transport, allowlist pattern, origin, method, exact path, parsed query, original
start time, and bounded original preview collected during spooling. It does not
create a retained row or request sidecar yet.

One transition consumes the admission exactly once:

- `execute(effectiveHeaders, effectiveBody, breakpointEvidence)` creates the
  normal `TrafficExchange`, starts request capture from effective bytes, and
  enters ordinary routing;
- `continueWithoutPublication(originalHeaders, originalBody, clearEpoch)` enters
  normal routing through an ephemeral observation sink while suppressing every
  Traffic row/body publication; this is the Clear Traffic auto-continue path;
- `beginTerminalResponse(originalHeaders, observedBody, terminalEvidence)`
  creates a pre-routing terminal `TrafficExchange` and returns it to the caller,
  which records synthetic response headers/body and finalizes only after actual
  delivery settles;
- `finishWithoutResponse(originalHeaders, observedBody, terminalEvidence)`
  finalizes Drop or disconnect where no HTTP response can be observed; or
- `discard(shutdownEpoch)` suppresses both routing and publication during server
  shutdown.

This seam preserves the original request start time while allowing effective
headers, media type, encoding, and body bytes to become canonical Traffic
evidence. A disconnect during an incomplete request spool finalizes bounded
preview evidence with an unavailable `stream_cancelled` body. A complete spool
used by a pre-routing rejection can be replayed or safely adopted by Traffic
capture without exposing its path. The runtime request pipeline, not the
dashboard or BreakpointService alone, owns the admission and final transition.
Direct and proxy routing are refactored to accept either a retained
`TrafficExchange` or the clear-owned ephemeral observation sink, so Traffic
publication is no longer a prerequisite for correct response delivery.

### Request Stage

For every inspectable direct or proxy request:

1. derive and validate trusted authority as today;
2. match enabled breakpoint rules by Project, normalized origin, method, and
   exact path before Endpoint resolution;
3. reserve one exchange slot or bypass unchanged when the queue is full;
4. create a `TrafficRequestAdmission` and start the 30-second collection
   deadline;
5. stream the request body into an original spool while retaining bounded
   preview state;
6. if collection completes, publish a request-stage Paused Exchange and start a
   new 30-second operator deadline;
7. otherwise bypass request editing through prefix-plus-live replay; and
8. release or advance the same exchange session deterministically.

The dashboard may edit end-to-end request headers and a decoded JSON body.
Origin, method, path, raw query, trusted authority, Host, Content-Length,
Transfer-Encoding, Connection, proxy authentication, and other hop-by-hop or
transport-managed fields are read-only or omitted from editable rows.

Paused header detail is a patchable projection, not a replacement tuple list.
Non-sensitive end-to-end headers expose their ordered values. Sensitive headers
expose name, occurrence count, and a masked marker but not original values. An
omitted header remains byte-for-byte preserved; an operator may explicitly
replace all values or remove it. This lets credentials survive an unedited
Execute without sending masked display text back as data.

```ts
type BreakpointHeaderEdit =
  | { action: 'replace'; name: string; values: string[] }
  | { action: 'remove'; name: string };
```

Names are matched case-insensitively. Replacement preserves supplied value
order and occupies the first original occurrence position, or appends when the
name is new. CR/LF, invalid names, empty replacement arrays, immutable names,
and conflicting duplicate edits are rejected. The server merges edits with its
trusted original tuples, strips hop-by-hop fields, restores trusted authority,
and derives framing.

Execute validates headers and any edited JSON, derives framing headers, and
passes a fresh readable stream plus effective headers into normal runtime
decision processing. Proxy requests retain normal mock-or-upstream behavior.
Direct requests retain normal mock-or-direct-unavailable behavior and never gain
upstream access. Edited headers therefore participate in configured Endpoint
header matching. URL and query matching use the immutable original target.

An unchanged body preserves original bytes and Content-Encoding. Supported
gzip, deflate, and Brotli JSON can be decoded for editing. Unsupported or failed
decoding leaves the body read-only. Editing a decoded content-encoded JSON body
emits UTF-8 identity-encoded JSON, removes the old Content-Encoding, and derives
Content-Length. Traffic captures the effective executed request bytes and
headers, with separate breakpoint evidence recording that an edit occurred.

### Response Stage

Every normal HTTP outcome for an admitted exchange, including direct mock,
proxy mock, upstream response, direct-unavailable response, and canonical
transport/runtime error, produces a prepared response instead of writing
directly to `ServerResponse`. This requires one shared prepared-response seam
across the direct handler and proxy server. For an admitted breakpoint exchange:

1. preserve response source, status, end-to-end headers, close semantics,
   configured mock delay, and upstream status in a `PreparedResponse`;
2. bypass known streaming responses or start a 30-second collection deadline;
3. spool the complete original response entity;
4. if collection completes, publish the response-stage hold and start a new
   30-second operator deadline;
5. otherwise flush the prefix plus live remainder unchanged and release the
   breakpoint session;
6. permit status, end-to-end header, and valid JSON body edits while paused;
7. execute, reject, drop, auto-continue, or observe disconnect; and
8. finalize Traffic from bytes actually delivered or intentionally cancelled.

Transport-managed response fields including Content-Length,
Transfer-Encoding, Connection, and reserved MockMate provenance headers are not
directly editable. Unchanged content-encoded bodies preserve their original
encoded bytes and encoding. Supported gzip, deflate, and Brotli JSON can be
decoded for editing; unsupported or failed decoding is read-only. Edited decoded
JSON becomes UTF-8 identity-encoded content with derived length and no stale
Content-Encoding.

For HEAD, bodyless statuses, and verified zero-byte bodies, the response stage
still pauses metadata and enforces normal HTTP no-body semantics on execution.

Configured mock delay is retained in `PreparedResponse` and begins once after
response Execute or response timeout, before delivery. Reject and Drop discard
that delay. An upstream body error before collection completes produces the
normal sanitized upstream failure because no response bytes have yet reached the
client. A disconnect during delivery abandons the response body as
`unavailable` with reason `stream_cancelled`. Response byte count and bounded
preview describe the delivered prefix, but it is not an exact retained body and
is excluded from overall search. Traffic never claims that the complete prepared
spool reached the client.

### Actions

#### Execute

- Request stage: continue normal routing with accepted request edits.
- Response stage: deliver accepted status, headers, and body edits.
- A body edit must be complete valid JSON. Invalid JSON returns validation
  feedback while the original hold deadline continues.
- The action is accepted once for the current generation and stage revision.

#### Reject

Reject opens a synthetic response editor prefilled with status `502`, safe
end-to-end headers, and a small JSON body identifying a MockMate breakpoint
rejection. The operator may edit status, headers, and JSON before sending.
Reject at the request stage performs no Endpoint resolution or upstream I/O.
Reject at the response stage discards the prepared original response. A rejected
exchange does not enter another response breakpoint. Request-stage Reject uses
`beginTerminalResponse`; synthetic response status, effective headers, delivered
chunks, byte count, delivery cancellation, and final outcome are observed before
the Traffic row finalizes.

#### Drop

Drop destroys the client response/socket without writing an HTTP response. It
cancels pending upstream work, streams, timers, drafts, and spools. Traffic uses
status `499` as internal outcome metadata and a first-class breakpoint drop
reason; no `499` bytes are sent to the client.

#### Timeout

Each published paused stage receives 30 seconds after its separate collection
phase. Timeout executes the original status, headers, and body for that stage
and ignores uncommitted dashboard drafts.
Request timeout continues into normal routing and the response still pauses for
the paired response stage. Response timeout sends the original prepared
response. Countdown truth comes from the server `expiresAt`, not a dashboard
timer.

#### Disconnect

Client disconnect wins over pending dashboard actions. The hold becomes
terminal, all resources release, and later commands return stale. When trusted
request evidence exists, Traffic finalizes as cancelled and remains in the
normal ephemeral Traffic list until clear, row eviction, or restart.

### Paused Exchange Contracts

Add:

```text
GET  /api/admin/projects/:projectId/breakpoints/paused
GET  /api/admin/projects/:projectId/breakpoints/paused/:exchangeId
GET  /api/admin/projects/:projectId/breakpoints/paused/:exchangeId/body
PUT  /api/admin/projects/:projectId/breakpoints/paused/:exchangeId/body-draft
POST /api/admin/projects/:projectId/breakpoints/paused/:exchangeId/actions
```

The list is bounded to the 20 admitted sessions and returns metadata only. Detail
returns the current stage, immutable fields, editable header projection,
original status where applicable, body classification, byte count, digest,
deadline, rule identity, generation token, and stage revision.

The body route streams the current stage's original JSON decoded for editing.
For non-JSON content it supplies a bounded read-only preview and an exact
download stream rather than loading an unbounded binary document into the
browser. It never exposes a filesystem path.

`PUT .../body-draft` streams a replacement JSON document into an
operation-owned spool, validates UTF-8 and complete JSON, and returns a
stage-scoped one-use draft identity and digest. It has no per-body limit but is
subject to aggregate temporary budgets and the existing hold deadline. A draft
does not mutate the held exchange until a valid action references it.

`POST .../actions` is a strict discriminated union:

```ts
type BreakpointAction =
  | {
      action: 'execute';
      generation: string;
      expectedStageRevision: number;
      headerEdits: BreakpointHeaderEdit[];
      bodyDraftId?: string;
      status?: number;
    }
  | {
      action: 'reject';
      generation: string;
      expectedStageRevision: number;
      response: {
        status: number;
        headerEdits: BreakpointHeaderEdit[];
        bodyDraftId?: string;
      };
    }
  | {
      action: 'drop';
      generation: string;
      expectedStageRevision: number;
    };
```

`status` is an integer from 200 through 599 and is accepted on Execute only for
the response stage. Request Execute rejects it. Reject edits are applied to the
server-owned safe synthetic response template; omitted template headers remain
preserved. Drafts are Project-, exchange-, generation-, stage-, and revision-
owned and cannot be replayed across actions.

The dashboard polls paused summaries at 500 ms while Traffic is active and
visible. It loads detail and body only for the selected exchange. Poll ownership
uses the same Project generation and `AbortController` protections as existing
Traffic hooks.

### Traffic Evidence

Extend Traffic with breakpoint evidence without overloading Endpoint routing
decisions:

```ts
type BreakpointBypassReason =
  | 'queue_full'
  | 'temporary_budget_exceeded'
  | 'spool_io_failed'
  | 'collection_timeout'
  | 'streaming_response';

interface BreakpointBodyIdentity {
  sha256: string;
  byteCount: number;
  mediaType?: string;
  contentEncoding?: string;
}

type BreakpointStageEvidence =
  | {
      outcome: 'executed' | 'timed_out';
      edited: boolean;
      originalBody?: BreakpointBodyIdentity;
      effectiveBody?: BreakpointBodyIdentity;
    }
  | {
      outcome: 'rejected' | 'dropped' | 'client_disconnected';
      originalBody?: BreakpointBodyIdentity;
    }
  | { outcome: 'bypassed'; reason: BreakpointBypassReason };

interface TrafficBreakpointEvidence {
  ruleId: string;
  request: BreakpointStageEvidence;
  response?: BreakpointStageEvidence;
}
```

The ordinary routing decision still explains mock, Endpoint passthrough,
no-match passthrough, direct miss, or failure after request execution. A request
rejected, dropped, or disconnected before routing uses the explicit terminal
decision `breakpoint_rejected`, `breakpoint_dropped`, or
`breakpoint_client_disconnected` and does not pretend Endpoint resolution
occurred. These values are added to server and dashboard decision unions.
Promotion is blocked for those terminal decisions. An executed exchange,
including one with edits, retains its ordinary routing decision and remains
eligible under existing promotion rules.

Complete effective executed request and delivered response bodies are the
retained Traffic bodies and therefore the content later searched by overall JSON
search. Cancelled/partial bodies retain only their existing unavailable
descriptor, count, and preview semantics. Complete original/effective digest
metadata remains in breakpoint evidence for audit, but original pre-edit bytes
are not exposed as reloadable Traffic bodies after temporary cleanup. A body
identity is omitted when collection was incomplete.

### Clear, Restart, And Shutdown

The admin route delegates Clear Traffic to a runtime-owned
`TrafficWorkspaceCoordinator`; it no longer calls `TrafficService.clear`
directly. The coordinator is the only owner allowed to span Traffic search,
breakpoint runtime state, Traffic rows, and body caches.

Clear Traffic performs these operations under one Project-owned clear epoch:

1. close new search-session and breakpoint-session admission for the Project;
2. increment the Project runtime clear epoch, abort search sessions, and
   tombstone all pre-epoch Traffic admissions/registrations;
3. atomically transition request-stage admissions through
   `continueWithoutPublication`, response-stage holds to original delivery, and
   make their dashboard action generations stale;
4. detach those sessions from the Paused API without waiting for upstream or
   client delivery to finish;
5. clear Traffic rows/body references and release unneeded breakpoint drafts;
6. reopen admission for post-clear requests; and
7. retain persistent Breakpoint Rules.

The DELETE response returns after the linearization/tombstoning point, paused
sessions are no longer actionable, and retained rows/body references are
cleared. It does not wait for auto-continued network delivery. Any such work
finishes under the stale epoch and cannot publish a Traffic row. Original spools
still needed by that delivery remain operation-owned until delivery settles;
uncommitted drafts release during clear. A participant cleanup failure returns
sanitized `500`, keeps the epoch tombstone authoritative, and leaves residue
eligible for retry/startup cleanup rather than resurrecting state.

Process restart reloads rules from Project persistence. Paused exchanges,
temporary spools, drafts, and Traffic rows do not survive. Startup containment
cleanup removes breakpoint temporary residue. Graceful shutdown marks actions
stale, aborts upstream work, destroys remaining client sockets, and releases all
logical runtime ownership; it does not attempt to persist or replay live
exchanges. Filesystem cleanup is best-effort under failure. Any physically
undeleted, still-contained residue is classified for safe startup cleanup and is
never treated as a live exchange.

Project deletion also delegates to `TrafficWorkspaceCoordinator` before the
repository removes canonical state. It closes Project admission, expires search
sessions, makes actions stale, and detaches all breakpoint sessions. A request-
collection/request-pause or awaiting-response session receives a fixed sanitized
`503 PROJECT_DELETED` when a response is still writable; a response-stage
session delivers its already prepared original response. Both paths suppress
Traffic publication. The repository delete begins only after those transitions
no longer require Project configuration, but does not wait for client delivery.
This prevents deleted Projects from retaining sockets, sessions, spools, or
callable action IDs.

### Breakpoint UI

The Breakpoints panel lists method, origin/path, enabled state, revision, and
last-updated time. It supports enable/disable and delete with stale-revision
recovery. Duplicate identities never appear.

The Paused panel reports session counts by collecting, paused, awaiting response,
and delivering state, and shows actionable rows for currently paused exchanges
with:

- request or response stage;
- method and origin/path;
- elapsed and remaining hold time;
- body type and size;
- rule identity; and
- a clear terminal transition when an action loses a race to timeout or
  disconnect.

The selected exchange detail uses existing header-table and body-document visual
language. JSON is editable through a breakpoint-owned document handle. Non-JSON
body content is read-only and downloadable. Actions remain visible while
scrolling and use `Execute`, `Reject`, and `Drop` labels. Reject opens the
synthetic response editor before confirmation. Drop requires confirmation
because it produces no HTTP response.

### Breakpoint Acceptance Criteria

- Breakpoint This creates one enabled exact origin+method+path rule and reuses
  that identity on repeated clicks.
- Rules survive server restart and remain Project-scoped.
- Query and header differences do not affect rule matching.
- A matching request pauses only after the complete request body is safely
  spooled.
- Execute with no edits preserves original request and response bytes.
- Edited request headers participate in normal Endpoint matching.
- Edited request JSON reaches upstream unchanged except for derived framing and
  intentional content-decoding rules.
- Eligible finite direct, mock, upstream, and canonical error responses pause
  before any response bytes are written to the client. Known or collection-
  timed-out streams bypass unchanged.
- Response status, headers, and JSON edits are delivered and retained as final
  Traffic evidence.
- Non-JSON bodies are read-only while status and safe headers remain editable.
- Reject sends the confirmed synthetic response and performs no later response
  hold.
- Drop sends no HTTP response and releases sockets, streams, timers, and files.
- Request and response collection each bypass after 30 seconds if a complete
  editable body has not arrived; each published paused stage auto-continues
  original content after its own 30-second operator deadline.
- Twenty admitted exchanges are isolated; the twenty-first continues unchanged
  and records a queue bypass.
- Disk/budget failure continues original bytes without corruption or
  duplication.
- Client disconnect and stale actions cannot execute a held exchange twice.
- Clear Traffic releases holds unchanged, removes their Traffic visibility, and
  retains rules.
- Shutdown releases all logical breakpoint ownership. Successful filesystem
  cleanup leaves no temporary files; failed physical deletion is safely
  recoverable at startup.

## Security And Privacy

- Every API enforces Project ownership and uses indistinguishable not-found
  behavior for cross-Project IDs.
- Search and breakpoint body routes remain loopback admin surfaces under the
  existing dashboard-origin protections.
- Search query text and body snippets are never written to logs, diagnostics,
  cursor tokens, or filesystem names.
- Search cursors and paused generation tokens are opaque and unguessable or
  integrity-protected.
- Authority, Host, proxy credentials, hop-by-hop headers, framing headers, and
  reserved MockMate headers cannot be changed through breakpoint editors.
- Edited header names and values reject CR/LF injection and follow existing HTTP
  metadata normalization.
- Synthetic rejection bodies never include filesystem paths, stack traces, or
  secret headers.
- Temporary files use stable contained directories, no-follow opens, restrictive
  permissions, ownership validation, exact-once logical release, and
  retry/startup recovery for failed physical cleanup.

## Performance And Backpressure

- Overall search uses at most two concurrent body leases and bounded-memory
  streaming tokenization.
- Search returns bounded pages and snippets and supports HTTP cancellation.
- Viewer search uses CodeMirror's document model and viewport rendering rather
  than duplicating the complete body string in React state.
- Endpoint tree construction is linear in Endpoint count before sorting and is
  memoized only at the Endpoint summary identity boundary.
- Breakpoint spooling honors stream backpressure and bounded in-memory queues.
- The 20-exchange Project cap is enforced before body buffering begins.
- Aggregate breakpoint temporary-byte accounting prevents “no per-body limit”
  from becoming unbounded process storage.
- Unmatched and disabled-rule traffic stays on the current streaming fast path
  without body spooling or dashboard coordination.

## Testing Strategy

### Unit Tests

- JSON token matching for keys, escaped strings, numbers, booleans, null,
  Unicode, repeated occurrences, and case folding.
- Search cursor ownership, pagination, skipped counters, cancellation, stale
  generation suppression, baseline descriptor validation, session limits, busy
  admission, expiry, and lease release.
- Endpoint tree derivation, sorting, root paths, duplicate path leaves, and
  literal parameter/glob segments.
- Breakpoint rule canonical identity, strict validation, revision conflicts,
  idempotent Breakpoint This behavior, and persistence reload.
- Hold state-machine races among Execute, Reject, Drop, timeout, disconnect,
  clear, and shutdown.
- Header projection and framing derivation for original and edited bodies.
- Temporary spool budget, containment, partial-prefix fallback, exact-once
  logical release, and physical-cleanup recovery.

### Integration Tests

- Search retained request and response JSON through canonical admin routes,
  including gzip, deflate, and Brotli.
- Evict or clear while search owns a lease and verify no stale result or leaked
  lease.
- Pause, edit, and execute an upstream request and response over plain HTTP and
  HTTPS MITM.
- Pause, edit, and execute a direct matched-mock request and response while
  preserving direct passthrough-unavailable behavior.
- Pause a request that normally resolves to a configured mock and verify normal
  routing plus edited-header matching.
- Reject and Drop before routing and during response hold.
- Auto-continue both stages and verify byte identity.
- Collection-timeout and `text/event-stream` bypass preserve prefix/remainder
  identity without retaining a session slot.
- Hold 20 exchanges, overflow the next, disconnect clients, and clear Traffic.
- Clear during request pause continues original bytes without publishing a new
  Traffic row; request-stage Reject records actual synthetic delivery.
- Delete a Project with collecting/request/response sessions and verify all
  runtime IDs, searches, sockets, and spool ownership terminate as specified.
- Restart and verify persistent rules plus absence of paused runtime state.
- HTTP/1.1 keep-alive and pipelined requests preserve per-socket ordering while
  one request is held.

### Dashboard Tests

- Visible JSON search count, highlights, previous/next, owner reset, and
  large-body behavior.
- Overall search debounce/submit cancellation, pagination, skipped summary, and
  navigation into request/response body matches.
- List/Tree preference, selection preservation, expansion, and accessible tree
  interaction.
- Breakpoint This create/reuse feedback, rule revision recovery, paused polling,
  countdown, body draft validation, action races, and terminal feedback.

### End-To-End Smoke Tests

- Capture several JSON exchanges, search a key and value, open a result, and
  navigate visible matches.
- Create a breakpoint from Traffic, repeat the client call, edit request JSON,
  execute, edit the returned response, and verify client-visible and retained
  Traffic content.
- Switch a multi-origin Endpoint project between flat and folder views and open
  leaves at repeated paths.

## Documentation Updates

On implementation, update `docs/traffic-capture.md` with:

- the Traffic JSON search route and retained-only semantics;
- visible JSON viewer search controls;
- Breakpoint Rule and Paused Exchange routes;
- request/response hold, timeout, reject, drop, queue, and clear behavior;
- effective edited Traffic evidence semantics; and
- the Endpoint List/Tree navigation option.

## Explicit Implementation Assumptions

These defaults are specified here because they were not separate product
choices:

- Search debounce is 300 ms; explicit Search submits immediately.
- Overall search stores no recent-query history.
- Representative snippets are bounded to three per body and 160 displayed
  characters each.
- Breakpoint temporary storage shares the 1 GiB per-Project and 2 GiB
  process-wide byte ledger with Traffic temporary capture while retaining
  separate reservation ownership and concurrency limits. Reduced limits are
  injectable in tests.
- Rule enable/disable does not release an exchange that is already paused.
- Paused-summary polling is 500 ms while the Traffic workspace is visible.
- Local Endpoint view preference uses `mockmate.endpoint-view.v1`, defaults to
  `list` on unavailable/invalid storage, and is not synchronized between
  browsers.
