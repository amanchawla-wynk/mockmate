import type { ValidationFinding } from './validation';

export type SchemaVersion = 4;
export type AppStateMode = 'enabled' | 'disabled';
export type EndpointMode = 'mock' | 'passthrough';

export type MatchExpression =
  | { operator: 'equals'; value: string }
  | { operator: 'glob'; value: string };

export interface Project {
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

export type ResponseHeaderValue = string | string[];
export type ResponseHeaders = Record<string, ResponseHeaderValue>;

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

export interface EndpointMatcherInput {
  method: string;
  path: string;
  query?: Record<string, MatchExpression[]>;
  headers?: Record<string, MatchExpression>;
}

export interface EndpointDetail {
  schemaVersion: 4;
  id: string;
  projectId: string;
  name: string;
  description?: string;
  baseUrl: string;
  matcher: EndpointMatcherInput;
  mode: EndpointMode;
  defaultVariantId?: string;
  variants: ResponseVariant[];
  revision: number;
}

export interface AppState {
  schemaVersion: SchemaVersion;
  id: string;
  projectId: string;
  name: string;
  description?: string;
  tags: string[];
  expectedUi?: string;
  bindings: Record<string, string>;
  revision: number;
}

export interface BodyAsset {
  schemaVersion: SchemaVersion;
  id: string;
  mediaType: string;
  size: number;
  encoding?: string;
  createdAt: string;
}

export interface ProjectRuntimeSettings {
  schemaVersion: 4;
  projectId: string;
  interceptHosts: string[];
  captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean;
  revision: number;
}

export interface WorkspaceState {
  schemaVersion: SchemaVersion;
  activeProjectId?: string;
  revision: number;
}

export interface StaticFileSummary {
  path: string;
  size: number;
  mediaType: string;
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

export interface AppStateSummary extends Pick<
  AppState,
  'id' | 'projectId' | 'name' | 'tags' | 'revision'
> {
  boundEndpointCount: number;
  totalEndpointCount: number;
  missingEndpointIds: string[];
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

export interface GenerationPointer {
  schemaVersion: SchemaVersion;
  generationId: string;
}

export type ProjectSummary = Pick<
  Project,
  'id' | 'name' | 'description' | 'revision' | 'updatedAt'
>;

export interface RepositoryDiagnostics {
  diagnostics: RepositoryDiagnostic[];
}

export type ProjectPatch = Partial<Pick<Project, 'name'>> & {
  description?: string | null;
};

export type EndpointPatch = Partial<
  Pick<EndpointDetail, 'name' | 'baseUrl' | 'matcher' | 'defaultVariantId'>
> & { description?: string | null };

export type VariantPatch = Partial<
  Pick<ResponseVariant, 'name' | 'status' | 'responseHeaders'>
> & {
  description?: string | null;
  bodyAssetId?: string | null;
  delayMs?: number | null;
};

export type AppStatePatch = Partial<Pick<AppState, 'name' | 'tags' | 'bindings'>> & {
  description?: string | null;
  expectedUi?: string | null;
};

export type CreateProjectInput = Pick<Project, 'name'> &
  Pick<Partial<Project>, 'description'>;

export type EndpointCreateInput = {
  name: string;
  description?: string;
  baseUrl: string;
  matcher: EndpointMatcherInput;
  mode: EndpointMode;
  variants?: CreateVariantInput[];
  defaultVariantIndex?: number;
};

export type EndpointModeInput = { mode: EndpointMode; expectedRevision: number };
export type AppStateModeInput = {
  appStateMode: AppStateMode;
  expectedProjectRevision: number;
};
export type RuntimeSettingsUpdateInput = {
  interceptHosts: string[];
  captureRawTraffic: boolean;
  debugProvenanceHeaders: boolean;
  expectedRevision: number;
  confirmInterceptAll?: true;
};

export type CreateVariantInput = Omit<ResponseVariant, 'id' | 'endpointId' | 'revision'>;

export type CreateAppStateInput = Omit<
  AppState,
  'schemaVersion' | 'id' | 'projectId' | 'revision'
>;

export interface StateSelectionInput {
  activeStateId?: string | null;
  baseStateId?: string | null;
  allowFallback: boolean;
}

export interface RepositoryDiagnostic extends ValidationFinding {
  projectId?: string;
  requestId?: string;
}
