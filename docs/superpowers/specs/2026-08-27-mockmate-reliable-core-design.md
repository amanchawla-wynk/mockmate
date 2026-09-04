# MockMate Reliable Core Product Design

**Date:** 2026-08-27
**Status:** Approved in design review
**Implementation scope:** Safety baseline and versioned core
**Product direction:** Deterministic app-state and failure simulation for streaming UI testing

**Fresh-app scope update (2026-08-28):** The migration, backup, rollback, and dual-model requirements in this document are superseded by `2026-08-28-mockmate-fresh-app-cutover-design.md`. Tasks 1-6 remain authoritative; remaining delivery is schema-v3-only and provides no legacy-data compatibility.

## Summary

MockMate should not compete with Proxyman or Charles as a general-purpose HTTP debugging proxy. Those products already provide mature capture, inspection, filtering, rewriting, and device interception. MockMate should borrow their clarity and operational smoothness while specializing in a workflow they do not model well: placing a real application into a named, deterministic UI state and reproducing streaming-specific failures.

The immediate milestone is a reliable core. It fixes current corruption and misleading behavior, replaces the overloaded `Resource`/`Scenario` persistence model with explicit endpoints, response variants, App States, and external body assets, and introduces versioned, validated, atomic storage. The existing TypeScript server remains; this is an in-place domain and persistence replacement rather than a rewrite.

Later milestones add device pairing and independent state assignment, lossless portable bundles, the approved state-first dashboard, deterministic response sequences, streamed faults, and HLS/DASH semantics. Those later capabilities constrain the core design but are not part of the first implementation plan.

## Why The Current Product Fails

The current model stores an endpoint, all response variants, inline payloads, and fixture references in one resource file. The server synchronously reloads complete resources for matching, while the dashboard fetches and edits complete resources. This coupling causes performance, correctness, and product-language problems.

### Critical defects

- Express retains its default JSON body limit, so ordinary payloads around 100 KB can receive `413 Payload Too Large` (`packages/server/src/app.ts:47-49`).
- The dashboard sends complete scenario payloads and repeatedly parses and formats controlled JSON text (`packages/dashboard/src/api/client.ts:128-139`, `packages/dashboard/src/components/ScenarioEditor.tsx:519-531`, `packages/dashboard/src/components/JsonEditor.tsx:26-45`).
- Unsaved edits are keyed only by scenario name and can cross from one resource to another (`packages/dashboard/src/components/ScenarioEditor.tsx:23-30`, `packages/dashboard/src/App.tsx:255-261`).
- Traffic-created fixture scenarios cannot be detached by the editor, while fixture content overrides visible edits at runtime (`packages/server/src/routes/admin.ts:555-593`, `packages/server/src/services/matcher.ts:361-379`).
- Fields labelled as request headers are emitted as response headers and can reflect imported credentials (`packages/dashboard/src/components/ScenarioEditor.tsx:489-499`, `packages/server/src/services/matcher.ts:381-386`).
- Static upload parsing is mounted after the route that needs it, permitting broken or zero-byte uploads (`packages/server/src/app.ts:61-100`).

### Structural defects

- Certificate reuse ignores changed IP SAN requirements, while routine renewal rotates the trusted CA.
- Physical-device setup is split between unused dashboard code and a long, hard-coded setup page.
- Traffic polling repeatedly transfers all retained bodies and is not project-scoped.
- Postman and cURL imports are lossy and partial; project export is absent.
- Optional values cannot reliably be cleared because omitted and cleared values share one representation.
- Scenario names are free-form identifiers interpolated into URLs.
- `Project`, `Workspace`, `Domain`, `Resource`, `Rule`, and `Scenario` describe overlapping concepts.
- The handwritten proxy buffers responses, only understands part of HTTP/1.1 request framing, and is unsuitable as the primary streaming test path.
- Persistence has no schema version, runtime validation, atomic writes, or visible recovery path.

## Competitive Position

### What to borrow

Proxyman demonstrates the expected quality bar:

- progressive setup automation with diagnostic fallbacks;
- clear grouping and persistent navigation;
- lazy, data-aware body viewers;
- visible provenance for request mutations;
- composable search and filtering;
- disk-backed large bodies;
- portable sessions and deliberate sharing.

Charles demonstrates durable cross-platform interception, Map Local/Remote, Rewrite, Breakpoints, throttling, and portable session files. It also demonstrates the cost of fragmented physical-device setup and transaction-centric workflows.

### What not to copy

MockMate will not attempt to reproduce their full traffic workbenches. Capture and transparent proxying are supporting infrastructure, not the product's primary information architecture.

### Differentiation

Neither competitor provides a first-class model for:

- named application UI states spanning multiple endpoints;
- independent state assignment to concurrent physical devices;
- deterministic request sequences and recovery paths;
- semantic streaming faults such as a selected segment failure;
- correlation between network behavior and expected UI outcome;
- a portable, source-controllable state-and-failure bundle.

MockMate's product statement is:

> MockMate is a deterministic app-state and failure simulator for testing streaming UIs on real devices.

## Product Decisions

The design review established these constraints:

- The must-win workflow is UI state simulation, not generic traffic debugging.
- Debug-app pairing is the primary physical-device connection. Transparent interception remains optional and advanced.
- A normal editable body may be up to 10 MiB. Larger streaming media belongs in file assets and is not edited as JSON.
- The canonical import/export artifact is a lossless, versioned MockMate bundle. Postman, OpenAPI, HAR, and cURL are adapters.
- The first implementation milestone is the reliable core, before the full visual overhaul.
- The dashboard uses a Proxyman-inspired light palette only: cool gray navigation, white surfaces, crisp blue actions and selections, green health indicators, and restrained borders and shadows.
- MockMate keeps its own state-first information architecture and branding.

## Goals

- Prevent cross-endpoint draft corruption and invisible persistence failures.
- Give every persisted format an explicit schema version and runtime validation.
- Separate endpoint metadata from response body storage.
- Keep body size out of endpoint listing and request matching costs.
- Support editing and serving bodies up to 10 MiB without blocking the dashboard main thread.
- Make request matching and App State fallback deterministic and observable.
- Establish stable domain terminology and identifiers.
- Make future device assignment, bundles, and streaming faults additive rather than another remodel.

## Non-Goals For The First Implementation Plan

- Full state-first dashboard redesign and visual polish.
- Device pairing or per-device assignments.
- Transparent proxy rewrite or HTTP/2/HTTP/3 interception.
- Deterministic multi-request sequences.
- HLS or DASH parsing, playback timelines, QoE analysis, or DRM processing.
- Postman, OpenAPI, HAR, or cURL adapter improvements.
- Canonical bundle import/export implementation and UI.
- Cloud collaboration, accounts, or remote storage.

Safe HTTP-level license outcomes may be modeled later. MockMate will not bypass DRM, generate unauthorized licenses, or decrypt protected media.

## Canonical Domain Model

### Project

A Project is one mock environment for an application.

```ts
interface Project {
  schemaVersion: 3;
  id: string;
  name: string;
  description?: string;
  baseUrl?: string;
  activeStateId?: string;
  baseStateId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

`undefined` means a field was omitted from an update. Explicit `null` means clear the optional field. The persisted representation omits cleared optional fields.

### Endpoint

An Endpoint is a named request contract and matcher, for example `Playback authorization` or `Get profile`.

```ts
interface Endpoint {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  matcher: {
    method: string;
    host?: string;
    path: string;
    query?: Record<string, MatchExpression>;
    headers?: Record<string, MatchExpression>;
  };
  defaultVariantId: string;
  variants: ResponseVariantSummary[];
  revision: number;
}
```

Request examples and documentation are separate from matcher criteria. Response headers are never stored in a request-header field.

### Response Variant

A Response Variant is one reusable endpoint behavior, for example `200 entitled`, `403 geo-blocked`, or `slow success`.

```ts
interface ResponseVariant {
  id: string;
  endpointId: string;
  name: string;
  description?: string;
  status: number;
  responseHeaders: Record<string, string>;
  bodyAssetId?: string;
  delayMs?: number;
  revision: number;
}
```

Fixtures no longer override an editable inline response. Captured bodies and manually authored bodies use the same Body Asset abstraction. Future fault and sequence fields extend response behavior explicitly.

### App State

An App State is the tester-facing outcome, such as `Subscribed home`, `Expired session`, or `Playback geo-blocked`.

```ts
interface AppState {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  tags: string[];
  expectedUi?: string;
  bindings: Record<string, string>; // endpointId -> variantId
  revision: number;
}
```

Coverage is calculated rather than guessed. Missing endpoint bindings are reported before activation. Runtime fallback remains deterministic and is recorded in traffic provenance.

### Body Asset

A Body Asset is immutable payload content stored outside endpoint metadata.

```ts
interface BodyAsset {
  id: string; // sha256 digest
  mediaType: string;
  size: number;
  encoding?: string;
  createdAt: string;
}
```

The content hash supplies integrity checking and safe deduplication. Variant updates point to a new immutable asset; unreferenced assets can be garbage-collected only after a separate reachability check.

### Future Device Assignment

The storage and matcher boundaries must permit this later type without redesign:

```ts
interface DeviceAssignment {
  projectId: string;
  clientId: string;
  stateId: string;
  revision: number;
  expiresAt?: string;
}
```

The future request resolution order is:

1. explicit request override;
2. device assignment;
3. project active App State;
4. project base App State;
5. endpoint default variant.

The reliable-core matcher implements the applicable project-state and endpoint-default portion now and represents provenance in a way that can add the first two sources later.

## Repository Architecture

The server remains TypeScript and Express. Persistence is still local and inspectable, but access goes through one repository boundary.

```text
projects/<project-id>/
  current.json
  generations/
    <generation-id>/
      project.json
      endpoints/
        <endpoint-id>.json
      states/
        <state-id>.json
  bodies/
    sha256/<prefix>/<digest>
```

### Validation

- Every read crosses a runtime schema validator.
- Referential integrity is checked for default variants, state bindings, and body assets.
- Validation failures produce diagnostics containing the file, JSON path, error code, and recovery action.
- Invalid records are never silently skipped.

### Atomic writes

- Validate the complete proposed mutation before disk I/O.
- Write new content to a temporary file in the destination filesystem.
- Flush and atomically rename the file.
- Replace the in-memory repository snapshot only after the rename succeeds.
- On failure, preserve the previous file and in-memory snapshot.

Ordinary mutations replace one metadata file and then swap the compiled in-memory snapshot. Project creation and future bundle import build and validate a complete immutable generation before atomically replacing `current.json`; prior generations remain immutable repository history.

### Compiled matcher

- Startup compiles endpoint matchers, App State bindings, and variant summaries into memory.
- A successful mutation builds and validates a replacement snapshot before swapping it atomically.
- Request matching never enumerates or parses project files.
- Body bytes are not part of the matcher snapshot.
- Matching returns the selected endpoint, variant, state source, fallback reason, and body reference.

### Body delivery

- Metadata JSON and body bytes use separate API routes and size limits.
- Editable body upload is capped at 10 MiB.
- Runtime delivery streams from the body store rather than converting the complete body through JSON.
- Content type and content length come from validated asset metadata.
- Binary bodies are never coerced through JavaScript strings.
- Range support is preserved as a future streaming requirement and must not be prevented by the repository interface.

## API Boundaries

The exact route names may follow existing conventions, but the contracts must separate summaries, details, and bytes.

```text
GET    /api/admin/projects/:projectId/endpoints
GET    /api/admin/projects/:projectId/endpoints/:endpointId
PUT    /api/admin/projects/:projectId/endpoints/:endpointId

GET    /api/admin/projects/:projectId/states
GET    /api/admin/projects/:projectId/states/:stateId
PUT    /api/admin/projects/:projectId/states/:stateId

GET    /api/admin/projects/:projectId/bodies/:assetId
POST   /api/admin/projects/:projectId/bodies
```

List routes return summaries and never inline body content. Mutations include the caller's expected revision. A mismatched revision returns a conflict and the current revision.

Names are display values only. Stable IDs are used in paths and references. Display names may contain ordinary punctuation without changing routing.

## Error Contract

All admin errors use a stable shape:

```ts
interface ApiError {
  code: string;
  message: string;
  path?: string;
  details?: unknown;
  recovery?: string;
  requestId: string;
}
```

Required status behavior:

- `400` for malformed requests;
- `404` for missing stable IDs;
- `409` for revision conflicts and identifier collisions;
- `413` for body assets over 10 MiB;
- `422` for schema, JSON, or referential-integrity failures;
- `500` for unexpected failures, with no secret paths or body content in the response.

The dashboard surfaces errors inline and preserves the user's draft. Invalid JSON blocks save. Navigation with an unsaved draft requires explicit discard or stay.

## Fresh Schema-V3 Cutover

Production starts from an empty schema-v3 workspace and never discovers Resource/Scenario persistence. The server runtime, admin API, and dashboard switch to the canonical repository in one source-tree commit; no migration, backup, rollback, pending-cutover, or compatibility subsystem is shipped.

## Safety Baseline

The following repairs are part of the reliable-core foundation:

- Certificate paths honor the configured data directory in all environments.
- Tests cannot access or delete `~/.mockmate/certs`.
- The CA remains stable; leaf certificates regenerate when SANs or expiry require it.
- Static body middleware is mounted before its route.
- Request examples, request matchers, and response headers use distinct types and labels.
- Captured responses become normal editable body assets.
- Clearing optional values uses explicit `null` semantics.
- Route parameters use stable encoded IDs rather than scenario names.
- Admin APIs bind to localhost by default and restrict CORS to the dashboard origin.
- Traffic entries are project-scoped, paginated or incremental, and do not inline unlimited bodies.

## Large-Body Dashboard Contract

The full light-mode dashboard redesign is later, but the reliable core must expose contracts that make it possible.

- Endpoint and variant lists contain no body bytes.
- Opening an editor fetches the selected Body Asset separately.
- JSON validation and formatting run in a worker and are debounced.
- Text input is not reparsed and reformatted on every keystroke.
- Draft state is keyed by endpoint ID, variant ID, and body revision.
- A 10 MiB body can be uploaded or downloaded directly.
- Invalid JSON remains visible as a draft and cannot silently save an older parsed value.
- Saving body content and saving variant metadata are explicit operations with visible progress and errors.

## Target Dashboard Direction

The later dashboard information architecture is:

```text
App States · Endpoints · Devices · Traffic · Assets · Project Settings
```

App States is the home screen. Traffic is supporting evidence, not the organizing principle. Each App State shows endpoint coverage, expected UI outcome, assigned devices, recent traffic, and validation warnings.

The dashboard is light-mode only. Its palette is inspired by Proxyman's calm macOS presentation:

- cool gray navigation and chrome;
- white content surfaces;
- crisp blue primary actions and selections;
- green connection and success indicators;
- dark ink text;
- restrained borders and shadows.

MockMate does not copy Proxyman's traffic-first layout. The visual system supports MockMate's state-first workflow and identity. Navigation collapses on small screens, tables become cards, and pairing/status workflows support a 390 px viewport. Complex authoring remains desktop-optimized.

## Future Device Pairing

Debug-app pairing is the primary future physical-device workflow.

- The dashboard generates a short-lived pairing token represented as a QR code and short code.
- A debug build points its API base URL to MockMate and presents the token once.
- Pairing establishes a stable client identity and renewable lease.
- Requests carry the client identity through an explicit debug header.
- The dashboard displays connectivity, assignment, last request, network interface, and diagnostic failures together.
- Transparent interception, CA installation, and production-host proxying move into an Advanced flow.

Two paired clients must eventually run different App States concurrently without changing project-global state.

## Future Lossless Bundle

The canonical `.mockmate` bundle will contain:

- manifest and schema version;
- project metadata;
- endpoints and response variants;
- App States and bindings;
- all referenced body assets, including normalized fixtures, and static media;
- content types, sizes, and integrity hashes.

It will exclude CA material, private keys, local ports, device leases, and traffic history. Because a lossless bundle may contain sensitive mock headers or bodies, redaction is an explicit derived export rather than an implicit mutation of the canonical bundle.

Import validates and stages the entire bundle, then previews additions, updates, conflicts, missing assets, and schema changes. Create, replace, and merge commit atomically. Any rejected item rejects the entire commit.

## Traffic Provenance

Every resolved mock request records:

- project ID;
- client ID when available;
- selected App State;
- matched Endpoint;
- selected Response Variant;
- resolution source;
- fallback reason, if any;
- status, duration, and body size;
- body reference or bounded preview rather than an unlimited inline body.

Optional debug response headers may expose non-sensitive state, endpoint, variant, and resolution identifiers. They must be configurable and disabled for passthrough responses by default.

## Verification Strategy

### Unit tests

- Runtime schemas and referential integrity.
- Matcher precedence and fallback provenance.
- Explicit clear versus omitted update semantics.
- Revision conflict handling.
- Content hashing and Body Asset metadata.
- Atomic repository snapshot replacement.
- Certificate CA/leaf lifecycle.

### Integration tests

- Traffic-created response -> edit -> serve returns edited bytes.
- Static binary upload -> serve preserves bytes and content type.
- A 10 MiB JSON body can be stored and served.
- Endpoint list responses remain unchanged in size when large bodies are added.
- Simulated disk write failure preserves the previous valid project.
- Corrupt data produces a visible diagnostic instead of disappearing.
- Admin routes are unavailable from LAN interfaces by default.

### Dashboard tests

- Drafts cannot cross endpoint or variant boundaries.
- Invalid JSON blocks save and preserves text.
- Body content loads lazily.
- Revision conflicts preserve both local draft and server state.
- Error and recovery actions are visible.

### Performance gates

Use a repeatable local fixture containing 500 endpoints, five variants per endpoint, and twenty 10 MiB bodies.

- Endpoint summary response size is independent of body bytes.
- Warm endpoint summary requests complete within 300 ms at p95 on the project development machine.
- Matcher selection completes within 10 ms at p95, excluding body I/O.
- Serving a 10 MiB asset streams without materializing all project bodies or creating a second full-body copy.
- JSON parsing and formatting create no dashboard main-thread task longer than 50 ms.

These gates are regression thresholds for the fixture and development environment, not public network latency guarantees.

## Delivery Sequence

### Release 1: Safety baseline

- Add failing regression tests for current corruption paths.
- Isolate certificate tests and repair CA/leaf lifecycle.
- Correct fixture editing, header semantics, static uploads, clearing, and stable identifiers.
- Introduce structured errors and safe traffic bounds where required for testability.

### Release 2: Versioned core

- Add canonical schemas and the repository boundary.
- Add immutable Body Assets and summary/detail APIs.
- Add compiled matching, project-level App State fallback, and provenance.
- Add optimistic revisions.
- Make only the minimum dashboard adaptations needed to operate the new contracts safely; defer the full visual redesign.

The first implementation plan covers Releases 1 and 2 only.

### Later releases

3. Debug-app pairing and per-device App State assignment.
4. Lossless bundle export and staged import.
5. Proxyman-inspired light, state-first dashboard.
6. Deterministic response sequences and reset semantics.
7. Streamed delivery, range support, and controlled midstream faults.
8. HLS/DASH asset graph and playback timeline.
9. WebSocket/SSE scenarios and safe license-outcome modeling.

Each later release requires its own focused specification and implementation plan.

## Acceptance Criteria For The Reliable Core

- No test can access real user certificate data.
- A stable CA survives leaf renewal and IP SAN changes.
- Request headers and response headers cannot be confused by types, APIs, or labels.
- A captured response can be edited and the served response changes accordingly.
- Static binary upload and serving preserve exact bytes.
- Empty optional values can be explicitly cleared.
- Endpoint and variant display names never participate in route identity.
- A 10 MiB JSON body can be stored and served without appearing in endpoint list payloads.
- Request matching performs no filesystem scan or resource JSON parsing.
- Failed writes and revision conflicts never overwrite the previous valid state.
- Invalid persisted data is visible and recoverable rather than silently omitted.
- App State coverage and fallback provenance are deterministic and testable.
- All repository, integration, dashboard, performance, test, lint, and build gates pass.
