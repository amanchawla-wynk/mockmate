import type { EndpointMatcherInput, ResponseHeaders } from '../domain/model';

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

export interface CanonicalImportRequest {
  baseUrl: string;
  matcher: EndpointMatcherInput;
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
  matcher: EndpointMatcherInput;
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
  matcher: EndpointMatcherInput;
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

export interface NormalizedImportResponse {
  name: string;
  status: number;
  responseHeaders: ResponseHeaders;
  body?: Buffer;
  identity: string;
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface PlannedImportResponse {
  summary: ImportResponseSummary;
  body?: Buffer;
}

export interface PlannedImportItem {
  preview: ImportPreviewItem;
  canonicalRequest: CanonicalImportRequest;
  createResponses: PlannedImportResponse[];
  mergeResponsesByEndpointId: ReadonlyMap<string, PlannedImportResponse[]>;
}

export interface ImportPlan {
  preview: ImportPreviewData;
  items: PlannedImportItem[];
}

export interface NormalizedImportMember {
  provisionalId: string;
  location: ImportSourceLocation;
  breadcrumb: string[];
  name: string;
  description?: string;
  disabled: boolean;
  supportedMethod: boolean;
  canonicalRequest?: CanonicalImportRequest;
  request: ImportRequestSummary;
  responses: NormalizedImportResponse[];
  unresolvedVariables: string[];
  warnings: ImportMessage[];
  errors: ImportMessage[];
}

export interface ParsedImportSource {
  sourceType: ImportSourceType;
  members: NormalizedImportMember[];
  warnings: ImportMessage[];
}
