# Traffic Capture And Interception

MockMate keeps applications calling their real backend origins. A device uses
MockMate as an HTTP proxy, and each Project explicitly selects the hostnames that
may be intercepted. HTTPS for unselected hosts remains blind and unrecorded.

## Canonical Routes

```text
GET    /api/admin/projects/:projectId/traffic
GET    /api/admin/projects/:projectId/traffic/:trafficId
DELETE /api/admin/projects/:projectId/traffic
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/request
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/response
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/{request|response}?view=decoded
GET    /api/admin/projects/:projectId/traffic/:trafficId/bodies/{request|response}?download=1
POST   /api/admin/projects/:projectId/traffic/:trafficId/mock
GET    /api/admin/projects/:projectId/interception-guidance
```

## Routing

Each Endpoint owns a required normalized HTTP/HTTPS `baseUrl`, matcher, mode,
and Variants. A selected Endpoint in Mock mode returns its resolved Variant. A
Passthrough Endpoint, or a selected request without a matching Endpoint, forwards
to the incoming original origin. Direct MockMate requests require a trusted
backend `Host` authority and never perform passthrough.

App State mode is reversible. Disabled mode retains the active State ID and dormant
bindings while every mock Endpoint serves its Serving now Variant. Enabled mode
mocks only active-state bindings; an unbound mock Endpoint passes through upstream.
Coverage counts include only mock Endpoints that have a Serving now Variant.

## Traffic Evidence

Traffic summaries and details contain redacted request evidence, routing
provenance, App State resolution, response metadata, and bounded body previews.
Transport failures can produce ephemeral `500` rows even when no durable
upstream response exists.

Exact Traffic body retention is always on. Detail-JSON body previews are capped
at `1 MiB`; exact bodies are retained without a per-body size ceiling and are
bounded only by the ephemeral retained-byte LRU (`1 GiB` per Project /
`4 GiB` process-wide). Size and digest describe entity bytes after transport
framing and before content decoding. That encoded identity is what Download and
Mock This promotion use.

For display, MockMate stream-decodes `gzip`, `deflate`, and `br` (including
comma-separated chains) into the bounded preview and into
`?view=decoded` for supported text media types. Decoded views expose
`X-MockMate-View: decoded`, `X-MockMate-Decoded-Sha256`, and
`X-MockMate-Original-Content-Encoding`. They never change the retained digest.
Decode failures keep the previous base64/encoded preview and leave Download on
the encoded bytes. Binary content-encoded bodies remain download-only.

Exact body routes distinguish unavailable, truncated, and evicted states. The
dashboard preserves preview evidence when exact retrieval fails. JSON previews
are pretty-printed when the decoded UTF-8 payload parses as JSON.

## Mock This

`Mock This` promotes an accepted Traffic snapshot into Endpoint/Variant state.
The dashboard one-click flow uses the reviewed create/reuse endpoint choice and
always leaves the promoted mock unbound. Review surfaces still describe captured
origin, method, path, query, redacted request headers, exact response status and
headers, media type, encoding, size, and digest.

Masked display text never forms a mutation payload. Hidden matcher values and
exact response values remain server-owned in the trusted Traffic snapshot; the
Endpoint API is the only trusted matcher-secret exception. Revision conflicts
preserve choices and refresh canonical data. Unknown outcomes use GET-only
receipt reconciliation, and a failed refresh never automatically repeats POST.

## Interception Settings

The settings form saves `interceptHosts` and `debugProvenanceHeaders` with one
expected revision (`captureRawTraffic` remains in the API for compatibility and
is always persisted as enabled). Exact Traffic body retention does not depend on
an operator toggle. Guidance combines persisted Endpoint origins with ephemeral
Import origins and suggests exact hostnames only. Operators may enter wildcard
patterns manually. Catch-all `*` requires explicit confirmation.

Endpoint creation, Import, Traffic capture, promotion, and guidance reads never
change interception settings. Import suggestions exist only after successful
canonical Import refresh and are dropped when their Project/session owner is
discarded.
