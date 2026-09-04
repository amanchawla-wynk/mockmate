# MockMate Import Preview Design

Date: 2026-08-30
Status: Approved

## Summary

MockMate already exposes server routes and dashboard client methods for cURL and
Postman imports, but the current adapters commit immediately and discard most of
the source information. cURL keeps only method, hostname, and path. Postman
drops the hostname and all saved responses. Every request receives a generated
status-200 JSON `{}` response, and a later failure can leave earlier Endpoints
committed.

This design replaces those direct-commit adapters with a guided, preview-first
workflow. The server parses and validates the source, the user resolves
variables and reviews create/merge/skip actions, and one repository operation
publishes every selected change atomically. Imported requests preserve their
hostname, Postman saved responses become Variants, existing fallback behavior is
not changed by merges, and imported credentials remain preview-only.

This work is the second of three staged designs:

1. Authoring foundation, completed by the preceding design.
2. cURL and Postman import preview, this document.
3. Traffic capture, original-origin passthrough, provenance, and state-aware
   `Mock This`.

## Goals

- Add a guided cURL/Postman import workflow to the Endpoints view.
- Preserve the hostname of every resolvable imported request.
- Preview all changes before canonical records are written.
- Resolve Postman collection variables without persisting the source.
- Convert Postman saved responses into complete response Variants.
- Merge exact Endpoint duplicates without changing an existing fallback.
- Detect potentially overlapping matchers before commit.
- Commit every selected change through one stale-safe atomic publication.
- Preserve stable IDs, revisions, immutable Body Assets, and schema version 3.
- Keep imported request credentials and request examples out of canonical
  response data.

## Non-Goals

- Persisting request examples, request bodies, auth, or import provenance.
- Adding scheme or port to Endpoint matcher identity.
- Importing Postman environments, globals, tests, scripts, or pre-request
  scripts.
- Importing binary or file-backed cURL request bodies.
- Adding imported hosts to `interceptHosts`.
- Binding imported Variants to App States during import.
- Changing proxy interception, passthrough, capture, or Traffic retention.
- Supporting multiple Postman files in one preview.
- Building a lossless MockMate bundle format.
- Preserving the old partial-commit behavior of direct import routes.

## Product Decisions

### Hostname-Only Multi-Backend Identity

An imported Endpoint uses the existing optional `matcher.host`. Canonical
identity does not include scheme or port:

```text
normalized method + normalized hostname + normalized matcher path
```

The preview displays source scheme and port and warns when they are discarded.
If two imported requests differ only by scheme or port, they normalize to one
prospective Endpoint and their response examples are combined.

The term `multi-backend` is preferred in product copy. Slice 2 does not claim
full RFC origin identity because the canonical model distinguishes hostnames,
not scheme-host-port tuples.

### Request Data Is Preview-Only

Only method, hostname, and path become canonical matcher data. Imported query
values, request headers, auth, cookies, and request bodies appear only in a
redacted preview. They are not converted to query/header match constraints and
are not persisted.

This prevents one captured example from becoming an unintentionally strict
matcher and avoids persisting credentials in Endpoint JSON. A future dedicated
request-example model may preserve this information losslessly.

### Initial Responses

Every Postman saved response becomes a candidate Variant. For a new Endpoint,
the first saved response in collection order is the fallback.

A request without a saved response receives one fallback Variant:

```text
name: Default
status: 200
response headers: none
body: none
delay: none
```

The current generated `application/json` `{}` response is removed.

### App States And Interception

Import does not update App State bindings. New Endpoints resolve through their
fallback until a user explicitly binds another Variant. The preview warns that
existing App States will not explicitly bind the new Endpoints.

Import does not update runtime interception settings. Discovered hosts are
listed in the wizard with copy explaining that proxy interception remains a
separate setting in the Traffic Capture slice.

## Architecture Decision

Use a stateless server-owned preview and replay architecture.

The preview request sends the source to the server. The server parses it,
redacts request details, computes conflicts against the current repository
snapshot, and returns an opaque snapshot token. No preview session or raw source
is stored server-side.

The commit request resends the same source, supplied variable values, selected
item IDs, actions, and snapshot token. Inside the Project mutation queue, the
server:

1. reparses and normalizes the source;
2. recomputes deterministic item IDs and proposed conflicts;
3. recomputes the import-relevant snapshot fingerprint;
4. rejects a stale token before allocating records;
5. clones the current Project snapshot;
6. applies every selected create and merge;
7. stages required immutable Body Assets;
8. validates referential integrity and strict schemas;
9. compiles the complete candidate;
10. publishes one complete generation;
11. removes newly created unreferenced assets if publication fails.

Body bytes are managed by a repository-private import transaction created
inside the same Project queue entry. The transaction stages bytes, exposes
staged metadata while the candidate is validated and compiled, records which
assets pre-existed, promotes operation-owned assets immediately before
generation publication, and rolls back only operation-owned assets when a
handled failure occurs before the generation pointer changes. Existing and
deduplicated assets are never deleted. A process crash may leave an
unreferenced immutable blob, but cannot publish a partial canonical Project;
crash-time blob garbage collection is outside Slice 2.

The dashboard never predicts canonical IDs or revisions. It reloads canonical
resources after commit.

### Snapshot Token

`Project.revision` is not an aggregate version and therefore cannot protect an
import preview. The opaque snapshot token is a versioned HMAC envelope bound to
the Project ID and source type. It contains independently verifiable digests for
both the import-relevant canonical snapshot and the normalized preview plan.
The HMAC uses a process-local random key; a server restart invalidates an open
preview and requires the wizard to refresh it. The canonical digest includes:

- Endpoint IDs, revisions, normalized matchers, and fallback IDs;
- Variant IDs, revisions, names, status, normalized response headers, Body
  Asset IDs, and delays;
- Body Asset identity and immutable media metadata referenced by Variants.

App State bindings, Project display fields, workspace selection, and runtime
settings do not affect duplicate or Variant-content decisions and are excluded.
The preview's affected-App-State list is advisory and may change independently;
commit never mutates those States and the dashboard reloads them afterward.

Any relevant Endpoint, Variant, or referenced Body Asset change invalidates the
preview, even when it would not affect a selected row. This conservative rule
keeps commit behavior deterministic.

The normalized-plan digest includes ordered source-member locations, resolved
request identities, resulting Endpoint names and descriptions, the ordered
candidate response sequence with names and identities, warnings/errors, and a
keyed one-way digest of supplied variable values. It never includes raw source
or plaintext secrets in the response token. Semantically equivalent source
formatting may reproduce the same plan digest. A changed canonical digest or an
invalid token signature returns `IMPORT_PREVIEW_STALE`; source or variable input
that no longer reproduces the preview plan returns `IMPORT_SELECTION_INVALID`.
This prevents a commit from applying display or response content that the user
did not preview and prevents cross-Project token reuse.

### Deterministic Preview Items

Parsing first assigns each source member a structural location:

- cURL command index after shell-aware tokenization;
- Postman folder/item index path.

After URL resolution and matcher normalization, members with equal request
identity form one prospective preview item. Its ID is a versioned hash of source
type, normalized request identity, and the ordered list of every member's
structural location. The item exposes those locations and combines saved
responses in that same order. Commit repeats grouping before validating IDs.
Unknown or duplicate item IDs, and missing actions for selected items, reject
the commit. Preview IDs never become canonical record IDs.

A member whose URL cannot yet be resolved does not receive a prospective item
ID. It appears in `unresolvedMembers` with a provisional source-member ID hashed
from source type and structural location. Variable requirements and enumerable
member errors reference that provisional ID. After variables are supplied, the
server reparses and moves resolvable members into grouped `items`; provisional
IDs are never accepted by commit and are not preserved as item choices.

## Source Parsing

### cURL

The cURL parser is a tokenizer, not a shell executor. It supports common browser
and Postman `Copy as cURL` output:

- quoted and unquoted URLs;
- `--url`;
- backslash line continuations;
- multiple commands separated by newline, `;`, or `&&` outside quotes;
- `-X` and `--request`;
- `-H` and `--header`;
- `-d`, `--data`, `--data-raw`, and literal `--data-binary`;
- single quotes, double quotes, and ordinary backslash escaping.

The parser never performs environment expansion, command substitution, file
reads, or network access. Backticks, `$()`, dynamic URL variables, `@file`
payloads, form/file upload flags, and ambiguous shell syntax produce item-level
errors. Supported canonical methods remain GET, POST, PUT, PATCH, and DELETE.
Unsupported methods remain visible but unselected.

Data flags imply POST only when no explicit method is present. Request body
bytes and headers are used only for the redacted preview.

### Postman

Slice 2 accepts one Postman Collection v2.1 JSON file. The collection is
validated structurally before item parsing.

Nested folders are traversed depth-first in source order. Each item retains a
folder breadcrumb for preview, while the Endpoint name remains the request
name. Names are display data and need not be unique.

Collection variable values are applied first. Every remaining `{{variable}}`
referenced anywhere in a request URL is returned as a required wizard input,
including variables that occupy a complete path segment. User-supplied values
apply only to that preview and commit; they are never written to Project data.
An affected request remains blocked until every URL template variable is
supplied and produces a valid URL.

URL resolution occurs before hostname/path normalization. After template
resolution and URL parsing, Postman colon-style path parameters such as `:id`
become `*`. A `{{variable}}` is never implicitly converted to `*`.

Disabled request items remain visible and unselected. Disabled headers and
query entries are ignored. Effective Postman auth is resolved in collection,
folder, then request override order and returned only as a redacted request
summary. It is never persisted. Events, scripts, tests, pre-request scripts,
and environment references are ignored with warnings and never evaluated or
converted into response data.

### Request Redaction

The preview response never echoes raw source text. It returns structured request
summaries with secret values masked. At minimum, redaction covers:

- `Authorization`, `Proxy-Authorization`, `Cookie`, and `Set-Cookie` request
  headers;
- header and query names containing token, secret, password, key, credential,
  session, or auth, case-insensitively;
- URL user information;
- Postman auth fields;
- user-supplied variable values that feed any redacted location.

Request body preview is omitted by default and represented by media type and
byte count. This avoids returning unknown secret-bearing body content to the
dashboard.

## Response Normalization

Saved Postman responses preserve:

- response name;
- numeric status;
- repeated response-header values in source order per case-insensitive name;
- UTF-8 response body bytes.

Response status must satisfy the canonical status range, and every response
header must satisfy Node-compatible name/value validation. Unsupported status
or header data makes the containing collapsed item invalid. Response names are
trimmed for canonical display; a blank name becomes `Response N` using its
one-based position within the collapsed item before deterministic conflict
suffixing.

`Content-Type` is validated as an HTTP header value, not reparsed as a media-type
grammar. A Node-compatible value is preserved verbatim, including on a bodyless
response; an invalid header value invalidates the item. The fallback below
applies only when a non-empty body has no preserved `Content-Type` header.

Imported response bodies use canonical `application/octet-stream` Body Asset
metadata, independent of saved response headers. A normalized saved
`Content-Type` remains Variant response data and is authoritative during
delivery; the response writer must prefer it over Body Asset media metadata.
When no saved `Content-Type` exists, delivery falls back to the Body Asset's
`application/octet-stream` metadata without inventing a Variant header.
This permits equal body bytes with different response media types while keeping
schema version 3. If those bytes already exist under incompatible immutable
metadata, commit returns `ASSET_METADATA_CONFLICT` rather than changing them.

Body-owned and hop-by-hop headers are normalized safely:

- `Content-Length` is discarded and recomputed during delivery;
- `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Proxy-Authenticate`,
  `Proxy-Authorization`, `TE`, `Trailer`, and `Upgrade` are discarded;
- `Content-Encoding` is discarded because Postman collection bodies are stored
  as decoded text rather than encoded wire bytes;
- each discarded field produces a preview warning;
- repeated `Set-Cookie` values remain independent ordered values.

Binary Postman examples without a faithful textual body representation are
unsupported. A saved response body above 10 MiB remains visible with an item
error. Because response-level selection is not supported, either condition
makes the containing collapsed preview item invalid and uncommittable.

## Duplicate And Conflict Semantics

### Requests Within One Source

Requests with identical normalized method, hostname, and path collapse into one
prospective Endpoint. Their saved responses are combined in source order. The
first source member supplies the Endpoint display name and description; all
member locations and breadcrumbs remain visible in preview. Duplicate cURL
requests without response examples collapse to one new Endpoint or one skip
decision.

For a new Endpoint, every supported saved response becomes a Variant in source
order even when two responses have equal content identity; the first remains
fallback. Content identity deduplication applies when merging into an existing
Endpoint, where responses identical to existing Variants or earlier candidates
in the same merge add no new behavior.

### Exact Existing Endpoint

When the canonical identity exactly matches an existing Endpoint, the proposed
action is `merge`.

- An example-free cURL request proposes `skip` because it adds no behavior.
- A request whose responses are all identical to existing Variants also
  proposes `skip`.
- Existing fallback selection never changes.
- Existing Variant revisions and IDs remain unchanged.
- Each affected Endpoint revision increments exactly once when one or more
  Variants are added.
- App State bindings and revisions remain unchanged.

An exact duplicate cannot use `create`; equal matcher resolution would depend
on generated-ID ordering. Its available actions are merge and skip.

Legacy data may contain more than one existing Endpoint with the same exact
identity. Preview returns all of them as merge targets and leaves the row's
target unresolved until the user selects one. `create` remains unavailable.

### Variant Identity

Imported response identity is a deterministic hash of:

- numeric status;
- filtered, lowercased header names in sorted order;
- ordered values for each repeated header, represented uniformly as arrays;
- body SHA-256, or an explicit no-body marker.

Identity is computed after discarded-header filtering. A scalar value and a
single-element array are equivalent. Header values otherwise remain exact UTF-8
strings and are not reordered. An explicitly present empty body hashes its zero
bytes and is distinct from no body.

Variant name is not part of identity. During an existing-Endpoint merge,
identical response content is skipped even when names differ. Distinct responses
are preserved. When a new name conflicts case-insensitively within the Endpoint,
the importer chooses the first available deterministic suffix: `Name (2)`,
`Name (3)`, and so on.

### Overlapping Matchers

Non-identical matchers that may match the same request are overlap conflicts.
Examples include wildcard host/path matchers and hostless Endpoints with the
same method/path.

Import identity uses the same method, host, and path normalizers as runtime
compilation. Overlap analysis compares each prospective item with current
canonical Endpoints and with other prospective items after exact collapsing.
Specificity uses the runtime matcher rank.

Overlap is deliberately conservative and deterministic. Methods must be equal.
Host dimensions can overlap when either host is absent, when two exact hosts are
equal, when a wildcard host matches an exact host, or when both hosts contain
wildcards. Path dimensions can overlap when exact paths are equal, when a
wildcard path matches an exact path, or when both paths contain wildcards. A
request is classified as a possible overlap only when both host and path
dimensions can overlap. Two wildcard patterns may therefore require review even
when their actual languages are disjoint; preview and commit use this same rule.

Valid overlap rows remain selected by default. Their available actions are
create and skip; merge is available only for exact canonical identity. Preview
explains every overlapping matcher and relative specificity. Equal-specificity
overlaps default to create but remain unresolved until explicitly confirmed or
changed to skip.

Creating a host-specific Endpoint beside a hostless method/path Endpoint is
allowed because the host-specific Endpoint is more constrained. Creating beside
an equal-specificity wildcard matcher requires explicit confirmation in the
row. Import does not silently alter or delete the existing matcher.

## API Design

### Preview

```http
POST /api/admin/projects/:projectId/import/preview
```

```ts
interface ImportPreviewRequest {
  source:
    | { type: 'curl'; text: string }
    | { type: 'postman'; collection: unknown };
  variables?: Record<string, string>;
}
```

The response includes:

```ts
interface ImportPreview {
  snapshotToken: string;
  sourceType: 'curl' | 'postman';
  items: ImportPreviewItem[];
  unresolvedMembers: ImportUnresolvedMember[];
  unresolvedVariables: ImportVariableRequirement[];
  discoveredHosts: string[];
  affectedStates: Array<{ id: string; name: string }>;
  summary: {
    valid: number;
    invalid: number;
    create: number;
    merge: number;
    skip: number;
  };
}
```

Each item contains its deterministic ID, source location/breadcrumb, request
name, normalized matcher, redacted request summary, response summaries,
proposed/allowed actions, all exact duplicate targets when present, overlap
details, warnings, errors, and default selection state. `affectedStates`
contains every current App State only when at least one preview item proposes a
new Endpoint; a merge-only preview reports none because bindings are unchanged.

### Commit

```http
POST /api/admin/projects/:projectId/import/commit
```

```ts
type ImportAction =
  | { itemId: string; action: 'create'; confirmOverlap?: boolean }
  | { itemId: string; action: 'merge'; endpointId: string }
  | { itemId: string; action: 'skip' };

interface ImportCommitRequest extends ImportPreviewRequest {
  snapshotToken: string;
  selectedItemIds: string[];
  actions: ImportAction[];
}
```

Every valid preview item is selected by default. `selectedItemIds` represents
the current checkbox state. `actions` contains exactly one action for every
selected item and no others. Invalid items cannot be selected. A valid
unselected item has no action. Unknown or duplicate item IDs, missing or extra
actions, disallowed actions, stale merge targets, and unconfirmed
equal-specificity overlaps reject the whole commit.

After source replay and item-ID validation, the server compares the snapshot
token before validating merge targets against current canonical records. A
previewed target that changed or disappeared therefore returns
`IMPORT_PREVIEW_STALE`. With a non-stale token, an `endpointId` that is not one
of the preview-derived exact targets returns `IMPORT_SELECTION_INVALID`.

Successful commit returns canonical IDs and counts:

```ts
interface ImportCommitResult {
  createdEndpointIds: string[];
  updatedEndpointIds: string[];
  createdVariantIds: string[];
  skippedItemIds: string[];
}
```

`skippedItemIds` contains valid unselected items and items explicitly committed
with `skip`. Invalid preview items are not included in the commit result.

A successful preview returns 200. Commit returns 201 because every successful,
non-no-op commit creates at least one Endpoint or Variant, including merge-only
commits. The dashboard reloads Endpoint and App State data instead of treating
this response as canonical detail.

### Existing Routes

The existing direct-commit routes are removed:

```text
POST /api/admin/projects/:projectId/import/curl
POST /api/admin/projects/:projectId/import/postman
```

No dashboard component currently calls them, and preserving their partial-commit
behavior would contradict this design. No compatibility shim is added without a
concrete external consumer.

## Atomic Repository Mutation

The import commit is one `ProjectRepository` operation and one Project queue
entry. The dashboard never coordinates per-Endpoint calls.

For a new Endpoint:

- Endpoint and Variant stable IDs are allocated during commit;
- Endpoint revision starts at 0;
- Variant revisions start at 0;
- the first candidate Variant is fallback;
- an example-free request receives the empty status-200 fallback.

For a merged Endpoint:

- the current Endpoint and every merge target are re-read under the queue;
- only distinct response Variants are added;
- Endpoint revision increments once regardless of added Variant count;
- existing fallback remains unchanged;
- existing Variants and App State bindings are not rewritten.

The candidate is written with `publishGeneration()`, not a sequence of
`publishJson()` calls. The repository validates and compiles first, writes a
staged generation, promotes operation-owned assets, and atomically switches the
generation pointer. Validation, compile, staging, asset-promotion, or pointer
failure leaves the previous pointer and compiled Project active and rolls back
operation-owned assets. After the pointer changes, a non-throwing in-memory map
swap publishes the already compiled candidate. HTTP response failure after that
point does not roll back a committed import; the client refreshes canonical data
to determine the outcome.

Body Assets remain content-addressed and immutable. The operation tracks assets
created solely for the candidate. On failure, it removes only newly created
assets that are not referenced by the prior published snapshot. Existing or
deduplicated assets are never deleted during rollback.

The Body Store gains a repository-private staged-import interface rather than
exposing client-side cleanup. Candidate validation reads prior and staged
metadata through one overlay. Promotion and rollback disposition are determined
by the transaction, so ordinary `putBody()` behavior and public Body Asset APIs
remain unchanged.

## Guided Dashboard Workflow

Import opens from the Endpoints view in the shared accessible `Modal` shell. It
uses a large desktop dialog and a full-screen single-column mobile layout.

### Step 1: Source

- Tabs select cURL or Postman.
- cURL accepts one or more pasted commands.
- Postman accepts drag-and-drop or file selection for one `.json` file.
- The file/source remains in dashboard memory for preview and commit.
- Preview loading uses a layout-matched skeleton.
- Structural parse failures appear inline without clearing source input.

### Step 2: Resolve

This step appears only when variables or item errors require attention.

- Collection defaults are applied before rendering.
- Unresolved URL variables have visible labels and helper text.
- Invalid items show unsupported syntax, methods, or response formats.
- Invalid items remain unselected.
- Continuing reruns preview with supplied values.

### Step 3: Review

All valid items are selected by default. The scrollable review table shows:

- selection;
- method;
- hostname and path;
- source breadcrumb;
- candidate response count;
- create, merge, or skip action;
- warnings and errors.

Rows can expand to show redacted request details and response summaries. Filters
cover selected, warnings, errors, new, and merge.

The summary shows selected requests, new Endpoints, merged Variants, discovered
hosts, skipped duplicates, and affected App States. Copy explicitly says:

- imported hosts become Endpoint matchers only;
- interception settings are unchanged;
- imported Endpoints remain unbound in existing App States;
- Endpoint fallback behavior remains available.

Commit is disabled when no effective changes remain, selected rows are invalid,
variables are unresolved, conflicts lack actions, or equal-specificity overlaps
lack confirmation.

### Completion And Refresh

While commit is pending, the wizard cannot be dismissed and all source/action
controls are disabled. A successful commit replaces the table with a concise
result summary and `View Endpoints` action.

The dashboard then reloads:

- Endpoint summaries;
- App State summaries;
- selected App State detail, when present.

Import does not select or open a generated Endpoint automatically because one
commit may create many records.

Closing a non-empty wizard uses the existing unsaved-changes confirmation.
Preview requests are abortable on close. An accepted commit is not presented as
client-cancellable after the server begins the queued mutation.

### Stale Preview Recovery

`IMPORT_PREVIEW_STALE` leaves the wizard on Review with the source and variable
values intact. `Refresh preview` reparses the source and preserves selection
when an item ID remains valid. It preserves `merge` only when the selected exact
target Endpoint ID is unchanged. It preserves `create` and overlap confirmation
only when the overlap target set, specificity classification, and confirmation
requirement are unchanged. New valid items default selected. Changed conflicts
remain selected but return to an unresolved action or confirmation state.

## Error Semantics

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `MALFORMED_JSON` | Request JSON cannot be parsed. |
| 400 | `INVALID_PROJECT_ID` | Project path segment is not stable. |
| 404 | `PROJECT_NOT_FOUND` | Project does not exist. |
| 413 | `PAYLOAD_TOO_LARGE` | The complete HTTP request exceeds 12 MiB. |
| 422 | `IMPORT_SOURCE_INVALID` | Source structure is unenumerable. |
| 422 | `IMPORT_VARIABLES_REQUIRED` | Replayed source still contains unresolved URL templates. |
| 422 | `IMPORT_SELECTION_INVALID` | Item IDs, actions, targets, or confirmations are invalid. |
| 422 | `IMPORT_NO_CHANGES` | Nothing is selected or every selected item resolves to skip/no-op. |
| 422 | `IMPORT_LIMIT_EXCEEDED` | Source-part, request-item, or saved-response limits are exceeded. |
| 409 | `IMPORT_PREVIEW_STALE` | Import-relevant canonical data changed. |
| 409 | `ID_COLLISION` | Stable ID allocation was exhausted. |
| 409 | `ASSET_METADATA_CONFLICT` | Existing immutable bytes have incompatible metadata. |

Successful preview, including enumerable item errors and unresolved variables,
returns 200. A structurally unenumerable source returns
`IMPORT_SOURCE_INVALID`. Request-specific parser problems are returned as item
errors whenever the collection or cURL command list can still be enumerated.
`IMPORT_VARIABLES_REQUIRED` is commit-only and is checked before item selection;
commit requires every URL template in the replayed source to be resolved even
though unresolved members are not selectable. An oversized enumerable saved
response is a preview item error; invalid items cannot be selected. Expected
parser failures map to documented errors, while unexpected defects remain
sanitized `500 INTERNAL_ERROR` responses.

All errors retain canonical request IDs and sanitized filesystem details.

## Limits And Security

- The complete HTTP request remains limited to 12 MiB.
- Serialized `source` is limited to 10 MiB. Variables, token, selections, and
  actions together are limited to 1 MiB, leaving at least 1 MiB for JSON framing.
- Each saved response body is limited to 10 MiB measured as UTF-8 bytes before
  Body Asset creation and remains subordinate to the source-envelope limit.
- One preview accepts at most 1,000 traversed request items and 5,000 traversed
  saved responses. Disabled, malformed, and subsequently collapsed entries all
  count toward these limits.
- Exceeding a semantic count or source-part limit returns
  `IMPORT_LIMIT_EXCEEDED`; exceeding the HTTP envelope returns
  `PAYLOAD_TOO_LARGE`.
- Import never executes shell syntax, collection scripts, or network requests.
- Postman file parsing occurs as data only.
- Raw sources and supplied variables are not logged or persisted.
- API error details do not include raw command text, credentials, or response
  bodies.
- The dashboard keeps source data only for the lifetime of the open wizard.
- Commit revalidates every server-derived decision and does not trust client
  preview labels, matchers, response summaries, or canonical revisions.

## Testing Strategy

### Parser Tests

- quoted/unquoted and `--url` cURL forms;
- multiline commands and shell-aware separators;
- quoted text containing `curl`, `;`, or `&&`;
- method and data-flag semantics;
- unsupported shell constructs and methods;
- Postman folder order, variables, structured/string URLs, and path parameters;
- disabled entries and malformed items;
- saved statuses, bodies, repeated headers, hop-by-hop filtering, and size limits;
- bodyless and body-bearing `Content-Type` delivery precedence;
- request secret redaction without response-header corruption.

### Repository Tests

- deterministic snapshot and item IDs;
- project/source-bound token authentication and restart invalidation;
- rejection when replayed source or variables no longer match the preview plan;
- provisional unresolved-member IDs becoming final grouped item IDs;
- exact grouping across multiple structural source locations;
- exact duplicate merge and example-free skip;
- response-content deduplication and deterministic name suffixes;
- duplicate saved-response preservation for new Endpoints;
- multiple legacy exact-match target selection;
- overlap classification and confirmation;
- new Endpoint and merged Endpoint revision rules;
- existing fallback preservation;
- one queued generation publication;
- stale preview rejection;
- stable ID collisions;
- Body Asset deduplication and failure cleanup;
- rollback on validation, compile, staging write, rename, and pointer failures;
- no App State binding/revision or runtime-setting mutation.

### Route Tests

- strict source union and action payloads;
- malformed JSON, stable IDs, missing records, and status/error codes;
- item limits and body limits;
- redacted preview payloads and request IDs;
- old direct routes return 404;
- commit returns IDs/counts rather than predicted canonical records.

### Dashboard Tests

- accessible modal ownership and responsive step flow;
- cURL paste and Postman file/drop handling;
- source, loading, empty, error, Resolve, Review, stale, and success states;
- item selection, action constraints, filters, expansion, and overlap confirmation;
- secret values never render unmasked;
- preview abort and commit dismissal lock;
- unsaved-close confirmation;
- stale refresh preserves only still-valid choices;
- canonical Endpoint/App State refresh after commit.

### Integration Tests

One acceptance flow must:

1. preview a Postman collection containing multiple backend hosts, a path
   parameter, variables, saved bodies, and repeated `Set-Cookie` headers;
2. commit new and merged items atomically;
3. verify the existing Endpoint fallback remains unchanged;
4. restart MockMate;
5. verify host-specific and wildcard-path delivery with exact status, body, and
   repeated headers;
6. attempt a stale or injected-failure multi-item commit;
7. prove that no partial Endpoint, Variant, binding, or orphan Body Asset became
   published.

## Delivery Boundary

Slice 2 is complete when users can preview one pasted cURL source or one Postman
Collection v2.1 file, resolve variables, review deterministic create/merge/skip
actions, and atomically publish canonical Endpoints and response Variants across
multiple backend hostnames.

It does not change interception or passthrough behavior. Slice 3 will use the
imported host matchers as one source of configuration guidance while keeping
runtime interception an explicit user choice.
