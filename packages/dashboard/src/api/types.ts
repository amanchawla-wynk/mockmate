export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ApiErrorResponse {
  code: string;
  message: string;
  path?: string;
  details?: unknown;
  recovery?: string;
  requestId: string;
}

export type MatchExpression =
  | { operator: 'equals'; value: string }
  | { operator: 'glob'; value: string };

export type AppStateMode = 'enabled' | 'disabled';
export type EndpointMode = 'mock' | 'passthrough';

export interface Project {
  schemaVersion: 4;
  id: string;
  name: string;
  description?: string;
  appStateMode: AppStateMode;
  activeStateId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSummary = Pick<
  Project,
  'id' | 'name' | 'description' | 'revision' | 'updatedAt'
>;

export interface WorkspaceState {
  schemaVersion: 4;
  activeProjectId?: string;
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

export interface TrafficVariantProvenance {
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

export type ResponseHeaderValue = string | string[];
export type ResponseHeaders = Record<string, ResponseHeaderValue>;

export interface ResponseVariant {
  id: string;
  endpointId: string;
  name: string;
  description?: string;
  status: number;
  responseHeaders: ResponseHeaders;
  bodyAssetId?: string;
  delayMs?: number;
  trafficProvenance?: TrafficVariantProvenance[];
  revision: number;
}

export type ResponseVariantSummary = Pick<
  ResponseVariant,
  'id' | 'name' | 'status' | 'delayMs' | 'revision'
> & { hasBody: boolean };

export interface EndpointDetail {
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

export interface AppStateReferenceSummary {
  id: string;
  name: string;
  revision: number;
}

export interface VariantReplacementSummary {
  id: string;
  name: string;
  revision: number;
}

export interface EndpointDeletionImpact {
  endpointId: string;
  endpointRevision: number;
  affectedStates: AppStateReferenceSummary[];
}

export interface VariantDeletionImpact {
  endpointId: string;
  endpointRevision: number;
  variantId: string;
  variantRevision: number;
  isFallback: boolean;
  affectedStates: AppStateReferenceSummary[];
  replacementVariants: VariantReplacementSummary[];
}

export interface AppState {
  schemaVersion: 4;
  id: string;
  projectId: string;
  name: string;
  description?: string;
  tags: string[];
  expectedUi?: string;
  bindings: Record<string, string>;
  revision: number;
}

export interface AppStateSummary extends Pick<
  AppState,
  'id' | 'projectId' | 'name' | 'tags' | 'revision'
> {
  boundEndpointCount: number;
  totalEndpointCount: number;
}

export interface BodyAsset {
  schemaVersion: 4;
  id: string;
  mediaType: string;
  size: number;
  encoding?: string;
  createdAt: string;
}

export interface RepositoryDiagnostic {
  severity: 'warning' | 'blocking';
  code: string;
  file: string;
  path?: string;
  message: string;
  recovery: string;
  projectId?: string;
  requestId?: string;
}

export type ProjectPatch = Partial<Pick<Project, 'name'>> & {
  description?: string | null;
};
export type EndpointPatch = Partial<Pick<EndpointDetail, 'name' | 'baseUrl' | 'matcher' | 'defaultVariantId'>> & {
  description?: string | null;
};
export type VariantPatch = Partial<Pick<ResponseVariant, 'name' | 'status' | 'responseHeaders'>> & {
  description?: string | null;
  bodyAssetId?: string | null;
  delayMs?: number | null;
};
export type AppStatePatch = Partial<Pick<AppState, 'name' | 'tags' | 'bindings'>> & {
  description?: string | null;
  expectedUi?: string | null;
};
export interface RuntimeSettingsUpdateInput {
  interceptHosts: string[];
  captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean;
  expectedRevision: number;
  confirmInterceptAll?: true;
}
export type CreateProjectInput = Pick<Project, 'name'> & Pick<Partial<Project>, 'description'>;
export type CreateVariantInput = Omit<ResponseVariant, 'id' | 'endpointId' | 'revision'>;
export type CreateEndpointInput = Omit<
  EndpointDetail,
  'schemaVersion' | 'id' | 'projectId' | 'revision' | 'variants' | 'defaultVariantId'
> & { variants?: CreateVariantInput[]; defaultVariantIndex?: number };
export type CreateAppStateInput = Omit<AppState, 'schemaVersion' | 'id' | 'projectId' | 'revision'>;

export interface StateSelectionInput {
  activeStateId?: string | null;
}

export type ResolutionSource = 'project_active_state' | 'endpoint_default';
export type FallbackReason =
  | 'app_state_mode_disabled'
  | 'active_state_unbound';

export type TrafficBodyDescriptor =
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
    reason:
      | 'raw_capture_disabled'
      | 'sidecar_limit'
      | 'queue_saturated'
      | 'temporary_budget_exceeded'
      | 'retained_budget_exceeded'
      | 'capture_io_failed'
      | 'stream_cancelled'
      | 'body_unobservable';
  };

export interface TrafficPreview {
  encoding: 'utf8' | 'base64';
  value: string;
  truncated: boolean;
}

export interface TrafficEndpointEvidence {
  id: string;
  name: string;
  specificity: number;
  mode: EndpointMode;
}

export interface TrafficAppStateContext {
  mode: AppStateMode;
  activeStateId?: string;
  selectedStateId?: string;
  resolutionSource?: ResolutionSource;
  fallbackReasons: FallbackReason[];
}

export interface TrafficPromotionReview {
  expectedTrafficGeneration: string;
  expectedResponseIdentity: string;
  request: {
    origin: string;
    method: string;
    path: string;
    query: Array<{ name: string; value: string }>;
    headers: Array<readonly [string, string]>;
    sensitiveQueryNames: string[];
  };
  response: {
    status: number;
    headers: Array<readonly [string, string]>;
    mediaType: string;
    contentEncoding?: string;
    byteCount: number;
    sha256: string;
    sensitiveHeaderNames: string[];
  };
  endpoint:
    | { action: 'create'; targetMode: 'mock' }
    | {
      action: 'reuse';
      endpointId: string;
      expectedRevision: number;
      currentMode: EndpointMode;
      targetMode: 'mock';
    };
  variant:
    | { action: 'create'; deterministicName: string }
    | { action: 'reuse'; variantId: string };
  state:
    | { action: 'unbound' }
    | { action: 'bind'; stateId: string; expectedRevision: number };
  defaultStateId?: string;
  warnings: Array<
    | 'media_type_defaulted'
    | 'sensitive_query_values_persisted'
    | 'sensitive_response_headers_persisted'
  >;
}

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

export interface TrafficSummary {
  id: string;
  generation: string;
  projectId: string;
  requestId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  transport: 'direct' | 'plain_http_proxy' | 'https_mitm';
  allowlistPattern: string;
  origin: string;
  method: string;
  path: string;
  queryNames: Array<{ name: string; occurrenceCount: number; sensitive: boolean }>;
  endpoint?: TrafficEndpointEvidence;
  decision:
    | 'mock'
    | 'endpoint_passthrough'
    | 'no_match_passthrough'
    | 'direct_miss'
    | 'direct_passthrough_unavailable'
    | 'failure';
  routingReason?: 'query_parse_invalid';
  status: number;
  responseBytes: number;
  requestBodyState: TrafficBodyDescriptor['state'];
  responseBodyState: TrafficBodyDescriptor['state'];
}

export interface TrafficDetail extends TrafficSummary {
  request: {
    query: Array<{ name: string; value: string }>;
    headers: Array<readonly [string, string]>;
    preview?: TrafficPreview;
    body: TrafficBodyDescriptor;
  };
  response: {
    headers: Array<readonly [string, string]>;
    preview?: TrafficPreview;
    body: TrafficBodyDescriptor;
  };
  appState: TrafficAppStateContext;
  variantId?: string;
  bodyAssetId?: string;
  upstream?: { status?: number; failure?: { code: string; message: string } };
  captureState: 'pending' | 'complete';
  promotion:
    | {
      state: 'blocked';
      reason:
        | 'body_unavailable'
        | 'body_truncated'
         | 'body_evicted'
         | 'invalid_content_encoding'
         | 'query_parse_invalid'
         | 'request_failed'
         | 'request_cancelled';
    }
    | { state: 'eligible'; review: TrafficPromotionReview }
    | { state: 'promoted'; result: TrafficPromotionResult };
}

export interface TrafficQuery { afterId?: string; beforeId?: string; limit?: number }
export interface TrafficPage {
  entries: TrafficSummary[];
  latestId?: string;
  hasMore: boolean;
  reset?: boolean;
}

export interface StaticFileEntry {
  path: string;
  size: number;
  mediaType: string;
}

export type ImportSourceType = 'curl' | 'postman';
export type ImportSource =
  | { type: 'curl'; text: string }
  | { type: 'postman'; collection: unknown };

export interface ImportPreviewRequest {
  source: ImportSource;
  variables?: Record<string, string>;
}

export type ImportActionName = 'create' | 'merge' | 'skip';
export type ImportAction =
  | { itemId: string; action: 'create'; confirmOverlap?: boolean }
  | { itemId: string; action: 'merge'; endpointId: string }
  | { itemId: string; action: 'skip' };

export interface ImportCommitRequest extends ImportPreviewRequest {
  snapshotToken: string;
  selectedItemIds: string[];
  actions: ImportAction[];
}

export type ImportSourceLocation =
  | { type: 'curl'; commandIndex: number }
  | { type: 'postman'; itemPath: number[] };

export interface ImportMessage {
  code: string;
  message: string;
  memberId?: string;
}

export interface ImportRequestField {
  name: string;
  value: string;
}

export interface ImportRequestSummary {
  scheme?: string;
  hostname?: string;
  port?: string;
  userInfo?: string;
  query: ImportRequestField[];
  headers: ImportRequestField[];
  auth?: { type: string; fields: ImportRequestField[] };
  body?: { mediaType?: string; byteCount: number; omitted: true };
}

export interface ImportResponseSummary {
  name: string;
  status: number;
  responseHeaders: ResponseHeaders;
  body: { kind: 'none' } | { kind: 'sha256'; sha256: string; byteCount: number };
  identity: string;
}

export interface ImportExactTarget {
  endpointId: string;
  endpointRevision: number;
  name: string;
  newVariantCount: number;
  candidateResponses: ImportResponseSummary[];
}

export interface ImportOverlap {
  endpointId?: string;
  itemId?: string;
  baseUrl: string;
  matcher: EndpointDetail['matcher'];
  relativeSpecificity: 'more-specific' | 'less-specific' | 'equal';
  confirmationRequired: boolean;
}

export interface ImportPreviewItem {
  id: string;
  memberIds: string[];
  locations: ImportSourceLocation[];
  breadcrumbs: string[][];
  name: string;
  description?: string;
  baseUrl: string;
  matcher: EndpointDetail['matcher'];
  requests: ImportRequestSummary[];
  responses: ImportResponseSummary[];
  proposedAction: ImportActionName;
  allowedActions: ImportActionName[];
  exactTargets: ImportExactTarget[];
  overlaps: ImportOverlap[];
  warnings: ImportMessage[];
  errors: ImportMessage[];
  selectedByDefault: boolean;
  createEffect: { createsEndpoint: boolean; createsVariants: number };
}

export interface ImportUnresolvedMember {
  id: string;
  location: ImportSourceLocation;
  breadcrumb: string[];
  name: string;
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface ImportVariableRequirement {
  name: string;
  memberIds: string[];
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

export type ImportPreviewData = Omit<ImportPreview, 'snapshotToken'>;

export interface ImportCommitResult {
  createdEndpointIds: string[];
  updatedEndpointIds: string[];
  createdVariantIds: string[];
  skippedItemIds: string[];
}
