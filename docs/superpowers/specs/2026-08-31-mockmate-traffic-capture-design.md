# MockMate Traffic Capture Design

Date: 2026-08-31
Status: Approved

## Summary

MockMate will provide a Proxyman-style Traffic workspace for explicitly
allowlisted backend hostnames while retaining its state-first mocking model.
Applications continue calling their real backend URLs through MockMate's proxy.
For every inspectable request, MockMate records the traffic outcome, matches a
canonical Endpoint request definition, and either serves a mock Response Variant
or passes the request through to its original scheme, hostname, and port.

The canonical model changes in schema version 4. A Project no longer owns a
base URL. Every Endpoint owns one required HTTP or HTTPS origin and the complete
request matcher: method, path, query constraints, and request-header
constraints. Endpoint mode is a reversible `mock` or `passthrough` toggle.
Response Variants contain response behavior only. A Project may therefore model
many backend services, including Endpoints that share an origin, method, and
path but differ by query or request-header constraints.

Traffic metadata is retained for every inspectable request. Exact request and
response body retention is a separate explicit Project setting. When enabled,
complete bodies are captured through a bounded non-blocking sidecar into an
ephemeral content-addressed cache. The immediate 16 KiB preview remains
available regardless of exact-body retention. The dashboard loads complete text
bodies lazily, downloads binary bodies exactly, and never lets capture storage
slow or fail application traffic.

`Mock This` reviews one captured request and response, requires an exact
promotable response body, creates or reuses the canonical Endpoint and Response
Variant atomically, and may bind the Variant to an explicitly selected App
State. Runtime App State selection can be disabled completely, in which case
mock Endpoints use their fallback Variants and both active and base App State
bindings are ignored.

This design is the third staged MockMate design after Authoring Foundation and
Import Preview. It supersedes the Project-base-URL and hostname-only Endpoint
identity decisions in those earlier slices. It adopts the approved direction in
`2026-08-28-mockmate-large-body-experience-design.md` as a binding dependency.

## Goals

- Record every inspectable request whose hostname matches an explicit exact or
  wildcard interception allowlist entry.
- Preserve original-origin passthrough for every unmatched selected proxy
  request or explicitly passthrough proxy Endpoint without requiring a Project
  base URL.
- Let one Project contain canonical Endpoints for multiple HTTP and HTTPS
  backend origins.
- Make the Endpoint, not the Variant, own all request matching behavior.
- Let each Endpoint switch reversibly between mock and passthrough without
  deleting dormant Variants or App State bindings.
- Let users disable App State selection completely while retaining configured
  active and base State choices for later re-enablement.
- Record one consistent provenance vocabulary for mock, passthrough, miss,
  upstream failure, and capture outcomes.
- Capture complete request and response bodies without adding unbounded memory,
  disk, or transport backpressure.
- Provide exact lazy viewing and download for retained Traffic bodies.
- Promote an exact captured response into canonical Body Asset, Endpoint,
  Variant, and optional App State binding state atomically.
- Persist first-class Traffic provenance for Variants created from capture
  rather than using editable descriptions as identity.
- Guide users from Endpoint and import origins to interception configuration
  without changing runtime interception implicitly.
- Preserve stable IDs, optimistic revisions, immutable Body Assets, one queued
  generation publication, and owner-safe dashboard async behavior.

## Non-Goals

- Competing with Proxyman or Charles as a general-purpose packet debugger.
- Recording blind-tunneled HTTPS hosts that were not explicitly selected for
  interception.
- Transparent interception without the existing certificate and proxy setup.
- Permanent Traffic history, Traffic replay, breakpoint editing, rewrite rules,
  throttling, or captured-flow persistence.
- A Project-level upstream origin or Project-level passthrough switch.
- Per-Variant request matching fields.
- Automatically persisting captured request headers as Endpoint constraints.
- Automatically enabling interception after Endpoint creation or import.
- Promoting truncated, evicted, unavailable, or preview-only response bodies.
- Manual Traffic-body pinning or remote/distributed body storage.
- Full inline editing of binary Traffic bodies.
- Schema-v3 migration or compatibility adapters. There is no production data to
  preserve; schema version 4 is a direct cutover.
- Per-device App State selection. Project-global state selection remains the
  current execution model.

## Product Language

- Use `Traffic`, not `Logs`, in routes, types, navigation, and user-facing copy.
- Use `origin` for `scheme://hostname[:port]`.
- Use `Endpoint base URL` in the dashboard label, with helper copy explaining
  that it is an origin only and cannot contain a path, query, fragment, or user
  information.
- Use `interception allowlist` for the exact and wildcard hostname patterns that
  MockMate may inspect.
- Use `Mock` and `Passthrough` for the Endpoint mode toggle.
- Use `App State mode` for the Project-level enabled/disabled runtime choice.
- Use `Mock This` for the reviewed Traffic-to-canonical promotion action.

## Schema Version 4

Schema version 4 is a direct cutover. The repository, strict validators, public
API contracts, dashboard mirrors, tests, fixtures, and persisted generation
files all move together. No schema-v3 reader or migration is retained.

### Project

`Project.baseUrl` is removed. App State selection gains an explicit mode:

```ts
type AppStateMode = 'enabled' | 'disabled';

interface Project {
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
```

When `appStateMode` is `disabled`, runtime resolution ignores both
`activeStateId` and `baseStateId`. The IDs remain stored so re-enabling the mode
restores the previous selections. The dashboard presents an explicit on/off
control rather than overloading an empty active-State selection.

App State binding coverage, missing-binding counts, selection confirmation, and
coverage warnings include only mock-mode Endpoints that have a valid fallback.
Passthrough Endpoints and passthrough-only Endpoints with no Variants are
excluded because runtime never resolves their bindings. When State mode is
disabled, Traffic provenance records configured active/base IDs as context but
has no selected State ID and uses the stable fallback reason
`app_state_mode_disabled` before Endpoint fallback.

New Projects require only name and optional description. They do not ask for a
base URL.

### Endpoint

An Endpoint is one complete request definition:

```ts
type EndpointMode = 'mock' | 'passthrough';

interface EndpointDetail {
  schemaVersion: 4;
  id: string;
  projectId: string;
  name: string;
  description?: string;
  baseUrl: string;
  matcher: {
    method: string;
    path: string;
    query?: Record<string, MatchExpression[]>;
    headers?: Record<string, MatchExpression>;
  };
  mode: EndpointMode;
  defaultVariantId?: string;
  variants: ResponseVariant[];
  revision: number;
}
```

`baseUrl` is a required normalized HTTP or HTTPS origin. Accepted source forms
contain only scheme, hostname, and optional port. Validation rejects user
information, paths other than `/`, query, fragment, unsupported schemes,
malformed IDNs, local MockMate addresses where applicable, and ambiguous ports.
Normalization:

- lowercases and IDNA-normalizes the hostname;
- removes a trailing hostname dot;
- removes default `:80` for HTTP and `:443` for HTTPS;
- preserves non-default ports;
- emits no trailing slash in canonical identity;
- contains no credentials, query, or fragment.

The matcher path remains an absolute request path and retains current exact/glob
semantics. One shared query parser serves proxy matching, direct matching,
Endpoint validation, import, promotion, canonical identity, and stale replay. It
splits the raw query on `&`, splits each field at its first `=`, interprets `+`
as space, and percent-decodes UTF-8 key and value bytes. No query, a lone `?`,
and only empty `&` segments produce no entries. Leading, trailing, and repeated
`&` empty segments are ignored. `a` and `a=` both produce key `a` with an empty
value. `=x` produces an allowed empty key. Encoded `&`/`=` remain component data
because splitting precedes decoding. Unescaped raw query bytes must be ASCII;
non-ASCII source text must be UTF-8 percent-encoded. Query names are
case-sensitive. Decoded keys and values receive no Unicode, case, whitespace,
or numeric normalization. Different percent encodings of the same valid UTF-8
sequence therefore share identity.

A malformed percent escape, invalid UTF-8, or raw non-ASCII octet makes a
runtime query ineligible for Endpoint matching. Selected proxy traffic passes
through unchanged with `query_parse_invalid` provenance; selected direct traffic
returns `404 ENDPOINT_NOT_FOUND` with the same recorded reason. The equivalent
authored/imported source is rejected as invalid. Request-header names normalize
to lowercase. Query and header values retain explicit `equals` or `glob`
expressions.

Query constraints preserve repeated entries as a multiset. Every configured
expression for a key must match a distinct incoming occurrence through an
injective assignment; implementations use deterministic bipartite matching, not
greedy source order, so overlapping glob and equals expressions cannot consume
the wrong occurrence. Additional incoming occurrences are allowed. Duplicate
configured values therefore retain their multiplicity. Canonical identity is
canonical JSON with code-unit-sorted query keys and each key's expression array
code-unit-sorted by operator then value while preserving duplicate count. This
structural serialization is unambiguous for empty names/values and replaces the
schema-v3 one-expression/any-occurrence query behavior.

Every query key must contain at least one expression. Validation rejects empty
expression arrays. Empty query and header constraint objects normalize to
absence before matching, specificity, duplicate detection, and identity
serialization, so omitted and empty collections cannot create distinct
Endpoints.

Endpoint identity is the canonical serialization of:

```text
normalized baseUrl origin
+ normalized method
+ normalized path expression
+ code-unit-sorted normalized query constraints
+ code-unit-sorted normalized request-header constraints
```

Two Endpoints may share base URL, method, and path when their query or
request-header constraints differ. Two exact canonical request identities in
one Project are rejected. Overlapping non-identical matchers remain legal and
use the existing specificity ordering, extended so exact origin identity is
evaluated before query/header and path specificity. Query specificity counts
every repeated configured expression. Stable Endpoint ID is the final
tie-breaker only for legal equal-specificity overlaps.

Endpoint mode semantics:

- `mock` requires at least one Variant and a `defaultVariantId` that belongs to
  the Endpoint;
- `passthrough` may contain zero Variants;
- a passthrough Endpoint that contains Variants must retain a valid
  `defaultVariantId` so it can return to mock mode;
- Variants and App State bindings remain stored but are ignored while the
  Endpoint is in passthrough mode;
- a passthrough Endpoint with no Variants cannot switch to mock until the user
  creates a fallback Variant;
- toggling mode never deletes Variants, Body Assets, or App State bindings.

Endpoint summaries include `baseUrl`, mode, method, path, query/header
constraint counts, Variant count, and mock-readiness. Variants do not own a
base URL, method, path, query, request header, or mode.

### Response Variant Provenance

Response behavior remains status, response headers, Body Asset, delay, name,
description, and revision. A Variant created by `Mock This` may additionally
carry immutable creation provenance:

```ts
interface TrafficVariantProvenance {
  type: 'traffic';
  trafficId: string;
  trafficGeneration: string;
  capturedAt: string;
  requestOrigin: string;
  responseIdentity: string;
  endpointTarget: 'create' | 'reuse';
  endpointId: string;
  endpointCreated: boolean;
  variantId: string;
  variantCreated: boolean;
  endpointModeChanged: boolean;
  stateTarget: 'unbound' | 'bound';
  stateId?: string;
  bindingChanged: boolean;
}
```

`ResponseVariant.trafficProvenance` is an optional append-only array of these
records. Manually authored and imported Variants begin without records. Editing
a Variant's response does not rewrite existing provenance. Promotion appends at
most one record for a Traffic ID, Traffic generation, response identity,
Endpoint target identity, and State target identity, explicitly excluding
expected revisions, whether it creates or reuses the normalized Variant.
Existing records are never overwritten. Editable description is never used for
idempotency. The record is an immutable promotion receipt containing the
complete public result and reviewed target identities, so a retry is
reconstructable if pointer publication succeeded before the ephemeral Traffic
result was updated.

### Body Asset

Schema version 4 keeps one canonical encoding field name:

```ts
interface BodyAsset {
  schemaVersion: 4;
  id: string;
  mediaType: string;
  size: number;
  encoding?: string;
  createdAt: string;
}
```

`id` remains the SHA-256 byte identity. `mediaType` normalization trims optional
whitespace, requires a valid token/token type and subtype, lowercases type,
subtype, and parameter names, rejects duplicate parameter names, code-unit-sorts
parameters by name, trims parameter whitespace, and preserves case-sensitive
parameter values with canonical quoting/escaping. Missing or malformed captured
Content-Type becomes `application/octet-stream` with a promotion warning.

`encoding` is the ordered Content-Encoding coding list rendered as lowercase
tokens joined by `, `. Optional whitespace is removed, ordering and duplicates
are preserved, and `identity` tokens are removed; an empty result is absent.
Invalid coding syntax blocks promotion with `TRAFFIC_PROMOTION_INVALID` because
MockMate cannot reproduce the captured entity safely. Canonical Variant response
headers discard `Content-Length`, `Transfer-Encoding`, and `Content-Encoding`.
Mock delivery derives length and encoding solely from Body Asset metadata;
Variant `Content-Type` retains existing precedence, with Body Asset media type as
fallback.

### Runtime Settings

The Project runtime settings become:

```ts
interface ProjectRuntimeSettings {
  schemaVersion: 4;
  projectId: string;
  interceptHosts: string[];
  captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean;
  revision: number;
}
```

`passthroughEnabled` is removed. For an explicitly intercepted request,
passthrough is always available and always targets the incoming original
origin. Endpoint mode decides whether a matching Endpoint mocks or passes
through.

### Strict Mutation Contracts

All schema-v4 mutation payloads are strict and reject unknown keys.

```ts
type EndpointCreateInput = {
  name: string;
  description?: string;
  baseUrl: string;
  matcher: EndpointMatcherInput;
  mode: 'mock' | 'passthrough';
  variants?: ResponseVariantCreateInput[];
  defaultVariantIndex?: number;
};

type EndpointModeInput = {
  mode: 'mock' | 'passthrough';
  expectedRevision: number;
};

type AppStateModeInput = {
  appStateMode: 'enabled' | 'disabled';
  expectedProjectRevision: number;
};

type RuntimeSettingsUpdateInput = {
  interceptHosts: string[];
  captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean;
  expectedRevision: number;
  confirmInterceptAll?: true;
};
```

Endpoint creation returns `201`; full revisioned update and mode update return
`200`. Mock creation/update requires at least one Variant and a valid fallback.
Passthrough creation may omit Variants and fallback. Deleting the last Variant
from a passthrough Endpoint clears `defaultVariantId` only when no App State
binding references it. Any referenced Variant deletion returns the existing
`409 VARIANT_IN_USE` contract and does not remove dormant bindings implicitly.
Deleting the last Variant from a mock Endpoint returns
`409 ENDPOINT_FALLBACK_REQUIRED`. Deleting the current fallback while other
Variants remain requires a replacement fallback in the same revisioned command.
Switching a non-ready passthrough Endpoint to mock returns the same code. A
canonical matcher duplicate returns
`409 ENDPOINT_IDENTITY_CONFLICT`. Revision mismatches retain the existing
revision-conflict contract and canonical current entity.

Project App State mode update returns `200`, increments Project revision, and
does not clear active/base IDs or bindings. Mode and Endpoint changes publish
through one normal repository generation. Direct passthrough has no mutation
contract and returns the runtime errors defined above.

`confirmInterceptAll` is transient and never persisted. The server requires it
on every settings mutation whose normalized result contains the exact catch-all
pattern `*`; dashboard confirmation alone is insufficient. Missing confirmation
returns `422 INTERCEPT_ALL_CONFIRMATION_REQUIRED` before settings mutation.

## Interception Allowlist

`interceptHosts` remains a hostname-pattern allowlist. It does not contain
schemes, ports, paths, query strings, or fragments. One pattern applies across
HTTP, HTTPS, and ports because the actual request origin remains part of
Endpoint matching and Traffic provenance.

Patterns are normalized with the same hostname rules as Endpoint origins.
`*` is the only wildcard metacharacter and matches zero or more hostname code
units, including dots. `*.example.com` matches `api.example.com` and
`a.b.example.com`, but not the apex `example.com`; `api.*` matches
`api.example.com`; and `*` matches every non-local valid hostname. Exact and
wildcard patterns are supported. Validation rejects malformed patterns, empty
labels, local MockMate/control hosts, duplicates after normalization, and
schemes/paths/ports. A catch-all `*` requires explicit confirmation because it
causes MockMate to inspect every proxy host.

For HTTPS, unselected hosts remain blind tunnels and cannot be recorded. For
plain HTTP, unselected hosts forward directly and are not recorded. Selected
HTTP and HTTPS requests use the same resolution, passthrough, provenance, and
capture pipeline.

## Runtime Request Decision

Proxy mode is the primary multi-backend connection model. The application keeps
calling real backend URLs through the configured MockMate proxy, so each request
provides its original scheme, hostname, port, path, query, and headers.

Original-origin authority is transport-defined and never inferred from an
Endpoint:

- for HTTPS MITM, the CONNECT authority is authoritative; the inner request
  authority must normalize to the same hostname and effective port or the proxy
  rejects it as a recorded bad-request outcome;
- for plain HTTP absolute-form requests, the absolute request-target authority
  is authoritative and any `Host` header must agree after normalization;
- for plain HTTP origin-form requests, a single valid `Host` header supplies
  hostname and port and the listener scheme supplies HTTP;
- missing, duplicate, malformed, credential-bearing, or disagreeing authorities
  are never forwarded.

Normalized authority is used for matching and provenance. Passthrough preserves
the original valid request target and does not rewrite it from normalized
display data.

For every allowlisted request:

1. normalize the actual origin, method, path, query, and request headers;
2. record the request context and begin bounded preview/body observation;
3. select the most-specific matching Endpoint using origin plus the complete
   request matcher;
4. if no Endpoint matches, forward to the incoming original origin;
5. if a passthrough Endpoint matches, forward to the incoming original origin;
6. if a mock Endpoint matches and App State mode is enabled, resolve active
   State binding, then base State binding, then Endpoint fallback;
7. if a mock Endpoint matches and App State mode is disabled, skip both State
   lookups and resolve the Endpoint fallback;
8. deliver the mock or upstream response while finalizing one Traffic outcome.

A more-specific passthrough Endpoint wins over a broader mock Endpoint because
mode is evaluated after selecting the canonical matcher. Exact duplicate
matchers are prohibited, avoiding equal-identity mode ambiguity.

Passthrough always preserves the incoming original scheme, hostname, effective
port, path, query, method, request headers, and request body subject to standard
proxy hop-by-hop handling. It does not use an Endpoint's stored base URL as a
remote rewrite target. The stored base URL participates in canonical matching
and direct authoring identity; the intercepted origin is authoritative for
transparent passthrough.

Direct requests addressed to MockMate derive their candidate origin only from
the trusted incoming listener scheme plus one validated `Host` authority. No
reserved client header may override it. This permits mock-only direct use when a
caller intentionally sends the backend Host authority to the MockMate listener;
ordinary `localhost` requests do not masquerade as another origin. A missing or
malformed authority returns `400 DIRECT_ORIGIN_INVALID`. An unmatched or matched
passthrough Endpoint returns `404 ENDPOINT_NOT_FOUND`, records a direct-miss or
direct-passthrough-unavailable Traffic outcome, and performs no upstream I/O.
Direct requests never consult a Project base URL and never guess among multiple
backend origins.

Direct backend traffic must match the interception allowlist just like proxy
traffic. A non-allowlisted direct authority returns `404 ENDPOINT_NOT_FOUND` and
is not recorded because it was not selected for inspection. The Traffic
allowlist pattern is therefore required for every retained proxy or direct row.
Dispatch is authority-aware before path-aware: local MockMate control
authorities receive admin, setup, health, static, and dashboard routes;
allowlisted non-local authorities enter direct mock resolution even when their
backend path is `/health` or begins `/api/admin`. A non-local authority can never
reach MockMate control routes.

## Unified Traffic Outcome And Provenance

One request-outcome builder replaces ad hoc traffic logging in direct mock,
plain HTTP proxy, HTTPS MITM, and upstream forwarding paths. A Traffic detail
contains:

- Project and Traffic IDs;
- server request ID;
- start time, completion time, and duration;
- transport: direct, plain HTTP proxy, or HTTPS MITM;
- matched allowlist pattern;
- actual normalized origin including non-default port;
- method, path, query summary, and redacted request-header summary;
- Endpoint match ID, name, specificity, and mode when matched;
- routing decision: mock, endpoint passthrough, no-match passthrough, direct
  miss, or failure;
- App State mode;
- active/base/selected State IDs when applicable;
- resolution source and fallback reasons;
- Variant and Body Asset IDs for a mock result;
- upstream status or sanitized transport failure for passthrough;
- final response status, repeated response headers, and byte count;
- request and response preview/body descriptors;
- capture and promotion state.

Summaries omit large headers, query values, previews, and bodies. Detail payloads
remain bounded and redact credential values. Values of `Authorization`,
`Proxy-Authorization`, `Cookie`, and `Set-Cookie` headers, values associated
with password/token-like query names, and URL user information never render
unmasked. Filesystem paths never cross the Traffic API.

Passthrough and mock responses use the same provenance vocabulary. The Traffic
UI can therefore explain whether a response came from an active binding, base
binding, Endpoint fallback, explicit passthrough Endpoint, or no Endpoint
match. Passthrough records selected App State context as context only; it never
claims a Variant resolution.

### Optional Debug Headers

When `debugProvenanceHeaders` is enabled, mock responses may include
non-sensitive MockMate headers for Project, Endpoint, Variant, selected State,
resolution source, fallback reason, and request ID. These headers are off by
default, are excluded from canonical Variant response headers, and are never
added to passthrough responses. User values cannot overwrite reserved debug
header names.

## Traffic Retention

Traffic is ephemeral and Project-scoped.

- Retain the newest 500 Traffic rows per Project.
- Metadata row eviction releases the row's body-cache references.
- Clearing one Project's Traffic removes its rows and releases its references
  without affecting other Projects or promoted Body Assets.
- Process startup removes prior Traffic cache state through containment-checked
  cleanup; Traffic rows do not survive restart.
- Summary polling remains cursor/incremental and Project-owned.
- Lazy detail requests remain Project- and Traffic-ID-scoped.

Retention is a service owned by the runtime, not a module-level global array.
Tests may inject smaller limits and deterministic IDs/clocks.

## Exact Traffic Body Capture

### Body Descriptor

Each Traffic detail has independent request and response descriptors:

```ts
type TrafficBodyUnavailableReason =
  | 'raw_capture_disabled'
  | 'sidecar_limit'
  | 'queue_saturated'
  | 'temporary_budget_exceeded'
  | 'retained_budget_exceeded'
  | 'capture_io_failed'
  | 'stream_cancelled'
  | 'body_unobservable';

type TrafficBodyDescriptor =
  | {
      side: 'request' | 'response';
      state: 'available';
      mediaType?: string;
      contentEncoding?: string;
      observedSize: number;
      retainedSize: number;
      sha256: string;
    }
  | {
      side: 'request' | 'response';
      state: 'truncated';
      mediaType?: string;
      contentEncoding?: string;
      observedSize: number;
      reason: 'body_limit_exceeded';
    }
  | {
      side: 'request' | 'response';
      state: 'evicted';
      mediaType?: string;
      contentEncoding?: string;
      observedSize: number;
      retainedSize: number;
      sha256: string;
      reason: 'retention_evicted';
    }
  | {
      side: 'request' | 'response';
      state: 'unavailable';
      mediaType?: string;
      contentEncoding?: string;
      observedSize: number;
      reason: TrafficBodyUnavailableReason;
    };
```

`available` means the descriptor represents exact complete bytes and always has
the exact digest and size. A verified zero-byte or protocol-bodyless response is
available and promotable without a file, with `retainedSize: 0` and SHA-256 of
the empty byte sequence. `truncated` means the source exceeded the exact 50 MiB
inclusive limit.
`evicted` means complete bytes were retained and later released. `unavailable`
means raw capture was disabled, the sidecar queue saturated, a write failed, or
the source could not be observed safely.

Every size is a non-negative JavaScript safe integer. Every digest is exactly 64
lowercase hexadecimal SHA-256 characters. `available` and `evicted` require
`observedSize === retainedSize`; other union members cannot carry retained size
or digest fields.

The existing bounded 16 KiB UTF-8 or base64 preview remains in Traffic detail
and is independent of descriptor state. A truncated prefix is never represented
as a complete body.

### Non-Blocking Sidecar

Application delivery and capture are independent:

- request and response bytes continue toward their destination without waiting
  for Traffic cache storage;
- preview and observed-size accounting remain bounded and continue even when
  exact capture is abandoned;
- exact capture uses at most a 1 MiB in-memory queue per active sidecar;
- queue saturation, one byte beyond 50 MiB, disk failure, cancellation, or
  containment failure abandons exact capture, removes operation-owned temporary
  files, and records a sanitized unavailable/truncated reason;
- capture failure never changes mock response delivery, origin passthrough,
  upstream errors, or connection teardown;
- request and response capture work for streaming and unknown-length bodies;
- implementations do not trust `Content-Length` as proof of completeness.

Admission is also bounded across concurrent requests. Defaults are fixed and
injectable only for tests:

- at most 32 active sidecars and 32 MiB of queued sidecar bytes per Project;
- at most 128 active sidecars and 128 MiB of queued sidecar bytes per process;
- at most 1 GiB of operation-owned in-progress capture files per Project;
- at most 2 GiB of operation-owned in-progress capture files per process.

Admission reserves sidecar, queue, and prospective temporary-byte capacity
before capture ownership is granted. Streaming byte reservations grow without
blocking application delivery. Exhausting any aggregate limit abandons exact
capture for that side only, releases every reservation exactly once, and records
an unavailable descriptor. Retained-cache bytes and in-progress bytes are
accounted separately, so incomplete files cannot evade the 1 GiB retained
budget or grow without a process bound.

Upstream proxy forwarding moves from whole-body buffering to streaming with
bounded previews and sidecars. Existing repeated-header, hop-by-hop-header,
backpressure, abort, and primary-error guarantees remain regression gates.

### Project Traffic Body Cache

Add a Project-scoped ephemeral `TrafficBodyCache` under the configured MockMate
data root.

- Maximum complete body: 50 MiB inclusive.
- Maximum retained exact body bytes: 1 GiB per Project.
- Maximum retained exact body bytes: 4 GiB per process.
- Storage is content-addressed and deduplicated by SHA-256 within the Project.
- A file publishes only after complete byte observation, size validation,
  digest calculation, file sync, directory sync where required, and atomic
  create-if-absent promotion.
- Reference counts follow live Traffic body descriptors.
- Active stream, Download, and `Mock This` operations hold leases.
- Oldest unleased Traffic-body references are evicted first when the Project
  budget is exceeded.
- Eviction changes affected descriptors to `evicted` while retaining metadata
  and previews.
- If every candidate is leased, the new body becomes unavailable rather than
  blocking application traffic.
- Cache startup and cleanup reject symlinks, special files, malformed names,
  replaced ancestors, and escaped paths; they never follow untrusted links.

Project and process retained budgets count physical unique content-addressed
bytes, not the number of descriptors referencing them. A Project first evicts
its own oldest unleased references to satisfy its 1 GiB budget. The process does
not evict another Project's retained evidence; when the 4 GiB process budget is
still exhausted, new exact capture becomes unavailable with
`retained_budget_exceeded`. Leases and eviction are digest owned. A capture
operation holds provisional ownership until finalization. Each Traffic row has
an immutable lifetime generation; clear or row eviction tombstones that
generation and releases attached references. Finalization may attach a digest
only when the same row generation is still live. Otherwise it releases
provisional ownership without resurrecting the row. Clear, eviction, streaming,
and promotion serialize reference transitions through the cache, making
attach/release idempotent and exact-once. Process-budget accounting is injected
for deterministic reduced-limit tests and shared by every Project cache.

When `captureRawTraffic` is false, request and response descriptors are always
`unavailable`, including known mock Body Assets and verified zero-byte bodies;
metadata and previews are still recorded. When it is true, mock responses whose
immutable Body Asset identity and bytes are already known may reuse the Body
Store as the exact stream source behind the same Traffic-body API. That
optimization must preserve Project ownership, descriptor semantics, and clear
behavior without duplicating permanent bytes. A verified bodyless or zero-byte
response is `available` only when raw capture was enabled for that request.

Retained exact bytes are HTTP entity bytes after transfer framing is removed but
before `Content-Encoding` decoding. Their SHA-256 and size always describe that
encoded representation. A content-encoded body is binary/download-only in Slice
3 and does not enter CodeMirror. Exact body responses omit `Content-Encoding`
so browsers cannot transparently transform bytes; they expose the captured
encoding in `X-MockMate-Original-Content-Encoding`, set exact
`Content-Length`, and use attachment disposition for Download. Promotion stores
the same encoded bytes and authoritative encoding metadata, allowing mock
delivery to restore the original Content-Encoding without changing the digest.
This byte-preserving body-route rule explicitly supersedes the optional
`Content-Encoding` response-header rule in the earlier Large-Body direction.

## Traffic APIs

The old `/logs` naming is removed in the direct cutover. Canonical routes are:

```text
GET    /api/admin/projects/:projectId/traffic
GET    /api/admin/projects/:projectId/traffic/:trafficId
DELETE /api/admin/projects/:projectId/traffic
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/request
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/response
POST   /api/admin/projects/:projectId/traffic/:trafficId/mock
GET    /api/admin/projects/:projectId/interception-guidance
```

List responses are bounded summaries. Detail contains bounded previews,
redacted request evidence, full provenance, and descriptors. Body routes stream
only an `available` body, enforce Project/Traffic/side ownership, use the
authoritative media type without a transform-triggering `Content-Encoding`,
provide exact retained length and digest metadata, support cancellation, hold
one lease, and include request IDs. A download query uses attachment disposition
over the same exact stream rather than a second API.

Promotion input and result are strict and replayable:

```ts
type TrafficPromotionInput = {
  expectedTrafficGeneration: string;
  expectedResponseIdentity: string;
  endpoint:
    | { action: 'create' }
    | { action: 'reuse'; endpointId: string; expectedRevision: number };
  state:
    | { action: 'unbound' }
    | { action: 'bind'; stateId: string; expectedRevision: number };
};

type TrafficPromotionResult = {
  endpointId: string;
  endpointCreated: boolean;
  variantId: string;
  variantCreated: boolean;
  endpointModeChanged: boolean;
  stateId?: string;
  bindingChanged: boolean;
};
```

Traffic detail supplies the exact current `create` or `reuse` review target.
Promotion returns `200` for both first success and idempotent replay. Same
Traffic ID, Traffic generation, response identity, Endpoint target, and State
target reconstruct the canonical result from append-only Variant Traffic
provenance if canonical publication already occurred. A different generation,
response, or target for an already promoted Traffic ID returns
`409 TRAFFIC_PROMOTION_CONFLICT`.

Receipt target identity contains Endpoint action plus Endpoint ID when reusing,
and State action plus State ID when binding. `expectedRevision` values are
pre-publication concurrency guards, not receipt-key fields; they are not
revalidated after an exact receipt match. Thus the original command can replay
after its own successful publication changed those revisions.

Replay checks canonical promotion receipts in the requested Project before
requiring a live Traffic row. A matching receipt returns `200` even when the row
was cleared or evicted after publication. Without a matching receipt, missing or
cross-Project Traffic remains indistinguishable `404`; a live row with changed
generation, response identity, or reviewed target is stale. A `create` command
replay is compared to its original create receipt, not reinterpreted as a new
`reuse` command merely because the created Endpoint now exists.

Representative body errors:

- missing or cross-Project Traffic/side: indistinguishable `404`;
- unavailable exact body: `409 TRAFFIC_BODY_UNAVAILABLE`;
- truncated exact body: `409 TRAFFIC_BODY_TRUNCATED`;
- evicted body: `410 TRAFFIC_BODY_EVICTED`;
- changed Traffic generation/identity or changed reviewed target:
  `409 TRAFFIC_PROMOTION_STALE`;
- conflicting replay after prior promotion: `409 TRAFFIC_PROMOTION_CONFLICT`;
- stale App State or Endpoint revision: sanitized canonical `409` revision
  conflict containing entity ID and current revision only, never current matcher
  values;
- equal bytes with conflicting immutable Body Asset metadata:
  `409 ASSET_METADATA_CONFLICT`;
- malformed promotion choice: `422 TRAFFIC_PROMOTION_INVALID`;
- unexpected internal failure: sanitized `500` with request ID.

The dashboard client returns raw `Response`/stream ownership for body routes and
does not materialize large bodies in the generic JSON client.

## Shared Dashboard Document Cache

Add a shared `BodyDocumentCache` for editable mock text and read-only Traffic
text.

Document identities are immutable:

- mock: Project, Endpoint, Variant, Variant revision, and Body Asset identity;
- Traffic: Project, Traffic ID, side, and captured SHA-256.

The cache:

- deduplicates concurrent loads for one identity;
- permits at most two concurrent full-body loads;
- prioritizes the active selection;
- cancels the oldest inactive load when a third distinct load begins;
- retains at most 12 clean documents or 256 MiB, whichever limit is reached
  first;
- evicts clean least-recently-used documents;
- never evicts the active document or dirty mock drafts;
- preserves editor selection, scroll, undo, validation generation, and pending
  Body Asset ownership;
- rejects stale success, error, progress, and finalization by Project, document
  identity, request generation, and owning component lifetime.

An uncached Traffic text body displays its preview immediately while exact bytes
load in the body pane. The Traffic list, inspector tabs, settings, and unrelated
dashboard actions remain interactive. Reopening a cached body does not issue a
new network request or show a full-panel loader.

## CodeMirror Document Surface

Replace the controlled native body textarea with a project-owned React adapter
around CodeMirror 6 `EditorState`, immutable `Text`, and `EditorView`.

- The same surface supports editable mock documents and read-only Traffic text.
- React owns identity, metadata, progress, and errors, not a controlled full
  string on every keystroke.
- CodeMirror renders only the viewport and preserves accessible labels,
  selection, clipboard, focus, keyboard editing, search, and undo.
- Large-body mode begins above 1 MiB, disables wrapping and expensive syntax
  parsing, and explains that choice in the UI.
- Search spans the complete immutable document, not only rendered lines.
- Full-string materialization occurs only at Worker validation, Worker format,
  Body Asset upload, explicit copy/export, and test boundaries.
- Worker results remain document-generation-owned.
- Binary Traffic never enters text decoding or CodeMirror; it uses bounded
  base64/hex preview and exact Download.

The current Body Editor layout, labels, notices, save/format controls, dirty
ownership, revision-conflict recovery, and responsive Traffic inspector layout
remain visually consistent.

## State-Aware Mock This

`Mock This` is a reviewed command, not an immediate button mutation.

### Promotion Review

The dialog displays:

- captured origin, method, normalized path, and complete query fields;
- captured request headers as redacted evidence only;
- exact response status, normalized response headers, media type, encoding,
  body size, and digest;
- body promotability and recovery when blocked;
- create versus exact-existing Endpoint result;
- add versus normalized-existing Variant result;
- target Endpoint mode after promotion;
- App State target: current active State by default when available, another
  existing State, or create unbound;
- dependency and revision warnings.

Captured query parameters become `equals` Endpoint constraints by default.
Captured request headers do not become constraints automatically because they
frequently contain dynamic or credential-bearing values. Users can edit the
Endpoint later to add explicit header constraints.

Values associated with token/password-like query names remain masked in Traffic
and promotion/import review, but confirming the command persists their exact
values because the approved Endpoint identity includes every enabled query
entry. The review lists
the affected names and warns that their hidden values will become local
canonical matcher configuration. Canonical Endpoint admin APIs and the Endpoint
editor are trusted loopback configuration surfaces and return those matcher
values unmasked so ordinary revisioned read/edit/write round trips do not replace
them with mask text. Traffic APIs, Traffic UI, errors, diagnostics, and preview
payloads remain redacted. This deliberate configuration visibility is covered by
the same loopback and dashboard-origin protections as manually authored secret
header/query constraints.

The same default amends cURL/Postman import: imported canonical identity includes
normalized origin, method, path, and every enabled query entry. Request headers
remain redacted preview evidence and are not persisted automatically.

### Canonical Target Rules

- Reuse only an exact canonical Endpoint identity.
- Otherwise create one Endpoint with captured origin, method, path, and query
  constraints.
- A newly created Endpoint begins in mock mode.
- Promoting into a passthrough Endpoint sets it to mock mode after a valid
  response Variant exists; dormant prior Variants and bindings remain.
- Normalize saved response headers with the existing transport-managed discard
  set and preserve repeated end-to-end fields such as `Set-Cookie`.
- Compute response identity from status, normalized repeated headers, delay,
  and exact body identity.
- Reuse the deterministic first existing Variant with equal normalized response
  identity; otherwise append a new Variant with a deterministic name.
- Preserve an existing Endpoint fallback. The first Variant is fallback only
  when creating a new Endpoint.
- App State binding is explicit. Promotion may bind even while App State mode is
  disabled; the binding remains dormant until mode is enabled.

Captured Variants use delay `0`. Exact body identity is SHA-256, byte count,
normalized media type, and normalized optional Body Asset `encoding`. Body Assets
remain addressed by byte SHA-256; equal bytes with different immutable media
type or encoding metadata return canonical `409 ASSET_METADATA_CONFLICT` rather
than silently changing or duplicating metadata.

Sensitive response-header names, including `Set-Cookie`, render with masked
values in Traffic and promotion review but are persisted exactly when the user
confirms `Mock This`, because they are response behavior. The dialog displays an
explicit warning listing masked header names that will be stored. Request
credential headers remain evidence-only and are never persisted automatically.

### Promotion Transaction

The Body Import Transaction gains a streaming staging operation:

```ts
stageStream(
  source: NodeJS.ReadableStream,
  expected: { sha256: string; byteCount: number },
  metadata: { mediaType: string; encoding?: string },
): Promise<BodyAsset>;
```

It hashes and counts while writing, rejects mismatch before publication, reuses
an exact pre-existing immutable asset, and participates in the same guarded
promotion/rollback lifecycle as buffered staging. It never materializes a 50 MiB
Traffic body as one `Buffer` and never calls ordinary `BodyStore.put()` outside
the candidate generation transaction.

Promotion uses one exact ordering:

1. check the requested Project's canonical receipts for an exact key containing
   Traffic ID, Traffic generation, response identity, Endpoint target identity,
   and State target identity, explicitly excluding expected revisions; return
   its result on an exact match;
2. return `TRAFFIC_PROMOTION_CONFLICT` when the Traffic ID already has a
   non-matching canonical receipt;
3. atomically acquire a live internal Traffic snapshot for the expected row
   generation plus its exact response digest lease; missing/cross-Project is
   `404`, and a changed live generation/identity is stale;
4. enter one Project mutation queue entry with that accepted immutable snapshot
   and lease;
5. recheck exact/conflicting canonical receipts to close the concurrent-replay
   race, releasing the lease if another command already published;
6. re-read Project canonical state and validate the reviewed Endpoint and App
   State revisions without looking up or reacquiring the now-tombstoneable
   Traffic row;
7. recompute request and response identities from the accepted snapshot;
8. stream-stage exact leased bytes into the immutable Body Store;
9. clone one canonical Project snapshot;
10. create/reuse Endpoint and Variant, set mode, append the full immutable
    receipt, and apply the optional binding;
11. validate referential integrity and compile the candidate;
12. write and rename one generation;
13. promote operation-owned Body Assets;
14. publish the generation pointer and memory once;
15. attach the promotion result only if the same Traffic generation remains
    live;
16. release the lease and complete cleanup.

Clear or row eviction after step 3 may tombstone and hide the row but cannot
release leased bytes or cancel the accepted promotion. A command waiting in the
repository queue uses its immutable accepted snapshot. After canonical
publication, a cleared row or lost HTTP response is harmless because the
generation-keyed Variant receipt reconstructs the same `200` result. A
mismatched receipt takes conflict precedence even if the ephemeral row was
cleared. Every lease and provisional reference is released exactly once on
success, stale rejection, replay, or failure.

Any pre-pointer failure publishes no Endpoint, Variant, binding, mode, pointer,
or operation-owned Body Asset. Cleanup errors never replace the initiating
error. After pointer publication, client response loss is an unknown outcome;
the dashboard refreshes canonical Endpoint, App State, and selected detail data
before presenting recovery.

Promotion is idempotent for one Traffic ID, Traffic generation, response
identity, Endpoint target identity, and State target identity, excluding
expected revisions. A conflicting replay returns the explicit conflict above. It
never depends on description text. A promoted immutable Body Asset and its
append-only Variant provenance survive Traffic clear, cache eviction, and
restart.

## Interception Guidance

The guidance endpoint derives normalized suggestions from:

- canonical Endpoint base URLs;
- origins in the current Import Preview retained by the wizard;
- currently configured interception patterns.

It reports which exact hostnames are already covered by an exact or wildcard
pattern, which are missing, and which configured patterns cover no canonical
Endpoint. Suggestions are read-only.

The dashboard presents a reviewed checklist. Users choose additions, review
normalized results, and save once against the current runtime-settings revision.
No Endpoint creation, import, Traffic observation, or `Mock This` action changes
the allowlist automatically. Wildcard suggestions are never invented; users may
enter wildcard patterns manually with validation and catch-all confirmation.

Project settings independently expose:

- interception hostname patterns;
- exact raw body capture;
- optional mock provenance headers.

Project creation no longer asks for a base URL. Endpoint creation and editing
require the Endpoint base URL. Variant forms contain response fields only.

## Dashboard Traffic Workspace

The existing restrained gray/blue dashboard language remains. Traffic stays a
supporting evidence workspace rather than the primary Project organization.

The Traffic screen keeps:

- incremental list, pause, refresh, clear, and selected-row ownership;
- request and response tabs;
- immediate bounded previews;
- repeated response headers;
- responsive table/card behavior.

It adds:

- actual origin and matched allowlist pattern;
- mock/passthrough/failure outcome;
- Endpoint mode and matcher result;
- App State mode, selected State, resolution source, and fallback reason;
- independent request/response descriptor states;
- background full-body progress without blocking the list;
- text search/read-only CodeMirror viewing;
- binary exact Download;
- reviewed `Mock This` with disabled/recovery states;
- promotion success showing created/reused Endpoint/Variant and optional binding;
- owner-safe canonical refresh and navigation.

Secrets never render unmasked in list, detail, body metadata, promotion review,
errors, or provenance headers.

## Import Preview Amendments

Schema version 4 supersedes two Slice 2 decisions.

### Origin Identity

Imported canonical identity changes from hostname-only to normalized HTTP/HTTPS
origin. Scheme and explicit non-default port are no longer discarded. Requests
that differ by scheme or non-default port produce distinct prospective
Endpoints. Explicit default ports normalize away.

### Query Constraints

Every enabled cURL/Postman query entry becomes an exact canonical query
constraint. Disabled Postman query entries remain absent. Structured Postman
query metadata remains authoritative over raw query text. Repeated same-name
entries become a code-unit-canonicalized expression multiset, preserving each
value and duplicate count. Preview displays every source occurrence while item
identity and stale replay use the canonical multiset.

Request headers, auth, cookies, request bodies, and scripts remain redacted
preview-only evidence and are not automatically persisted as header constraints.
Users may add manual request-header constraints after import.

Import preview and digest scopes include origin and query constraints. Conflict,
overlap, specificity, item ID, target response candidates, stale replay, and
acceptance tests are updated accordingly. Imported Endpoints remain unbound and
do not change interception settings. The wizard carries discovered origins into
the reviewed interception checklist after successful canonical refresh.

## Error Handling

- Capture failure never changes the application request or response outcome.
- HTTP and HTTPS selected-host passthrough use one behavior and error vocabulary.
- malformed or duplicate proxy authority returns `400 PROXY_AUTHORITY_INVALID`;
  CONNECT/inner-authority disagreement returns
  `400 PROXY_CONNECT_AUTHORITY_MISMATCH`; absolute-form/Host disagreement returns
  `400 PROXY_HOST_AUTHORITY_MISMATCH`. None are forwarded.
- Upstream failures retain the proxy's canonical response behavior and create a
  sanitized Traffic failure outcome.
- Traffic-body loading failure preserves the preview and offers Retry or exact
  Download when available.
- `truncated`, `evicted`, and `unavailable` remain distinct user-visible states.
- Body stream cancellation closes handles and releases leases exactly once.
- Promotion rejects preview-only or stale body descriptors before Body Store or
  repository mutation.
- App State/Endpoint revision conflict preserves promotion choices. Promotion
  errors return only sanitized IDs/revisions; the dashboard refreshes full
  canonical targets through the trusted Endpoint and App State configuration
  APIs without repeating a potentially published commit.
- Endpoint mode toggles are revisioned; stale toggles preserve the user's draft.
- Switching Project invalidates Traffic polling, body loads, promotion callbacks,
  and settings guidance synchronously at the layout-commit boundary.
- All structured API errors include request IDs and actionable recovery without
  paths, credentials, raw bodies, stack traces, or upstream secrets.

## Security And Privacy

- Admin APIs remain loopback-only by default.
- Only explicitly allowlisted proxy or direct backend authorities are inspectable.
- Blind-tunneled HTTPS is neither inspected nor represented as captured Traffic.
- Credential request headers and values associated with sensitive query names are redacted before
  Traffic API serialization, previews, diagnostics, and logs. The trusted
  loopback Endpoint configuration API exception is defined above.
- Captured request headers never become Endpoint constraints automatically.
- Traffic body files are addressed only through Project/Traffic/side API ownership.
- Cache and Body Store roots use containment, ancestor identity, symlink, special
  file, atomic publication, and cleanup guards.
- Debug provenance headers contain IDs/reasons only, are off by default, and are
  never added to passthrough.
- Raw body capture is explicit and off by default for a new Project.
- Traffic and its exact cache remain ephemeral; permanent retention requires
  successful `Mock This` promotion into the immutable Body Store.

## Testing Strategy

### Domain And Matcher Tests

- schema-v4 strict validation and complete schema-v3 absence;
- required origin-only Endpoint base URL normalization;
- HTTP/HTTPS/default/non-default port identity;
- repeated same-name query multisets and header constraints as Endpoint identity;
- query name case, plus/percent decoding, malformed encoding, and no Unicode
  normalization;
- empty query/segments/names/values, first-`=` parsing, encoded separators, raw
  non-ASCII rejection, and injective glob/equals multiset assignment;
- empty expression-array rejection and empty query/header object normalization
  to absence;
- duplicate identity rejection and overlap specificity;
- broader-mock/specific-passthrough, broader-passthrough/specific-mock, and
  equal-specificity stable-ID selection;
- mock/passthrough mode invariants and reversible dormant Variants;
- App State mode off skips active and base bindings;
- no Variant contains request matching fields.

### Runtime And Provenance Tests

- exact and wildcard allowlist selection;
- strict runtime-settings mutation and server-enforced catch-all confirmation;
- unselected HTTPS blind tunnel and unselected HTTP direct forward;
- selected HTTP/HTTPS mock precedence and original-origin passthrough parity;
- no Endpoint and passthrough Endpoint outcomes;
- direct matched-mock, matched-passthrough-unavailable, missing authority, and
  unmatched outcomes with Traffic recording;
- authority-based control/backend route dispatch and non-allowlisted direct
  rejection;
- CONNECT/inner-authority and absolute-form/Host agreement rejection;
- active, base, fallback, and State-disabled mock resolution;
- repeated request/response headers and streamed bodies;
- upstream failure provenance;
- optional mock-only debug headers and reserved-header ownership;
- direct unmatched requests never guess an origin.

### Traffic Cache Tests

- exact bytes and verified zero bytes;
- strict legal descriptor shapes and sanitized unavailable reasons;
- 50 MiB inclusive and one-byte-over truncation;
- 16 KiB UTF-8/base64 preview independence;
- 1 MiB queue saturation without transport backpressure;
- Project/process active-sidecar, aggregate-queue, and temporary-byte admission;
- unknown-length request and response streams;
- SHA-256 deduplication and reference counting;
- 500-row Project retention and cross-Project isolation;
- 1 GiB Project budget with injectable reduced limits;
- 4 GiB process retained-budget admission without cross-Project eviction;
- oldest-unleased eviction and all-leased unavailability;
- stream/download/promotion leases and cancellation;
- raw-capture-off metadata/preview with unavailable mock, passthrough, bodyless,
  and zero-byte descriptors;
- clear or row eviction while capture finalizes or promotion holds a lease;
- encoded retained-byte digest, exact Download, and promoted delivery parity;
- clear and startup cleanup;
- symlink, special-file, replaced-ancestor, and path containment failures;
- temporary-file cleanup and primary-error preservation.

### Repository Promotion Tests

- exact request identity with repeated query-only captured constraints;
- exact response identity and repeated-header normalization;
- create versus exact Endpoint reuse;
- passthrough-to-mock toggle with dormant data preserved;
- referenced last-Variant deletion rejection for passthrough Endpoints;
- Variant reuse versus append and fallback preservation;
- append-only first-class Traffic provenance on new and reused Variants;
- explicit active/other/unbound State target;
- State binding while App State mode is disabled;
- Traffic-ID/generation/response/Endpoint/State-target idempotence and
  conflicting replay;
- replay after pointer publication but before Traffic-result attachment;
- immutable full-result receipt reconstruction after Traffic clear;
- exact/conflicting receipt precedence after clear and clear-before-dequeue;
- streaming stage metadata conflict and encoded-delivery identity;
- stale Traffic/Endpoint/State and non-promotable-body rejection;
- validation, staging, compile, generation write/rename, body promotion, pointer,
  and cleanup failure atomicity;
- promoted Body Asset survival after Traffic clear/restart.

### Route And API Tests

- canonical `/traffic` routes and old `/logs` route removal;
- strict bounded list/detail/promotion schemas;
- sensitive query redaction in Traffic/review plus exact canonical Endpoint API
  round-trip without mask corruption;
- Project/Traffic/side cross-ownership rejection;
- stream headers, cancellation, Download disposition, and request IDs;
- exact error codes for unavailable/truncated/evicted/stale states;
- media-type/ordered-encoding normalization equivalence, invalid encoding, and
  Body Asset metadata conflicts;
- guidance suggestions and revisioned explicit settings save;
- no raw secrets, filesystem paths, or unlimited bytes in JSON payloads.

### Dashboard Tests

- Project creation without base URL;
- Endpoint required base URL, complete request matcher, and mode toggle;
- reversible dormant Variants and mock-readiness guidance;
- App State mode off/on with retained selections;
- Traffic list/detail ownership and provenance rendering;
- immediate preview, full-body progress, retry, and cached revisit;
- two-load concurrency, stale publication suppression, and LRU limits;
- read-only/editable CodeMirror modes and large-body policy;
- binary preview/Download without editor construction;
- Mock This review, exact-body blocking, target choices, stale refresh, commit
  unknown outcome, and canonical refresh;
- reviewed interception checklist without implicit mutation;
- import origin/query preview amendments.

### Integration And Chromium Gates

One acceptance flow must:

1. create one Project with no base URL;
2. configure exact and wildcard allowlisted hosts explicitly;
3. create multiple Endpoint origins, including same method/path with different
   query constraints;
4. verify an unmatched selected-host request passes through to its original
   origin and is recorded;
5. verify an explicit passthrough Endpoint passes through and records its mode;
6. verify a mock Endpoint wins, including active/base/fallback resolution;
7. disable App State mode and verify Endpoint fallback while selections remain;
8. capture exact text, binary, repeated headers, streaming, and bodyless traffic;
9. promote one exact response into a Variant and chosen State atomically;
10. repeat promotion and prove idempotence;
11. clear Traffic/restart and prove the promoted mock still serves exact bytes;
12. prove unselected hosts remain blind/unrecorded;
13. prove truncated/unavailable bodies create no partial mock;
14. prove a failed multi-record publication leaves no canonical or cache orphan.

Chromium performance gates retain the Large-Body design contract:

- a 10 MiB editable mock body becomes interactive within 400 ms;
- after editor readiness, measured scroll, type, undo, full-document search,
  Worker validation, and format publication have no Long Task over 50 ms;
- rapid switching among large Traffic entries leaves previews and unrelated UI
  responsive;
- no more than two full-body requests are active;
- cached revisit performs no new body request or full-panel load;
- 50 MiB Traffic measures responsiveness/progress rather than total load time;
- binary exact Download constructs no text editor.

Full unit, integration, lint, strict TypeScript, production build, whitespace,
Graphify, filesystem cleanup, and no-old-schema/no-old-route gates must pass.

## Delivery Sequence

The implementation plan will split Slice 3 into reviewed vertical units while
preserving one approved product design:

1. **Domain cutover:** schema v4, required Endpoint origins, complete matcher
   identity, mode toggle, State mode, direct-cutover fixtures, and Import Preview
   identity/query amendments.
2. **Runtime policy:** one selected-host decision pipeline, original-origin
   passthrough, HTTP/HTTPS parity, mock mode resolution, and shared provenance.
3. **Capture foundation:** Project Traffic retention, body descriptors,
   non-blocking sidecars, exact cache, leases, eviction, clear, and stream APIs.
4. **Inspector foundation:** dashboard API cutover, shared document cache,
   CodeMirror adapter, mock Body Editor migration, Traffic text/binary viewing.
5. **Promotion and settings:** atomic state-aware `Mock This`, Variant
   provenance, owner-safe refresh, interception guidance, debug-header setting,
   and Endpoint/Project UI changes.
6. **Acceptance certification:** multi-origin proxy flow, exact promotion,
   restart, failure atomicity, full regression, and Chromium performance gates.

Each unit uses strict test-driven development, fresh task review, and focused
plus full regression evidence. No task stages or commits files without explicit
user authorization.

## Delivery Boundary

Slice 3 is complete when a user can explicitly allowlist backend host patterns,
see every inspectable request in a Proxyman-style Traffic workspace, understand
whether each response came from a mock or original-origin passthrough, inspect
or download exact retained bodies, and promote an exact response into a
canonical response-only Variant with an explicit optional App State binding.

Projects no longer own a base URL. Every Endpoint owns one required origin and
all request matching behavior, may switch reversibly between mock and
passthrough, and may coexist with same-origin/path Endpoints differentiated by
query or request-header constraints. App State selection can be disabled
completely without deleting selections or bindings. Capture failure never
changes application traffic, interception never changes without explicit save,
and any failed promotion publishes no partial canonical state.
