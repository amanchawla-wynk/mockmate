# Final Review Details Design

## Goal

Close the final HTTP connection-token and Endpoint dirty-ownership gaps without changing MockMate's schema-v3 cutover, security boundaries, stream ownership, or draft isolation.

## HTTP Connection Semantics

One shared helper parses a `Connection` field as comma-separated tokens. Each token is trimmed for optional whitespace, lowercased, and compared by exact membership. Empty tokens are ignored, so `x-hop, Close` contains `close` while `disclose` does not.

The proxy uses this helper at all three ownership boundaries:

- Incoming request headers determine HTTP/1.1 explicit close and HTTP/1.0 keep-alive opt-in.
- Final resolved mock headers determine configured response close after case-insensitive header normalization.
- Forwarded upstream headers are parsed before hop-by-hop headers are removed. `ProxyOutgoingResponse` carries only a boolean close decision to the TLS drain; it does not forward the upstream `Connection` field.

Any close owner produces a `close` response outcome, rewrites the client response to coherent `Connection: close`, ends TLS once, clears buffered pipeline bytes, and prevents a second body or upstream request. Ordinary HTTP/1.1 keep-alive and HTTP/1.0 defaults remain unchanged.

## Endpoint Publication Acceptance

`useEndpoints.publishEndpoint(publication, endpoint)` returns `true` only when Project ID, selected Endpoint ID, Project generation, detail generation, and saved Endpoint identity all match. It returns `false` without mutating detail ownership for stale completion.

`EndpointEditor` captures its operation-scoped completion callback before awaiting create/update, invokes that callback immediately after server success, and clears the dirty key or normalizes fields only when the callback returns `true`. A stale unmounted editor therefore cannot clear a newly reopened editor's identical revision-based dirty key.

`App` refreshes Endpoint summaries after either accepted or rejected server success, but reports publication acceptance synchronously to the editor. Existing Variant sibling publication continues to ignore the boolean result while preserving its separate dirty ownership.

## Verification

Raw TLS tests cover mixed casing/OWS/comma lists, configured and forwarded close, exact-token substring rejection, one server-side close, and no pipelined second body/upstream operation. Dashboard tests cover stale same-ID/same-revision re-entry, current draft and beforeunload/navigation ownership, normal accepted cleanup and normalization, changed/cleared selection rejection, authoritative remount, and dirty Variant siblings.
