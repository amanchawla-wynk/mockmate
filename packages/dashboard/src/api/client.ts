import type {
  ApiErrorResponse,
  AppState,
  AppStatePatch,
  AppStateSummary,
  BodyAsset,
  CreateAppStateInput,
  CreateEndpointInput,
  CreateProjectInput,
  CreateVariantInput,
  EndpointDetail,
  EndpointDeletionImpact,
  EndpointPatch,
  EndpointSummary,
  EndpointMode,
  AppStateMode,
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRequest,
  InterceptionGuidance,
  Project,
  ProjectPatch,
  ProjectRuntimeSettings,
  ProjectSummary,
  RepositoryDiagnostic,
  ResponseVariant,
  RuntimeSettingsUpdateInput,
  StateSelectionInput,
  StaticFileEntry,
  TrafficPage,
  TrafficDetail,
  TrafficPromotionInput,
  TrafficPromotionResult,
  TrafficQuery,
  VariantPatch,
  VariantDeletionImpact,
  WorkspaceState,
} from './types';

const API_BASE = '/api/admin';
const segment = (id: string) => encodeURIComponent(id);

export class ApiClientError extends Error {
  readonly name = 'ApiClientError';
  readonly currentRevision?: number;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly path?: string;
  readonly details?: unknown;
  readonly recovery?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    path?: string,
    details?: unknown,
    recovery?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.path = path;
    this.details = details;
    this.recovery = recovery;
    if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
      const revision = (details as Record<string, unknown>).currentRevision;
      if (Number.isInteger(revision) && Number(revision) >= 0) this.currentRevision = Number(revision);
    }
  }
}

async function apiError(response: Response): Promise<ApiClientError> {
  const body = await response.json().catch(() => null) as Partial<ApiErrorResponse> | null;
  return new ApiClientError(
    response.status,
    body?.code ?? 'UNKNOWN_ERROR',
    body?.message ?? 'Request failed',
    body?.requestId ?? response.headers.get('X-Request-Id') ?? '',
    body?.path,
    body?.details,
    body?.recovery,
  );
}

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!response.ok) throw await apiError(response);
  return response.status === 204 ? undefined as T : response.json();
}

async function response(url: string, options?: RequestInit): Promise<Response> {
  const result = await fetch(url, options);
  if (!result.ok) throw await apiError(result);
  return result;
}

export const projectsApi = {
  list: (signal?: AbortSignal) => json<ProjectSummary[]>(`${API_BASE}/projects`, { signal }),
  get: (projectId: string, signal?: AbortSignal) =>
    json<Project>(`${API_BASE}/projects/${segment(projectId)}`, { signal }),
  create: (input: CreateProjectInput) => json<Project>(`${API_BASE}/projects`, {
    method: 'POST', body: JSON.stringify(input),
  }),
  update: (projectId: string, expectedRevision: number, patch: ProjectPatch) =>
    json<Project>(`${API_BASE}/projects/${segment(projectId)}`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision, patch }),
    }),
  delete: (projectId: string, expectedRevision: number) =>
    json<void>(`${API_BASE}/projects/${segment(projectId)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision }),
    }),
  getWorkspace: (signal?: AbortSignal) => json<WorkspaceState>(`${API_BASE}/workspace`, { signal }),
  setActive: (projectId: string | null, expectedRevision: number) =>
    json<WorkspaceState>(`${API_BASE}/workspace`, {
      method: 'PUT', body: JSON.stringify({ activeProjectId: projectId, expectedRevision }),
    }),
  getRuntimeSettings: (projectId: string, signal?: AbortSignal) =>
    json<ProjectRuntimeSettings>(`${API_BASE}/projects/${segment(projectId)}/runtime-settings`, { signal }),
  updateRuntimeSettings: (projectId: string, input: RuntimeSettingsUpdateInput) =>
    json<ProjectRuntimeSettings>(`${API_BASE}/projects/${segment(projectId)}/runtime-settings`, {
      method: 'PUT', body: JSON.stringify(input),
    }),
};

export const interceptionGuidanceApi = {
  get: (projectId: string, origins: readonly string[], signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const origin of origins) query.append('origin', origin);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return json<InterceptionGuidance>(
      `${API_BASE}/projects/${segment(projectId)}/interception-guidance${suffix}`,
      { signal },
    );
  },
};

export const endpointsApi = {
  list: (projectId: string, signal?: AbortSignal) =>
    json<EndpointSummary[]>(`${API_BASE}/projects/${segment(projectId)}/endpoints`, { signal }),
  get: (projectId: string, endpointId: string, signal?: AbortSignal) =>
    json<EndpointDetail>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}`, { signal }),
  deletionImpact: (projectId: string, endpointId: string, signal?: AbortSignal) =>
    json<EndpointDeletionImpact>(
      `${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/deletion-impact`,
      { signal },
    ),
  create: (projectId: string, input: CreateEndpointInput) =>
    json<EndpointDetail>(`${API_BASE}/projects/${segment(projectId)}/endpoints`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  update: (projectId: string, endpointId: string, expectedRevision: number, patch: EndpointPatch) =>
    json<EndpointDetail>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision, patch }),
    }),
  setMode: (projectId: string, endpointId: string, mode: EndpointMode, expectedRevision: number) =>
    json<EndpointDetail>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/mode`, {
      method: 'PUT', body: JSON.stringify({ mode, expectedRevision }),
    }),
  delete: (projectId: string, endpointId: string, expectedRevision: number) =>
    json<void>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision }),
    }),
};

export const variantsApi = {
  deletionImpact: (
    projectId: string,
    endpointId: string,
    variantId: string,
    signal?: AbortSignal,
  ) => json<VariantDeletionImpact>(
    `${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/variants/${segment(variantId)}/deletion-impact`,
    { signal },
  ),
  create: (projectId: string, endpointId: string, expectedEndpointRevision: number, input: CreateVariantInput) =>
    json<ResponseVariant>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/variants`, {
      method: 'POST', body: JSON.stringify({ expectedEndpointRevision, ...input }),
    }),
  update: (projectId: string, endpointId: string, variantId: string, expectedRevision: number, patch: VariantPatch) =>
    json<ResponseVariant>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/variants/${segment(variantId)}`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision, patch }),
    }),
  delete: (
    projectId: string,
    endpointId: string,
    variantId: string,
    expectedRevision: number,
    replacement?: {
      expectedEndpointRevision: number;
      replacementVariantId: string;
    },
  ) =>
    json<void>(`${API_BASE}/projects/${segment(projectId)}/endpoints/${segment(endpointId)}/variants/${segment(variantId)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision, ...replacement }),
    }),
};

export const statesApi = {
  list: (projectId: string, signal?: AbortSignal) =>
    json<AppStateSummary[]>(`${API_BASE}/projects/${segment(projectId)}/states`, { signal }),
  get: (projectId: string, stateId: string, signal?: AbortSignal) =>
    json<AppState>(`${API_BASE}/projects/${segment(projectId)}/states/${segment(stateId)}`, { signal }),
  create: (projectId: string, input: CreateAppStateInput) =>
    json<AppState>(`${API_BASE}/projects/${segment(projectId)}/states`, { method: 'POST', body: JSON.stringify(input) }),
  update: (projectId: string, stateId: string, expectedRevision: number, patch: AppStatePatch) =>
    json<AppState>(`${API_BASE}/projects/${segment(projectId)}/states/${segment(stateId)}`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision, patch }),
    }),
  delete: (projectId: string, stateId: string, expectedRevision: number) =>
    json<void>(`${API_BASE}/projects/${segment(projectId)}/states/${segment(stateId)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision }),
    }),
  setSelection: (projectId: string, expectedRevision: number, input: StateSelectionInput) =>
    json<Project>(`${API_BASE}/projects/${segment(projectId)}/state-selection`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision, ...input }),
    }),
  setMode: (projectId: string, appStateMode: AppStateMode, expectedProjectRevision: number) =>
    json<Project>(`${API_BASE}/projects/${segment(projectId)}/app-state-mode`, {
      method: 'PUT', body: JSON.stringify({ appStateMode, expectedProjectRevision }),
    }),
};

export const bodiesApi = {
  download: (projectId: string, assetId: string, signal?: AbortSignal) =>
    response(`${API_BASE}/projects/${segment(projectId)}/bodies/${segment(assetId)}`, { signal }),
  upload: (projectId: string, body: Blob, signal?: AbortSignal) =>
    response(`${API_BASE}/projects/${segment(projectId)}/bodies`, {
      method: 'POST', headers: { 'Content-Type': body.type || 'application/octet-stream' }, body, signal,
    }).then(result => result.json() as Promise<BodyAsset>),
};

export const diagnosticsApi = {
  listAll: (signal?: AbortSignal) =>
    json<{ diagnostics: RepositoryDiagnostic[] }>(`${API_BASE}/diagnostics`, { signal }),
  list: (projectId: string, signal?: AbortSignal) =>
    json<{ projectId: string; diagnostics: RepositoryDiagnostic[] }>(
      `${API_BASE}/projects/${segment(projectId)}/diagnostics`, { signal },
    ),
};

export const trafficApi = {
  list: (projectId: string, query: TrafficQuery = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.afterId) params.set('afterId', query.afterId);
    if (query.beforeId) params.set('beforeId', query.beforeId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    return json<TrafficPage>(
      `${API_BASE}/projects/${segment(projectId)}/traffic${params.size ? `?${params}` : ''}`,
      { signal },
    );
  },
  detail: (projectId: string, trafficId: string, signal?: AbortSignal) =>
    json<TrafficDetail>(
      `${API_BASE}/projects/${segment(projectId)}/traffic/${segment(trafficId)}`,
      { signal },
    ),
  clear: (projectId: string, signal?: AbortSignal) =>
    json<void>(`${API_BASE}/projects/${segment(projectId)}/traffic`, { method: 'DELETE', signal }),
  body: (
    projectId: string,
    trafficId: string,
    side: 'request' | 'response',
    signal?: AbortSignal,
    options?: { view?: 'decoded' },
  ) => {
    const params = options?.view === 'decoded' ? '?view=decoded' : '';
    return response(
      `${API_BASE}/projects/${segment(projectId)}/traffic/${segment(trafficId)}/bodies/${side}${params}`,
      { signal },
    );
  },
  bodyDownloadUrl: (projectId: string, trafficId: string, side: 'request' | 'response') =>
    `${API_BASE}/projects/${segment(projectId)}/traffic/${segment(trafficId)}/bodies/${side}?download=1`,
  promote: (
    projectId: string,
    trafficId: string,
    input: TrafficPromotionInput,
    signal?: AbortSignal,
  ) =>
    json<TrafficPromotionResult>(
      `${API_BASE}/projects/${segment(projectId)}/traffic/${segment(trafficId)}/mock`,
      { method: 'POST', body: JSON.stringify(input), signal },
    ),
};

export const importApi = {
  preview: (projectId: string, input: ImportPreviewRequest, signal?: AbortSignal) =>
    json<ImportPreview>(`${API_BASE}/projects/${segment(projectId)}/import/preview`, {
      method: 'POST', body: JSON.stringify(input), signal,
    }),
  commit: (projectId: string, input: ImportCommitRequest) =>
    json<ImportCommitResult>(`${API_BASE}/projects/${segment(projectId)}/import/commit`, {
      method: 'POST', body: JSON.stringify(input),
    }),
};

export const staticFilesApi = {
  list: (projectId: string, signal?: AbortSignal) =>
    json<{ files: StaticFileEntry[] }>(`${API_BASE}/projects/${segment(projectId)}/static-files`, { signal }),
  upload: (projectId: string, filePath: string, file: File) =>
    response(`${API_BASE}/projects/${segment(projectId)}/static-files?path=${encodeURIComponent(filePath)}`, {
      method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    }).then(result => result.json() as Promise<{ ok: boolean; file: StaticFileEntry }>),
  delete: (projectId: string, filePath: string) =>
    json<void>(`${API_BASE}/projects/${segment(projectId)}/static-files?path=${encodeURIComponent(filePath)}`, {
      method: 'DELETE',
    }),
};
