# MockMate Authoring Foundation Design

Date: 2026-08-29
Status: Approved

## Summary

MockMate already stores Projects, Endpoints, Response Variants, App States, and
immutable Body Assets as separate canonical resources. The server supports most
of the required CRUD operations, but the dashboard does not expose several of
them. This makes the product appear unable to delete Endpoints or App States,
create multiple Variants, import requests, or edit complete responses even when
parts of those capabilities already exist below the UI.

This design completes the authoring foundation without replacing the domain
model or its revision and publication guarantees. It adds safe deletion,
multi-Variant authoring, fallback selection, response-header editing, and clear
mobile-automation identity. It also makes the existing multi-backend model
explicit: an Endpoint owns its optional host matcher, so a Project is not tied
to one origin.

The work is the first of three staged designs:

1. Authoring foundation: this document.
2. cURL and Postman import workflow and multi-origin import semantics.
3. Traffic capture, original-origin passthrough, provenance, and state-aware
   `Mock This`.

## Goals

- Let users delete Endpoints and App States from the dashboard safely.
- Let users create, clone, select, edit, and delete multiple Variants for one
  Endpoint.
- Let users explicitly choose the Endpoint fallback Variant.
- Let users mock status, delay, response headers, and response body per Variant.
- Preserve App State to Variant referential integrity through all mutations.
- Preserve the existing iOS and Android automation API that selects an App
  State before sequential tests run.
- Keep stable IDs, optimistic revisions, immutable body assets, and atomic
  generation publication.
- Make it clear that Endpoints in one Project may match different backend hosts.

## Non-Goals

- cURL or Postman import UI and import conflict handling.
- Changes to proxy interception, passthrough, capture, or Traffic retention.
- Removing the proxy passthrough `baseUrl` gate; that belongs to the Traffic
  Capture design.
- Per-client or per-device App State selection. Test execution is sequential for
  the current milestone, so project-global selection remains sufficient.
- Traffic replay, breakpoint editing, or captured-flow persistence.
- Replacing granular resource APIs with an aggregate document editor.

## Domain Model

The canonical hierarchy remains:

```text
Project
  -> Endpoint
      matcher: method + optional host + path + optional query/header constraints
      -> Response Variant
          status + response headers + body asset + delay
  -> App State
      bindings: Endpoint ID -> Variant ID
```

### Multi-Backend Projects

`Project.baseUrl` is optional and is not part of Endpoint identity. Each
Endpoint has an optional `matcher.host`. A single Project may therefore contain
Endpoints for multiple services, for example:

```text
POST auth.example.com/v1/login
GET  content.example.com/v2/home
POST payments.example.com/v1/checkout
```

An Endpoint without a host matcher can match the same method/path on any
selected host. The UI must describe that as an intentional wildcard rather than
implying that the Project owns one backend origin.

### Variant Fallback

Every Endpoint has one `defaultVariantId`. This is presented to users as the
Endpoint's fallback Variant. Resolution order remains:

1. Active App State binding.
2. Base App State binding.
3. Endpoint fallback Variant.

Every Endpoint must contain at least one Variant, and its fallback ID must refer
to one of its own Variants.

### Response Headers

Response headers support both single and repeated values:

```ts
type ResponseHeaderValue = string | string[];
type ResponseHeaders = Record<string, ResponseHeaderValue>;
```

A single row for a header serializes as a string. Repeated rows with the same
case-insensitive name serialize as an ordered string array. This is required for
responses such as multiple `Set-Cookie` fields that cannot be represented by a
comma-joined value. Existing persisted string values remain valid.

## Architecture Decision

Evolve the existing granular resource APIs and keep integrity rules in the
repository.

The dashboard expresses user intent. It does not orchestrate a sequence of
dependent updates and deletions. A repository operation clones the current
snapshot, applies all dependent changes, validates and compiles the candidate,
writes the next generation, and only then publishes it in memory.

This preserves the current guarantees:

- no partially cleaned App State bindings;
- no missing fallback Variant between requests;
- no selection pointing at a deleted App State;
- stale revisions do not overwrite newer edits;
- failed validation, compile, or disk writes leave the previous generation
  active.

## Dashboard Workflow

### Endpoint Editor

The top section continues to edit:

- name;
- description;
- method;
- optional host;
- path and existing request constraints.

An Endpoint actions menu adds `Delete Endpoint`.

The optional host field must explain:

- a host selects one backend service;
- different Endpoints may use different hosts;
- an empty host matches any selected host for the same request matcher.

### Variant Navigation

Variants appear as tabs. The current fallback has a visible `Fallback` badge.
The selected Variant exposes an actions menu containing:

- `Set as fallback`, when it is not already the fallback;
- `Delete Variant`;
- `Clone Variant` as a shortcut to the new-Variant dialog with clone selected.

When an Endpoint has only one Variant, `Delete Variant` is disabled with an
explanation that every Endpoint requires a fallback response.

`New Variant` opens a dialog requiring a name and one source:

- `Clone selected Variant`, selected by default when a Variant exists;
- `Start blank`.

A cloned Variant copies:

- status;
- response headers;
- delay;
- description;
- the immutable Body Asset ID, when present.

It receives a new Variant ID and revision. Sharing the immutable Body Asset is
safe; later body edits upload a new asset and only update the edited Variant.

A blank Variant starts with status 200, no response headers, no delay, and no
body.

### Variant Editor

Each Variant editor exposes:

- name;
- description;
- HTTP status;
- response delay;
- response headers;
- response body.

Response headers use a key/value table. Users can add and remove rows. Repeated
case-insensitive names are preserved as ordered values, allowing responses such
as multiple `Set-Cookie` fields. The UI rejects empty names before save. The
server remains authoritative for Node-compatible header-name and header-value
validation.

The existing response-body workflow remains:

- bodies load lazily;
- JSON validation and formatting remain available;
- saving body bytes creates an immutable Body Asset;
- removing a body detaches the asset from the Variant;
- large-body and navigation-draft safeguards remain intact.

### App State Editor

The App State editor keeps Endpoint-to-Variant bindings as its central control.
It adds:

- a read-only stable App State ID with a copy action;
- `Delete App State`;
- automation guidance showing that `/setMockServerflags` uses this stable ID.

Renaming an App State does not change its ID and therefore does not break mobile
automation.

Deleting an App State always warns that MockMate cannot discover or update
references embedded in external iOS or Android test code.

## Deletion Semantics

### Endpoint Deletion

Before confirmation, the dashboard requests deletion impact. The dialog shows
the number and names of App States that bind the Endpoint.

On confirmation, one repository operation:

1. verifies the Endpoint revision;
2. removes the Endpoint;
3. removes that Endpoint ID from every App State binding map;
4. increments every affected App State revision;
5. validates, compiles, persists, and publishes the candidate atomically.

No replacement is required because an App State may validly omit an Endpoint
and use fallback behavior according to the existing coverage rules.

### App State Deletion

The confirmation identifies whether the state is Active, Base, both, or neither.

On confirmation, one repository operation:

1. verifies the App State revision;
2. removes the App State;
3. clears `activeStateId` and/or `baseStateId` only when they reference the
   deleted state;
4. increments the Project revision when selection changed;
5. validates, compiles, persists, and publishes atomically.

No other App State becomes active implicitly.

### Variant Deletion

The last Variant cannot be deleted. The user must delete the Endpoint instead.

Before confirmation, the dashboard requests deletion impact. The response
identifies:

- whether the Variant is the Endpoint fallback;
- every App State bound to it;
- the remaining replacement candidates owned by the same Endpoint.

If the Variant is the fallback or has App State references, the dialog requires
a replacement Variant. On confirmation, one repository operation:

1. always verifies the Variant revision and verifies the Endpoint revision when
   replacement or fallback reassignment is required;
2. when a replacement is required or supplied, verifies that it exists, differs
   from the deleted Variant, and belongs to the same Endpoint;
3. changes `defaultVariantId` when required;
4. replaces every matching App State binding;
5. increments the Endpoint and affected App State revisions;
6. removes the old Variant;
7. validates, compiles, persists, and publishes atomically.

An unreferenced non-fallback Variant may be deleted without a replacement.

## API Design

### Read-Only Impact Queries

Add:

```http
GET /api/admin/projects/:projectId/endpoints/:endpointId/deletion-impact
GET /api/admin/projects/:projectId/endpoints/:endpointId/variants/:variantId/deletion-impact
```

Endpoint impact returns the current Endpoint revision and affected App State
summaries.

Variant impact returns current Endpoint and Variant revisions, fallback status,
affected App State summaries, and replacement Variant summaries.

Impact responses are advisory. Mutations still validate current revisions and
dependencies under the repository's per-Project queue.

### Endpoint Delete

Keep the existing route and request shape:

```http
DELETE /api/admin/projects/:projectId/endpoints/:endpointId
Content-Type: application/json

{ "expectedRevision": 4 }
```

Change repository behavior to clean App State bindings atomically.

### App State Delete

Keep the existing route and request shape:

```http
DELETE /api/admin/projects/:projectId/states/:stateId
Content-Type: application/json

{ "expectedRevision": 2 }
```

Change repository behavior to clear Active/Base selection atomically.

### Variant Delete

Extend the existing request body:

```http
DELETE /api/admin/projects/:projectId/endpoints/:endpointId/variants/:variantId
Content-Type: application/json

{
  "expectedRevision": 3,
  "expectedEndpointRevision": 7,
  "replacementVariantId": "var_replacement"
}
```

`replacementVariantId` and `expectedEndpointRevision` are required when the
Variant is the fallback or is referenced by an App State. Both are optional for
an unreferenced non-fallback Variant, preserving the existing delete request
shape for that case.

### Variant Create And Update

Keep the existing Variant create and update resources. A create request contains
`expectedEndpointRevision` and a `CreateVariantInput` with name, optional
description, status, response headers, optional Body Asset ID, and optional
delay. A clone sends copied values through this normal request. A blank create
sends status 200, an empty header map, and no body or delay.

Variant update retains `expectedRevision` plus a patch. The patch may update
name, description, status, repeated or single response headers, delay, and Body
Asset ID. `null` detaches an optional description, delay, or body according to
the existing patch semantics. The referenced Body Asset must exist in the same
Project.

The dashboard refreshes Endpoint detail after create, delete, or fallback
changes so it receives the new Endpoint revision and canonical Variant ordering.

`Set as fallback` uses the existing Endpoint update route:

```http
PUT /api/admin/projects/:projectId/endpoints/:endpointId
Content-Type: application/json

{
  "expectedRevision": 7,
  "patch": { "defaultVariantId": "var_fallback" }
}
```

The target Variant must exist on that Endpoint. A missing or cross-Endpoint ID
returns `INVALID_DEFAULT_VARIANT` without publishing any change.

## Mobile Automation Contract

Preserve both methods:

```http
PUT /setMockServerflags
POST /setMockServerflags
```

The accepted payload remains:

```json
{
  "projectId": "prj_example",
  "stateId": "state_paid",
  "clearTraffic": true
}
```

Behavior remains:

- omitted `projectId` uses the active workspace Project;
- a supplied Project must be the active workspace Project;
- `clearTraffic: true` clears that Project's traffic;
- a stable `stateId` sets the Project's active App State;
- the server obtains the current Project revision internally;
- callers do not send optimistic revisions;
- the next resolved request sees the newly published App State.

Sequential execution is an explicit current constraint. Parallel suites sharing
one Project are not isolated and remain out of scope. Future client-scoped state
must be additive and must not break this project-global route.

Acceptance coverage must prove that Variant creation, replacement, response
editing, and fallback changes are visible after state selection through this
automation route.

## Error Handling

- Revision mismatch returns HTTP 409 with the current revision where available.
- The dashboard preserves unsaved drafts and offers refresh rather than silently
  overwriting server state.
- Last-Variant deletion returns `LAST_VARIANT_REQUIRED`.
- Missing replacement returns `VARIANT_REPLACEMENT_REQUIRED`.
- Same-Variant or cross-Endpoint replacement returns
  `INVALID_VARIANT_REPLACEMENT`.
- Unknown automation App State returns a clear not-found API error; MockMate does
  not silently select another state.
- Validation, compile, write, or publication failure leaves the previous
  generation and in-memory compiled Project unchanged.
- Dirty-edit navigation guards run before creating, cloning, deleting, changing
  fallback, switching Variants, or switching App States.

## Refresh And Consistency

After a successful mutation:

- Endpoint create/update refreshes Endpoint summaries and selected detail.
- Variant create/update/delete/fallback refreshes selected Endpoint detail.
- Endpoint delete refreshes Endpoint summaries, App State summaries, and any
  selected App State detail.
- App State delete refreshes Project selection and App State summaries, then
  clears the deleted selection in the dashboard.

The dashboard renders only canonical responses returned or reloaded after
publication. It does not predict revisions locally.

## Testing Strategy

### Repository Tests

- Endpoint deletion removes all matching App State bindings atomically.
- Endpoint deletion increments affected state revisions.
- App State deletion clears Active/Base references and increments Project
  revision only when needed.
- Variant deletion replaces fallback and all references atomically.
- Unreferenced non-fallback Variant deletion needs no replacement.
- Last-Variant deletion is rejected.
- Missing, same, and cross-Endpoint replacements are rejected.
- Stale Endpoint, Variant, and App State revisions are rejected.
- Compile, filesystem, and publication failures leave the old generation active.
- Clone input can reuse an immutable Body Asset without duplicating bytes.

### Route Tests

- Deletion-impact payloads report current dependencies and replacement choices.
- Delete routes validate stable IDs, revisions, and replacement ownership.
- Existing unreferenced Variant delete callers remain valid.
- Header names and values retain existing normalization and injection defenses.
- Single and repeated response-header values serialize without collapsing
  multiple `Set-Cookie` fields.
- `PUT` and `POST /setMockServerflags` retain their current payload and behavior.

### Dashboard Tests

- Add Variant supports clone and blank sources.
- Clone copies status, headers, delay, description, and body reference.
- Fallback badge and action track canonical Endpoint state.
- Header rows add, edit, remove, and validate correctly.
- Existing body load, edit, remove, conflict, and dirty-draft behavior remains.
- Endpoint, App State, and Variant confirmations display dependency impact.
- Referenced/default Variant deletion requires replacement selection.
- Last-Variant deletion is disabled with an explanation and remains rejected by
  the server as defense in depth.
- Active/Base App State deletion warning is accurate.
- App State stable ID is visible and copyable.
- Mutation conflicts preserve drafts and allow refresh.

### Integration Tests

At least one integration test must:

1. create an Endpoint with multiple Variants;
2. create an App State binding one Variant;
3. call `/setMockServerflags` with that stable App State ID;
4. verify the bound Variant's status, headers, and body are served;
5. replace or edit that Variant through canonical APIs;
6. call the automation route again;
7. verify the next request sees the newly published response.

Existing proxy, body streaming, App State fallback, repository restart, and
dashboard navigation suites remain regression gates.

## Delivery Boundary

This slice is complete when users can fully author and safely delete canonical
Endpoints, Variants, and App States from the dashboard while existing mobile
automation continues to select deterministic responses.

The next design will add cURL and Postman import UI, preserve hosts for all
imported requests, define duplicate/conflict handling, and map imported examples
to initial response Variants. The third design will define selected-host traffic
capture, original-origin passthrough without a `baseUrl` gate, state-aware
promotion, and consistent provenance.
