# Proxy Traffic Capture Research

**Date:** 2026-08-29  
**Status:** Research recommendation  
**Scope:** Proxyman, Charles, and open-source proxy patterns as inputs to MockMate's App State and Traffic workflow

## Executive Summary

MockMate should borrow the capture model of mature debugging proxies, but not their product model. Proxyman and Charles both separate the decision to decrypt selected HTTPS traffic from the tools that inspect, modify, map, or replay the resulting transactions. Proxyman documents include/exclude SSL rules and host/app/wildcard matching; Charles requires explicit SSL-proxy host selection and directly tunnels SSL when decryption is disabled ([Proxyman SSL Proxying](https://docs.proxyman.com/basic-features/ssl-proxying), [Charles SSL Proxying](https://www.charlesproxy.com/documentation/proxying/ssl-proxying/)). That separation is the most important pattern for MockMate.

MockMate already has the right product center: App State -> Endpoint -> Response Variant is deterministic control, while Traffic is evidence of what the device requested and what MockMate decided. The approved product design explicitly rejects competing as a general-purpose debugging proxy and makes named application state the differentiator ([local design](../superpowers/specs/2026-08-27-mockmate-reliable-core-design.md#competitive-position)).

The immediate implementation should therefore be small:

1. Treat `interceptHosts` as the capture and mock-resolution scope.
2. For a selected host, try the current deterministic mock resolution first.
3. If no Endpoint matches and passthrough is enabled, forward to the request's original origin and record the result. Do not require `project.baseUrl` for this path.
4. Record the active App State snapshot and the resolution or passthrough reason on every selected flow.
5. Keep promotion from Traffic explicit: the user chooses the target App State, and promotion uses the state's revision instead of silently changing whichever state happens to be active.

MockMate should not replace its proxy as part of that behavior change. Its current implementation is sufficient to prove the product workflow, although it intentionally advertises only HTTP/1.1 during intercepted TLS and uses a handwritten request parser ([proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L576-L593)). A separate Mockttp spike is the strongest later option because Mockttp is a TypeScript, Apache-2.0 proxy library whose public source already handles HTTP/1, HTTP/2, CONNECT, TLS interception/passthrough, WebSocket upgrades, body lifecycle events, and streaming passthrough ([Mockttp README](https://github.com/httptoolkit/mockttp#readme), [combo server source](https://github.com/httptoolkit/mockttp/blob/main/src/server/http-combo-server.ts), [server events source](https://github.com/httptoolkit/mockttp/blob/main/src/server/mockttp-server.ts), [passthrough source](https://github.com/httptoolkit/mockttp/blob/main/src/rules/requests/request-step-impls.ts), [Mockttp license](https://github.com/httptoolkit/mockttp/blob/main/LICENSE)).

## Method And Evidence Boundary

This note uses official product documentation, official repositories, source files, and repository license files. Product documentation can establish observable behavior and supported features. It cannot establish the proprietary internal architecture of Proxyman or Charles. Any proposed data model or implementation sequence below is a MockMate recommendation, not a claim about those products' internals.

The license discussion is engineering guidance, not legal advice. Before incorporating third-party source, distributing a combined work, or exposing a modified network service, obtain a project-specific legal review. Product ideas and protocol concepts are not a substitute for permission to copy protected source or UI expression.

## Shared Capture Model

The useful common model is a pipeline, not a traffic-table layout:

1. **Select scope.** Decide which connections are eligible for HTTPS decryption. Proxyman exposes include/exclude rules by app, domain, and wildcard. Charles exposes an SSL Proxying host list and allows `*` for all hosts ([Proxyman SSL Proxying](https://docs.proxyman.com/basic-features/ssl-proxying), [Charles SSL Proxying](https://www.charlesproxy.com/documentation/proxying/ssl-proxying/)).
2. **Establish trust and terminate selected TLS.** Both products document installing and trusting their root certificate so selected HTTPS can be decrypted; Charles additionally documents dynamically generating a server certificate signed by its root ([Proxyman iOS device setup](https://docs.proxyman.com/debug-devices/ios-device), [Charles SSL Proxying](https://www.charlesproxy.com/documentation/proxying/ssl-proxying/)).
3. **Represent the exchange as a flow.** Requests and responses remain linked as one inspectable transaction. Charles calls the retained collection a Session and states that recording stores requests and responses in the current Session ([Charles Recording](https://www.charlesproxy.com/documentation/using-charles/recording/)).
4. **Apply a decision.** A selected exchange may continue unchanged, pause for an edit, return a local response, change destination, or undergo a rule-based rewrite. Both products document these categories through Breakpoint and mapping tools ([Proxyman Breakpoint](https://docs.proxyman.com/advanced-features/breakpoint), [Proxyman Map Local](https://docs.proxyman.com/advanced-features/map-local), [Proxyman Map Remote](https://docs.proxyman.com/advanced-features/map-remote), [Charles Breakpoints](https://www.charlesproxy.com/documentation/proxying/breakpoints/), [Charles Map Local](https://www.charlesproxy.com/documentation/tools/map-local/), [Charles Map Remote](https://www.charlesproxy.com/documentation/tools/map-remote/)).
5. **Retain evidence independently of forwarding.** Charles explicitly documents that disabling recording still passes requests through normally, but omits them from the Session ([Charles Recording](https://www.charlesproxy.com/documentation/using-charles/recording/)). This is a useful conceptual separation even if MockMate initially records all selected flows.
6. **Act from evidence.** Repeating a captured request or creating a local mapping begins from an observed transaction. Charles Repeat resends a selected request and shows the new response; Proxyman Map Local can initialize a rule from a request's current response ([Charles Repeat](https://www.charlesproxy.com/documentation/tools/repeat/), [Proxyman Map Local](https://docs.proxyman.com/advanced-features/map-local)).

For MockMate, this becomes four independent concepts:

- **Capture policy:** which traffic is decrypted and observable.
- **Resolution policy:** whether an Endpoint and App State produce a deterministic mock.
- **Forwarding policy:** what happens when selected traffic has no mock match.
- **Evidence retention:** what metadata and body content are kept, for how long, and with what redaction.

Conflating these concepts is the source of the current `baseUrl` and `captureRawTraffic` ambiguity.

## Proxyman

### Documented Behavior

Proxyman's SSL Proxying List defines include and exclude rules, supports app/domain/wildcard selection, and requires the Proxyman certificate before HTTPS interception ([SSL Proxying](https://docs.proxyman.com/basic-features/ssl-proxying)). Its iOS setup is an explicit-proxy workflow: configure the Wi-Fi HTTP proxy, install the root certificate, and explicitly trust it in iOS Certificate Trust Settings ([iOS device setup](https://docs.proxyman.com/debug-devices/ios-device)).

Its intervention tools are separated by intent:

- Breakpoint pauses a matched request and/or response, permits edits to URL, method, headers, query, body, and response status, and lets the user execute, abort, or cancel ([Breakpoint](https://docs.proxyman.com/advanced-features/breakpoint)).
- Map Local returns status, headers, and body from an HTTP message or local file for a matched request ([Map Local](https://docs.proxyman.com/advanced-features/map-local)).
- Map Remote changes protocol, host, port, path, or query and transparently serves the response from the new destination; it documents HTTP/HTTPS and WebSocket destination mapping ([Map Remote](https://docs.proxyman.com/advanced-features/map-remote)).
- Scripting exposes request and response mutation hooks, can implement Map Local, Map Remote, or automated breakpoint-like behavior, and can run as a Mock API without contacting the upstream server ([Scripting](https://docs.proxyman.com/scripting/script)).

### Lessons For MockMate

The strongest lesson is progressive disclosure. Host scope and certificate trust are setup concerns; capture inspection is an evidence concern; local response mapping is a deterministic behavior concern; arbitrary scripts are an advanced extension concern. MockMate should keep those layers visibly separate.

Proxyman's Map Local interaction also supports a narrow Traffic-to-Mock flow: start from a real response, then edit the resulting rule. MockMate should adapt the action to its own domain by asking for an App State target and showing the Endpoint/Variant that will be created. It should not reproduce Proxyman's generic rule taxonomy or scripting workbench.

### Proprietary Unknowns

The cited Proxyman documentation describes behavior, not the implementation of its protocol parser, certificate cache, stream backpressure, persistence schema, event ordering, body storage, or crash recovery. No conclusions about those internals should be drawn from the UI or feature names. In particular, documented WebSocket mapping or scripting features do not reveal a reusable architecture.

## Charles

### Documented Behavior

Charles makes the TLS boundary explicit: selected hosts are decrypted by a generated certificate signed by the Charles root, while SSL Proxying turned off directly forwards encrypted traffic to the target server ([SSL Proxying](https://www.charlesproxy.com/documentation/proxying/ssl-proxying/)). Recording is separately controllable; when it is off, requests still pass through but are not retained in the Session ([Recording](https://www.charlesproxy.com/documentation/using-charles/recording/)).

Charles's tools provide a stable vocabulary for intervention:

- Breakpoints match protocol/host/port/path patterns and pause request, response, or both for execute, abort, or cancel ([Breakpoints](https://www.charlesproxy.com/documentation/proxying/breakpoints/)).
- Map Local transparently serves a matching local file and falls back to the real website when that local file is absent ([Map Local](https://www.charlesproxy.com/documentation/tools/map-local/)).
- Map Remote transparently changes the request destination and supports HTTP-to-HTTPS or HTTPS-to-HTTP mappings ([Map Remote](https://www.charlesproxy.com/documentation/tools/map-remote/)).
- Rewrite applies location-scoped operations to headers, URL parts, query parameters, and bodies on requests and/or responses ([Rewrite](https://www.charlesproxy.com/documentation/tools/rewrite/)).
- Repeat resends a selected request inside Charles and records the resulting response as a new request ([Repeat](https://www.charlesproxy.com/documentation/tools/repeat/)).

### Lessons For MockMate

Charles supplies two useful negative-space lessons. First, forwarding and recording are independent. Second, a transaction can remain immutable evidence while a tool action creates a new request or mapping. MockMate should similarly avoid converting a Traffic row in place or making a captured response itself the mutable source of truth.

The Map Local fallback is not a behavior MockMate should copy literally. MockMate's fallback must remain explicit and observable because an App State is a deterministic contract. A missing body asset or incomplete state binding should produce provenance or a controlled error, not silently switch to a real backend.

### Proprietary Unknowns

The cited Charles documentation does not expose its internal flow model, parser boundaries, persistence format implementation, body storage strategy, concurrency model, or certificate lifecycle. Session and transaction terminology should be treated as product concepts only. Charles source is not an implementation input to this recommendation.

## Ranked Open-Source Candidates

The ranking is a MockMate fit assessment, not an upstream quality claim.

| Rank | Candidate | Evidence | MockMate fit | Recommendation |
| --- | --- | --- | --- | --- |
| 1 | Mockttp | Its README describes a JavaScript proxy for interception, inspection, rewriting, HTTPS, and transparent proxying. Source implements a combined HTTP/HTTPS/HTTP2 server, H1/H2 CONNECT, TLS intercept-only/passthrough lists, WebSocket events, staged request/response body events, and streaming passthrough ([README](https://github.com/httptoolkit/mockttp#readme), [combo server](https://github.com/httptoolkit/mockttp/blob/main/src/server/http-combo-server.ts), [server](https://github.com/httptoolkit/mockttp/blob/main/src/server/mockttp-server.ts), [passthrough](https://github.com/httptoolkit/mockttp/blob/main/src/rules/requests/request-step-impls.ts)). It is Apache-2.0 ([LICENSE](https://github.com/httptoolkit/mockttp/blob/main/LICENSE)). | Same language/runtime as MockMate and directly addresses its protocol/lifecycle gaps. It is still a substantial behavioral dependency. | Run a bounded spike after the near-term workflow fix. Do not migrate first. |
| 2 | node-http-mitm-proxy | The official README documents generated certificates, request/response chunk hooks, stream filters, and WebSocket lifecycle hooks. Its embedded license text is MIT ([README and license](https://github.com/joeferner/node-http-mitm-proxy#readme)). | Smaller Node surface and useful hook examples, but the documented API does not establish HTTP/2 support. | Use as a pattern reference or fallback prototype, not the leading integration candidate. |
| 3 | mitmproxy | Official docs list HTTP/1, HTTP/2, HTTP/3, WebSocket, TCP, UDP, and DNS support with explicit limitations; event hooks separate headers, completed bodies, response, error, TLS, WebSocket, TCP, and UDP lifecycles ([protocols](https://docs.mitmproxy.org/stable/concepts/protocols/), [event hooks](https://docs.mitmproxy.org/stable/api/events.html)). It is MIT ([LICENSE](https://github.com/mitmproxy/mitmproxy/blob/main/LICENSE)). | Strongest protocol and flow reference, but integration introduces Python and a process/API boundary into the TypeScript server. | Borrow lifecycle and filter concepts. Consider an external-engine experiment only if Mockttp fails acceptance criteria. |
| 4 | AnyProxy | The repository describes a configurable Node HTTP/HTTPS proxy and is Apache-2.0 ([README](https://github.com/alibaba/anyproxy#readme), [LICENSE](https://github.com/alibaba/anyproxy/blob/master/LICENSE)). Its recorder stores transaction metadata separately from response-body and WebSocket-message files ([recorder source](https://github.com/alibaba/anyproxy/blob/master/lib/recorder.js)). The latest repository commit returned by GitHub's official API is dated 2020-06-18 ([latest commit API](https://api.github.com/repos/alibaba/anyproxy/commits?per_page=1)). | The body-sidecar pattern is relevant, but the maintenance signal makes direct adoption high risk. | Borrow the metadata/body separation concept only. |
| 5 | HTTP Toolkit UI/server | The official READMEs describe a React web UI over a local server, with Mockttp performing interception; both repositories use AGPL-3.0-or-later ([UI README](https://github.com/httptoolkit/httptoolkit-ui#readme), [server README](https://github.com/httptoolkit/httptoolkit-server#readme), [UI LICENSE](https://github.com/httptoolkit/httptoolkit-ui/blob/main/LICENSE), [server LICENSE](https://github.com/httptoolkit/httptoolkit-server/blob/main/LICENSE)). | Useful proof that a web UI can sit above a local proxy engine, but it is a product architecture and copyleft codebase, not a drop-in library. | Study behavior and boundaries. Do not copy code or UI without a specific license/compliance decision. Use Apache-2.0 Mockttp directly if selected. |

## Adoptable Source Patterns

### 1. Protocol Dispatch As An Engine Boundary

Mockttp's combo server centralizes protocol recognition and dispatch: HTTP and TLS can share one port; ALPN selects HTTP/1 or HTTP/2; H1 and H2 CONNECT are reintroduced to the server as connections; TLS host patterns choose interception or passthrough; unknown protocols can have a distinct passthrough path ([http-combo-server.ts](https://github.com/httptoolkit/mockttp/blob/main/src/server/http-combo-server.ts)). MockMate should adopt the boundary, not copy the file: a proxy engine should emit normalized lifecycle events and should not know about App States, Endpoints, or Variants.

### 2. Explicit Lifecycle Events

Mockttp exposes initiated request, request body data, completed request, initiated response, response body data, completed response, abort, TLS errors, TLS passthrough, and WebSocket events ([mockttp-server.ts](https://github.com/httptoolkit/mockttp/blob/main/src/server/mockttp-server.ts)). Mitmproxy independently validates the same shape: request headers and complete request are separate; response headers and complete response are separate; each HTTP flow ends in either `response` or `error`; other protocols have their own start/message/end/error hooks ([mitmproxy event hooks](https://docs.mitmproxy.org/stable/api/events.html)).

MockMate should define its own small event contract around those stages. That would eliminate ad hoc logging differences between generated mock responses, forwarded HTTPS, plain HTTP, aborts, and future WebSockets.

### 3. Stream First, Buffer Deliberately

Mockttp's passthrough implementation pipes request and response streams when no body transformation requires buffering, while buffering only for callbacks or body rewrites ([request-step-impls.ts](https://github.com/httptoolkit/mockttp/blob/main/src/rules/requests/request-step-impls.ts)). MockMate should retain bounded previews as a subscriber to the stream, not make full buffering the capture abstraction. This is especially important for its streaming-UI domain.

### 4. Summary Metadata Separate From Bodies

AnyProxy's recorder normalizes request/response metadata into a datastore and writes response bodies and WebSocket messages to separate files ([recorder.js](https://github.com/alibaba/anyproxy/blob/master/lib/recorder.js)). MockMate's exact storage should use its own validated schemas and Body Asset conventions, but the separation is sound: list queries should not load body payloads.

### 5. Composable Filters Over Immutable Flows

Mitmproxy's documented filter expressions compose protocol, method, URL, domain, status, headers, body, source, destination, replay, and error predicates with boolean operators ([filter expressions](https://docs.mitmproxy.org/stable/concepts/filters/)). MockMate does not need that language now. It should first ensure Traffic fields are stable and immutable enough that later filters can be pure predicates rather than hidden mutation rules.

### 6. Portable Flow Serialization Is A Separate Concern

Mitmproxy's `FlowWriter` serializes a flow's state, `FlowReader` migrates and reconstructs flow state, and `FilteredFlowWriter` applies a filter before writing ([io.py](https://github.com/mitmproxy/mitmproxy/blob/main/mitmproxy/io/io.py)). This supports a later distinction between a portable captured-flow artifact and MockMate's canonical state-and-failure bundle. A Traffic export should not become the domain model.

## Current MockMate Fit

### What Already Aligns

- `interceptHosts` is a real allowlist with exact and wildcard matching, excludes MockMate's own local addresses, and is read by both CONNECT selection and request resolution ([intercept.ts](../../packages/server/src/services/intercept.ts#L16-L58), [proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L469-L476), [proxy-handler.ts](../../packages/server/src/services/proxy-handler.ts#L95-L108)).
- Selected HTTPS connections are terminated with a MockMate certificate; non-selected connections are blind-tunnelled to their original host and port ([proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L543-L593), [proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L738-L767)).
- Resolution is mock-first. The repository matches an Endpoint and then applies active-state, base-state, and endpoint-default fallback in a deterministic order with provenance ([project-repository.ts](../../packages/server/src/repository/project-repository.ts#L1806-L1810), [compile-project.ts](../../packages/server/src/repository/compile-project.ts#L357-L405)).
- Mock responses record project, selected state, Endpoint, Variant, resolution source, fallback reasons, body asset, request details, response details, duration, and size ([proxy-handler.ts](../../packages/server/src/services/proxy-handler.ts#L117-L146), [types.ts](../../packages/server/src/types.ts#L25-L53)).
- Traffic APIs are project-scoped, return summaries separately from detail, support bounded pagination, and permit explicit state ID plus expected state revision during promotion ([traffic.ts](../../packages/server/src/routes/admin/traffic.ts#L20-L43), [traffic.ts](../../packages/server/src/routes/admin/traffic.ts#L72-L101)).
- Promotion creates or reuses an Endpoint/Variant and only updates an App State when an explicit state target is supplied; the state revision is checked before binding ([project-repository.ts](../../packages/server/src/repository/project-repository.ts#L1559-L1589), [project-repository.ts](../../packages/server/src/repository/project-repository.ts#L1599-L1664)).

### Gaps And Inconsistencies

1. **Selected unmatched traffic depends on `baseUrl` even though forwarding does not use it.** The handler returns no result unless both `passthroughEnabled` and `project.baseUrl` are present, then calls `forwardRequest` with the original scheme, host, and port ([proxy-handler.ts](../../packages/server/src/services/proxy-handler.ts#L147-L150)). This couples forwarding permission to unrelated project metadata.
2. **Non-selected HTTPS is opaque and unrecorded.** The CONNECT handler immediately blind-tunnels it, so MockMate cannot produce HTTP-level Traffic entries for it ([proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L570-L574), [proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L738-L767)). This is acceptable if `interceptHosts` is explicitly defined as capture scope.
3. **Plain HTTP has different fallback semantics.** If `resolveProxyRequest` returns `null`, the plain HTTP path directly forwards to the original host even when the host was not selected, and that fallback is not logged by the Traffic logger ([proxy-server.ts](../../packages/server/src/services/proxy-server.ts#L851-L895)). The product needs one documented rule for whether capture scope applies to plain HTTP as well as HTTPS.
4. **Traffic is process memory, not a session store.** Entries live in a module-level array, default to the latest 500, and retain 16 KiB request/response previews; process restart loses them ([logger.ts](../../packages/server/src/services/logger.ts#L11-L20), [logger.ts](../../packages/server/src/services/logger.ts#L45-L75), [logger.ts](../../packages/server/src/services/logger.ts#L100-L128)).
5. **`captureRawTraffic` has no capture semantics.** It is persisted with runtime settings and shown as a dashboard checkbox ([project-repository.ts](../../packages/server/src/repository/project-repository.ts#L1313-L1320), [project-repository.ts](../../packages/server/src/repository/project-repository.ts#L1419-L1432), [PassthroughSettings.tsx](../../packages/dashboard/src/components/PassthroughSettings.tsx#L51-L68)), but neither current proxy capture path reads it ([proxy-server.ts](../../packages/server/src/services/proxy-server.ts), [proxy-handler.ts](../../packages/server/src/services/proxy-handler.ts)).
6. **The dashboard's promotion action omits state.** The API supports an explicit state and revision, but the current `Mock This` button calls promotion with only project ID and log ID ([TrafficView.tsx](../../packages/dashboard/src/components/TrafficView.tsx#L404-L425), [traffic.ts](../../packages/server/src/routes/admin/traffic.ts#L89-L100)). The resulting Endpoint/Variant is therefore not bound to an App State.
7. **Passthrough provenance is thinner than mock provenance.** A forwarded entry records `proxiedReason: 'no_endpoint_match'`, but not the active/base App State snapshot considered at request time or the reason passthrough was allowed ([proxy-handler.ts](../../packages/server/src/services/proxy-handler.ts#L152-L167), [types.ts](../../packages/server/src/types.ts#L25-L53)).

## Recommended Conceptual Model

The model should remain internal and small until persistence requirements are proven.

```ts
interface CapturePolicy {
  projectId: string;
  interceptHosts: string[];
  recordSelectedTraffic: boolean;
  bodyMode: 'metadata' | 'preview' | 'full';
}

interface FlowContext {
  flowId: string;
  projectId: string;
  startedAt: string;
  activeStateSnapshot?: { id: string; revision: number };
  baseStateSnapshot?: { id: string; revision: number };
  request: CapturedRequest;
}

type ResolutionDecision =
  | {
      kind: 'mock';
      endpointId: string;
      variantId: string;
      resolutionSource: ResolutionSource;
      fallbackReasons: FallbackReason[];
    }
  | {
      kind: 'passthrough';
      reason: 'no_endpoint_match';
      destination: { scheme: 'http' | 'https'; host: string; port: number };
    }
  | {
      kind: 'rejected';
      reason: 'passthrough_disabled' | 'no_active_project' | 'invalid_request';
    };

interface PromotionIntent {
  flowId: string;
  targetStateId: string;
  expectedStateRevision: number;
}
```

Key invariants:

- Capture selection happens before mock resolution.
- The active and base App State values are snapshotted at request start. A later UI state change does not rewrite historical evidence.
- Every selected flow ends with one decision and one terminal outcome: completed, rejected, aborted, or failed.
- Passthrough uses the original request destination unless a future, explicit destination mapping says otherwise.
- A Traffic entry is immutable evidence. Promotion creates domain objects and records their IDs as a separate action result.
- Promotion always names a target App State and uses optimistic concurrency. It never infers a mutable target at write time.
- Request and response bodies are optional attachments. List and filter operations use metadata.

## What Not To Copy

- Do not recreate a general-purpose Breakpoint, Rewrite, scripting, or arbitrary Map Remote workbench. Proxyman and Charles already cover those categories; MockMate's approved direction is deterministic UI state and streaming failure simulation ([local design](../superpowers/specs/2026-08-27-mockmate-reliable-core-design.md#what-not-to-copy)).
- Do not make Traffic the primary navigation model. Traffic is evidence supporting the state-first model.
- Do not silently fall through to a real backend when a selected App State is incomplete or a body asset is unavailable.
- Do not equate SSL pinning failure with a feature to bypass. Provide diagnostics and an explicit non-intercepted path; do not add pinning-bypass or DRM-circumvention behavior.
- Do not copy proprietary UI layouts, icons, text, session formats, or undocumented behavior from Proxyman or Charles.
- Do not copy AGPL HTTP Toolkit UI/server code into MockMate without a deliberate compliance decision. If the proxy spike succeeds, prefer the separately Apache-2.0 Mockttp library ([Mockttp LICENSE](https://github.com/httptoolkit/mockttp/blob/main/LICENSE), [HTTP Toolkit UI LICENSE](https://github.com/httptoolkit/httptoolkit-ui/blob/main/LICENSE), [HTTP Toolkit server LICENSE](https://github.com/httptoolkit/httptoolkit-server/blob/main/LICENSE)).
- Do not replace the current proxy merely to gain architectural neatness. Replace or wrap it only when a protocol/lifecycle acceptance test fails and the selected engine demonstrably passes.

## Recommendations

### Near Term

1. **Declare `interceptHosts` to be capture scope.** Update product copy so users know selected hosts are decrypted, eligible for mocks, forwarded when unmatched and allowed, and represented in Traffic. Non-selected HTTPS remains an opaque tunnel.
2. **Remove `project.baseUrl` from selected proxy passthrough eligibility.** Keep `passthroughEnabled` as the permission switch and forward to the original request origin already passed into `forwardRequest`.
3. **Unify selected-flow recording.** Create the Traffic context before Endpoint resolution and finalize it for mock success, passthrough success, upstream error, parse/rejection error, and client abort.
4. **Snapshot state provenance for passthrough.** Store active/base state IDs and revisions considered at request start even when no Endpoint matches. Keep `selectedStateId` for the state that actually supplied a Variant.
5. **Resolve `captureRawTraffic`.** For the first iteration, remove or relabel the inert checkbox rather than inventing unlimited full-body retention. Continue the current 16 KiB previews and accurate full sizes until a retention/redaction design exists.
6. **Make promotion explicit in the dashboard.** `Mock This` should open a small confirmation that shows method, host, path, response status/body truncation, proposed Endpoint/Variant, target App State, and expected state revision.
7. **Keep promotion loss-aware.** The server already refuses to create a body asset from a truncated response preview ([traffic.ts](../../packages/server/src/routes/admin/traffic.ts#L45-L69)). The UI should disclose that result before creation.
8. **Add behavior tests before any engine spike.** Cover selected mock hit, selected unmatched passthrough to original origin without `baseUrl`, selected unmatched with passthrough disabled, non-selected HTTPS blind tunnel, plain HTTP scope, state snapshot provenance, abort/error terminal events, and explicit state promotion conflict.

### Later

1. **Run a Mockttp spike behind MockMate's own engine interface.** Acceptance criteria should include HTTP/1.1 keep-alive and chunking, HTTP/2 downstream/upstream negotiation, H1/H2 CONNECT, WebSocket upgrade/messages, selected TLS passthrough events, request/response streaming with bounded previews, trailers, upstream aborts, client aborts, certificate generation/cache behavior, local-network device setup, and preservation of original destination/provenance. Mockttp source shows candidate support for these surfaces, but the spike must prove compatibility with MockMate's devices and tests ([combo server](https://github.com/httptoolkit/mockttp/blob/main/src/server/http-combo-server.ts), [server events](https://github.com/httptoolkit/mockttp/blob/main/src/server/mockttp-server.ts), [passthrough](https://github.com/httptoolkit/mockttp/blob/main/src/rules/requests/request-step-impls.ts)).
2. **Introduce disk-backed flow retention only with policy.** Define body limits, redaction, sensitive-header handling, project isolation, cleanup, crash recovery, and export semantics before enabling full capture.
3. **Add filters after the flow schema stabilizes.** Start with method, host/path, status, decision, App State snapshot, Endpoint/Variant, fallback reason, duration, size, and error. Boolean composition can follow the mitmproxy concept without copying its syntax ([mitmproxy filters](https://docs.mitmproxy.org/stable/concepts/filters/)).
4. **Add replay as a new evidence event.** A replay should reference its source flow and snapshot its own App State context; it should not overwrite the original transaction.
5. **Keep streaming-specific faults above the engine.** Segment failure, delayed playlist, truncated body, connection reset, and deterministic sequences are MockMate Response Variant behavior. The proxy engine supplies protocol-correct transport primitives, not the product semantics.

## Open Questions

1. Should `interceptHosts` select both HTTP and HTTPS capture, or only HTTPS decryption? The current plain HTTP fallback behaves differently.
2. When selected traffic has no Endpoint and passthrough is disabled, should the client receive the current generic 502, a deterministic MockMate error response, or a configurable failure Variant?
3. Should every flow snapshot both active and base state IDs/revisions, or snapshot a single compiled-project generation ID that can reconstruct them?
4. What request/response headers must be redacted before any disk-backed capture or export?
5. Is 16 KiB sufficient for near-term promotion, or should promotion be disabled whenever the response is truncated until full-body capture has a safe storage policy?
6. Should a promoted capture always require an App State, or should an explicit "Endpoint default only" option remain available?
7. Does `baseUrl` still have a distinct product role after original-origin passthrough is decoupled from it?
8. What devices and client libraries form the protocol acceptance matrix for the Mockttp spike, especially HTTP/2, WebSocket, HLS/DASH clients, and clients with certificate pinning?
9. Should non-selected tunnel open/close metadata appear as connection-level diagnostics without pretending that encrypted HTTP details were captured?
10. What retention boundary separates transient Traffic evidence from portable MockMate bundles and immutable Body Assets?

## Sources

### Official Product Documentation

- [Proxyman: SSL Proxying](https://docs.proxyman.com/basic-features/ssl-proxying)
- [Proxyman: iOS Device](https://docs.proxyman.com/debug-devices/ios-device)
- [Proxyman: Breakpoint](https://docs.proxyman.com/advanced-features/breakpoint)
- [Proxyman: Map Local](https://docs.proxyman.com/advanced-features/map-local)
- [Proxyman: Map Remote](https://docs.proxyman.com/advanced-features/map-remote)
- [Proxyman: Scripting](https://docs.proxyman.com/scripting/script)
- [Charles: SSL Proxying](https://www.charlesproxy.com/documentation/proxying/ssl-proxying/)
- [Charles: Recording](https://www.charlesproxy.com/documentation/using-charles/recording/)
- [Charles: Breakpoints](https://www.charlesproxy.com/documentation/proxying/breakpoints/)
- [Charles: Map Local](https://www.charlesproxy.com/documentation/tools/map-local/)
- [Charles: Map Remote](https://www.charlesproxy.com/documentation/tools/map-remote/)
- [Charles: Rewrite](https://www.charlesproxy.com/documentation/tools/rewrite/)
- [Charles: Repeat](https://www.charlesproxy.com/documentation/tools/repeat/)

### Official Repositories, Source, And Licenses

- [Mockttp repository](https://github.com/httptoolkit/mockttp)
- [Mockttp combo server](https://github.com/httptoolkit/mockttp/blob/main/src/server/http-combo-server.ts)
- [Mockttp server and lifecycle events](https://github.com/httptoolkit/mockttp/blob/main/src/server/mockttp-server.ts)
- [Mockttp passthrough implementation](https://github.com/httptoolkit/mockttp/blob/main/src/rules/requests/request-step-impls.ts)
- [Mockttp certificate implementation](https://github.com/httptoolkit/mockttp/blob/main/src/util/certificates.ts)
- [Mockttp Apache-2.0 license](https://github.com/httptoolkit/mockttp/blob/main/LICENSE)
- [HTTP Toolkit UI repository and architecture](https://github.com/httptoolkit/httptoolkit-ui)
- [HTTP Toolkit server repository and architecture](https://github.com/httptoolkit/httptoolkit-server)
- [HTTP Toolkit UI AGPL license](https://github.com/httptoolkit/httptoolkit-ui/blob/main/LICENSE)
- [HTTP Toolkit server AGPL license](https://github.com/httptoolkit/httptoolkit-server/blob/main/LICENSE)
- [mitmproxy protocols](https://docs.mitmproxy.org/stable/concepts/protocols/)
- [mitmproxy event hooks](https://docs.mitmproxy.org/stable/api/events.html)
- [mitmproxy filter expressions](https://docs.mitmproxy.org/stable/concepts/filters/)
- [mitmproxy flow I/O source](https://github.com/mitmproxy/mitmproxy/blob/main/mitmproxy/io/io.py)
- [mitmproxy MIT license](https://github.com/mitmproxy/mitmproxy/blob/main/LICENSE)
- [node-http-mitm-proxy repository, API, and embedded MIT license](https://github.com/joeferner/node-http-mitm-proxy)
- [AnyProxy repository](https://github.com/alibaba/anyproxy)
- [AnyProxy recorder source](https://github.com/alibaba/anyproxy/blob/master/lib/recorder.js)
- [AnyProxy Apache-2.0 license](https://github.com/alibaba/anyproxy/blob/master/LICENSE)
- [AnyProxy latest commit API](https://api.github.com/repos/alibaba/anyproxy/commits?per_page=1)

### MockMate Source And Design

- [Approved reliable-core design](../superpowers/specs/2026-08-27-mockmate-reliable-core-design.md)
- [Proxy server](../../packages/server/src/services/proxy-server.ts)
- [Proxy request resolution and forwarding](../../packages/server/src/services/proxy-handler.ts)
- [Host interception matching](../../packages/server/src/services/intercept.ts)
- [Traffic logger](../../packages/server/src/services/logger.ts)
- [Traffic provenance](../../packages/server/src/services/traffic-provenance.ts)
- [Traffic API and promotion](../../packages/server/src/routes/admin/traffic.ts)
- [Compiled request and App State resolution](../../packages/server/src/repository/compile-project.ts)
- [Project repository and capture promotion](../../packages/server/src/repository/project-repository.ts)
- [Traffic dashboard](../../packages/dashboard/src/components/TrafficView.tsx)
- [Proxy and passthrough settings](../../packages/dashboard/src/components/PassthroughSettings.tsx)
