import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type {
  AppState,
  AppStateModeInput,
  AppStatePatch,
  AppStateReferenceSummary,
  AppStateSummary,
  BodyAsset,
  CreateAppStateInput,
  EndpointCreateInput,
  CreateProjectInput,
  CreateVariantInput,
  EndpointDetail,
  EndpointDeletionImpact,
  EndpointPatch,
  EndpointModeInput,
  EndpointSummary,
  Project,
  ProjectPatch,
  ProjectRuntimeSettings,
  ProjectSummary,
  RepositoryDiagnostic,
  RepositoryDiagnostics,
  ResponseVariant,
  RuntimeSettingsUpdateInput,
  StateSelectionInput,
  StaticFileSummary,
  VariantDeletionImpact,
  VariantPatch,
  WorkspaceState,
} from '../domain/model';
import {
  AppStateSchema,
  EndpointSchema,
  ProjectRuntimeSettingsSchema,
  ProjectSchema,
  WorkspaceStateSchema,
} from '../domain/schemas';
import type {
  TrafficPromotionInput,
  TrafficRowLeaseSnapshot,
} from '../domain/traffic';
import { parsePersistedRecord, type ValidationFinding } from '../domain/validation';
import type {
  ImportAction,
  ImportCommitRequest,
  ImportCommitResult,
  ImportPlan,
  ImportPreview,
  ImportPreviewRequest,
  ParsedImportSource,
  PlannedImportResponse,
} from '../import/contracts';
import { parseCurlSource } from '../import/curl-parser';
import {
  buildImportPlan,
  canonicalImportDigest,
  importPlanDigest,
} from '../import/planner';
import { parsePostmanSource } from '../import/postman-parser';
import { digestVariables, sha256Identity } from '../import/security';
import { createImportSnapshotTokenCodec } from '../import/snapshot-token';
import { HttpError } from '../services/api-errors';
import { isStablePathSegment } from '../services/storage';
import type { TrafficBodyLease } from '../services/traffic-body-cache';
import type { AtomicFileWriter } from './atomic-write';
import type { BodyImportTransaction, BodyStore, PutBodyMetadata } from './body-store';
import {
  calculateStateCoverage,
  CompileProjectError,
  compileProject,
  matchRequest,
  resolveEndpoint,
  type CompiledProject,
  type MatchRequest,
  type EndpointDecision,
} from './compile-project';
import { nodeFileSystem, type FileSystem } from './file-system';
import { loadProject } from './load-project';
import { validateReferentialIntegrity } from './referential-integrity';
import { cloneSnapshot, type ValidatedProjectSnapshot } from './snapshot';
import {
  applyTrafficPromotion,
  lookupTrafficPromotionReceipt,
  promotionBodyMetadata,
  resolveTrafficPromotionTargets,
  type PublicationFailpoints,
  type RepositoryPromotionPublication,
  type TrafficPromotionReceiptLookup,
} from './traffic-promotion';
import {
  isNormalizedStaticPath,
  parseStaticMetadata,
  parseStaticTransaction,
  parseStaticTransactionPointer,
  serializeStaticMetadata,
  serializeStaticTransaction,
  serializeStaticTransactionPointer,
  staticTransactionDigest,
  STATIC_METADATA_FILE,
  STATIC_TRANSACTION_DIRECTORY,
  STATIC_TRANSACTION_JOURNAL,
  STATIC_TRANSACTION_POINTER,
  type StaticTransactionJournal,
  type StaticTransactionPointer,
} from './static-metadata';

export type { ValidatedProjectSnapshot } from './snapshot';
export { validateReferentialIntegrity } from './referential-integrity';

export interface ProjectRepositoryOptions {
  rootDirectory: string;
  atomicWriter: AtomicFileWriter;
  bodyStore: BodyStore;
  beforeCompile?: (snapshot: ValidatedProjectSnapshot) => void;
  idSource?: () => string;
  importTokenKey?: Buffer;
  importVariableDigestKey?: Buffer;
  fileSystem?: FileSystem;
  publicationFailpoints?: PublicationFailpoints;
}

export interface VariantDeleteOptions {
  expectedEndpointRevision?: number;
  replacementVariantId?: string;
}

export interface InterceptionGuidanceSources {
  endpointOrigins: string[];
  configuredPatterns: string[];
}

export interface ProjectRepository {
  initialize(): Promise<RepositoryDiagnostics>;
  reloadProject(projectId: string): Promise<void>;
  listProjects(): ProjectSummary[];
  getProject(projectId: string): Project;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(projectId: string, expectedRevision: number, patch: ProjectPatch): Promise<Project>;
  deleteProject(projectId: string, expectedRevision: number): Promise<void>;
  getWorkspaceState(): WorkspaceState;
  setActiveProject(projectId: string | null, expectedRevision: number): Promise<WorkspaceState>;
  getRuntimeSettings(projectId: string): ProjectRuntimeSettings;
  getInterceptionGuidanceSources(projectId: string): InterceptionGuidanceSources;
  updateRuntimeSettings(projectId: string, input: RuntimeSettingsUpdateInput): Promise<ProjectRuntimeSettings>;
  previewImport(projectId: string, input: ImportPreviewRequest): ImportPreview;
  commitImport(projectId: string, input: ImportCommitRequest): Promise<ImportCommitResult>;
  lookupTrafficPromotionReceipt(
    projectId: string,
    trafficId: string,
    input: TrafficPromotionInput,
  ): Promise<TrafficPromotionReceiptLookup>;
  promoteTraffic(
    snapshot: TrafficRowLeaseSnapshot,
    lease: TrafficBodyLease,
    input: TrafficPromotionInput,
  ): Promise<RepositoryPromotionPublication>;
  listEndpoints(projectId: string): EndpointSummary[];
  getEndpoint(projectId: string, endpointId: string): EndpointDetail;
  getEndpointDeletionImpact(projectId: string, endpointId: string): EndpointDeletionImpact;
  createEndpoint(projectId: string, input: EndpointCreateInput): Promise<EndpointDetail>;
  updateEndpoint(projectId: string, endpointId: string, expectedRevision: number, patch: EndpointPatch): Promise<EndpointDetail>;
  setEndpointMode(projectId: string, endpointId: string, input: EndpointModeInput): Promise<EndpointDetail>;
  deleteEndpoint(projectId: string, endpointId: string, expectedRevision: number): Promise<void>;
  createVariant(projectId: string, endpointId: string, expectedEndpointRevision: number, input: CreateVariantInput): Promise<ResponseVariant>;
  updateVariant(projectId: string, endpointId: string, variantId: string, expectedRevision: number, patch: VariantPatch): Promise<ResponseVariant>;
  getVariantDeletionImpact(
    projectId: string,
    endpointId: string,
    variantId: string,
  ): VariantDeletionImpact;
  deleteVariant(
    projectId: string,
    endpointId: string,
    variantId: string,
    expectedRevision: number,
    options?: VariantDeleteOptions,
  ): Promise<void>;
  listStates(projectId: string): AppStateSummary[];
  getState(projectId: string, stateId: string): AppState;
  createState(projectId: string, input: CreateAppStateInput): Promise<AppState>;
  updateState(projectId: string, stateId: string, expectedRevision: number, patch: AppStatePatch): Promise<AppState>;
  deleteState(projectId: string, stateId: string, expectedRevision: number): Promise<void>;
  setStateSelection(projectId: string, expectedRevision: number, input: StateSelectionInput): Promise<Project>;
  setAppStateMode(projectId: string, input: AppStateModeInput): Promise<Project>;
  resolve(projectId: string, request: MatchRequest): EndpointDecision | null;
  listAllDiagnostics(): RepositoryDiagnostic[];
  listDiagnostics(projectId: string): RepositoryDiagnostic[];
  listStaticFiles(projectId: string): StaticFileSummary[];
  putStaticFile(projectId: string, relativePath: string, stream: NodeJS.ReadableStream, metadata: { mediaType: string; maxBytes: number }): Promise<StaticFileSummary>;
  openStaticFile(projectId: string, relativePath: string): NodeJS.ReadableStream;
  deleteStaticFile(projectId: string, relativePath: string): Promise<void>;
  putBody(projectId: string, stream: NodeJS.ReadableStream, metadata: PutBodyMetadata, policy: { maxBytes: number }): Promise<BodyAsset>;
  getBodyMetadata(projectId: string, assetId: string): BodyAsset;
  getBody(projectId: string, assetId: string): Promise<BodyAsset>;
  openBody(projectId: string, assetId: string, range?: { start?: number; end?: number }): NodeJS.ReadableStream;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function appStateReference(state: AppState): AppStateReferenceSummary {
  return { id: state.id, name: state.name, revision: state.revision };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function mapStaticIoError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') {
    return new HttpError(500, 'STATIC_IO_ERROR', 'Static storage operation failed');
  }
  return error;
}

function mapProjectIoError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') {
    return new HttpError(500, 'PROJECT_IO_ERROR', 'Project storage operation failed');
  }
  return error;
}

function invalidProject(details: unknown): HttpError {
  return new HttpError(422, 'INVALID_PROJECT', 'Project validation failed', { details });
}

function revisionConflict(expectedRevision: number, currentRevision: number): HttpError {
  return new HttpError(409, 'REVISION_CONFLICT', 'The persisted record revision has changed', {
    details: { expectedRevision, currentRevision },
  });
}

function importError(
  code: 'IMPORT_VARIABLES_REQUIRED' | 'IMPORT_SELECTION_INVALID' | 'IMPORT_NO_CHANGES',
  message: string,
): HttpError {
  return new HttpError(422, code, message);
}

function invalidImportSelection(): HttpError {
  return importError('IMPORT_SELECTION_INVALID', 'Import selection does not match the preview');
}

function staleImportPreview(): HttpError {
  return new HttpError(409, 'IMPORT_PREVIEW_STALE', 'Import preview is stale; refresh the preview');
}

function parseImport(input: ImportPreviewRequest): ParsedImportSource {
  return input.source.type === 'curl'
    ? parseCurlSource(input.source.text)
    : parsePostmanSource(input.source.collection, input.variables ?? {});
}

function responseIdentity(variant: ResponseVariant): string {
  const headers = new Map<string, string[]>();
  for (const [sourceName, sourceValue] of Object.entries(variant.responseHeaders).sort()) {
    const name = sourceName.toLowerCase();
    const values = Array.isArray(sourceValue) ? sourceValue : [sourceValue];
    headers.set(name, [...(headers.get(name) ?? []), ...values]);
  }
  return sha256Identity('import-response-v1', {
    status: variant.status,
    headers: Object.fromEntries([...headers].sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))),
    body: variant.bodyAssetId === undefined
      ? { kind: 'none' }
      : { kind: 'sha256', value: variant.bodyAssetId },
  });
}

function notFound(kind: string): HttpError {
  return new HttpError(404, `${kind.toUpperCase()}_NOT_FOUND`, `${kind} was not found`);
}

function normalizeStaticPath(input: string): string {
  if (input.includes('\0')
    || input.length === 0
    || input.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
  }
  const normalizedSeparators = input.replaceAll('\\', '/');
  const segments = normalizedSeparators.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
  }
  const normalized = segments.join('/');
  if (normalized === STATIC_METADATA_FILE
    || normalized === STATIC_TRANSACTION_POINTER
    || normalized === STATIC_TRANSACTION_DIRECTORY
    || normalized.startsWith(`${STATIC_TRANSACTION_DIRECTORY}/`)) {
    throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
  }
  return normalized;
}

function limitedStaticSource(source: NodeJS.ReadableStream, maxBytes: number): NodeJS.ReadableStream {
  return Readable.from((async function* () {
    let size = 0;
    for await (const chunk of source as AsyncIterable<Buffer | string | Uint8Array>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + bytes.length > maxBytes) {
        throw new HttpError(413, 'STATIC_FILE_TOO_LARGE', 'Static file exceeds the allowed size limit');
      }
      size += bytes.length;
      yield bytes;
    }
  })());
}

function applyNullablePatch<T extends object, K extends keyof T>(
  target: T,
  patch: Partial<Record<K, T[K] | null>>,
  key: K,
): void {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
  const value = patch[key];
  if (value === null) delete target[key];
  else if (value !== undefined) target[key] = clone(value as T[K]);
}

export function createProjectRepository(
  options: ProjectRepositoryOptions,
): ProjectRepository {
  const { rootDirectory, atomicWriter, bodyStore } = options;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const idSource = options.idSource ?? randomUUID;
  const importTokenCodec = createImportSnapshotTokenCodec(options.importTokenKey);
  const importVariableDigestKey = Buffer.from(options.importVariableDigestKey ?? randomBytes(32));
  const snapshots = new Map<string, ValidatedProjectSnapshot>();
  const compiled = new Map<string, CompiledProject>();
  const staticFiles = new Map<string, Map<string, StaticFileSummary>>();
  const queues = new Map<string, Promise<void>>();
  let diagnostics: RepositoryDiagnostic[] = [];
  let workspace: WorkspaceState = { schemaVersion: 4, revision: 0 };

  const projectsRoot = path.join(rootDirectory, 'projects');
  const workspacePath = path.join(rootDirectory, 'workspace.json');
  const projectRoot = (projectId: string) => path.join(projectsRoot, projectId);
  const generationRoot = (snapshot: ValidatedProjectSnapshot) => path.join(
    projectRoot(snapshot.project.id),
    'generations',
    snapshot.generationId,
  );

  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return result;
  }

  async function pathExists(candidate: string): Promise<boolean> {
    try {
      await fs.promises.lstat(candidate);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async function allocateId(
    prefix: string,
    unavailable: (candidate: string) => boolean | Promise<boolean>,
  ): Promise<string> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = `${prefix}_${idSource().replaceAll('-', '')}`;
      if (isStablePathSegment(candidate) && !await unavailable(candidate)) return candidate;
    }
    throw new HttpError(409, 'ID_GENERATION_EXHAUSTED', 'A unique stable ID could not be generated');
  }

  function requireStableId(id: string, kind: string): void {
    if (!isStablePathSegment(id)) {
      throw new HttpError(400, `INVALID_${kind.toUpperCase()}_ID`, `${kind} ID is invalid`);
    }
  }

  function requireSnapshot(projectId: string): ValidatedProjectSnapshot {
    requireStableId(projectId, 'project');
    const snapshot = snapshots.get(projectId);
    if (snapshot) return snapshot;
    if (diagnostics.some(finding => finding.projectId === projectId)) throw invalidProject({ projectId });
    throw notFound('project');
  }

  function requireEndpoint(snapshot: ValidatedProjectSnapshot, endpointId: string): EndpointDetail {
    requireStableId(endpointId, 'endpoint');
    const endpoint = snapshot.endpoints.get(endpointId);
    if (!endpoint) throw notFound('endpoint');
    return endpoint;
  }

  function requireState(snapshot: ValidatedProjectSnapshot, stateId: string): AppState {
    requireStableId(stateId, 'state');
    const state = snapshot.states.get(stateId);
    if (!state) throw notFound('state');
    return state;
  }

  function compileCandidate(snapshot: ValidatedProjectSnapshot): CompiledProject {
    options.beforeCompile?.(cloneSnapshot(snapshot));
    try {
      return compileProject(cloneSnapshot(snapshot));
    } catch (error) {
      if (error instanceof CompileProjectError && error.code === 'ENDPOINT_IDENTITY_CONFLICT') {
        throw new HttpError(409, error.code, error.message);
      }
      throw error;
    }
  }

  async function prepare(
    candidateInput: ValidatedProjectSnapshot,
    getBodyMetadata: (projectId: string, assetId: string) => Promise<BodyAsset> = bodyStore.getMetadata,
  ): Promise<{
    snapshot: ValidatedProjectSnapshot;
    compiled: CompiledProject;
  }> {
    const candidate = cloneSnapshot(candidateInput);
    const findings: ValidationFinding[] = [];
    const project = parsePersistedRecord(ProjectSchema, candidate.project, 'project.json');
    const settings = parsePersistedRecord(ProjectRuntimeSettingsSchema, candidate.settings, 'settings.json');
    if (!project.ok) findings.push(...project.findings);
    if (!settings.ok) findings.push(...settings.findings);
    const endpoints = new Map<string, EndpointDetail>();
    for (const endpoint of candidate.endpoints.values()) {
      const parsed = parsePersistedRecord(EndpointSchema, endpoint, `endpoints/${endpoint.id}.json`);
      if (parsed.ok) endpoints.set(parsed.value.id, parsed.value);
      else findings.push(...parsed.findings);
    }
    const states = new Map<string, AppState>();
    for (const state of candidate.states.values()) {
      const parsed = parsePersistedRecord(AppStateSchema, state, `states/${state.id}.json`);
      if (parsed.ok) states.set(parsed.value.id, parsed.value);
      else findings.push(...parsed.findings);
    }
    if (!project.ok || !settings.ok) throw invalidProject(findings);
    const normalized: ValidatedProjectSnapshot = {
      project: project.value,
      settings: settings.value,
      endpoints,
      states,
      bodyAssets: new Map(),
      generationId: candidate.generationId,
    };
    const referencedAssetIds = new Set<string>();
    for (const endpoint of normalized.endpoints.values()) {
      for (const variant of endpoint.variants) {
        if (variant.bodyAssetId) referencedAssetIds.add(variant.bodyAssetId);
      }
    }
    for (const assetId of [...referencedAssetIds].sort()) {
      try {
        (normalized.bodyAssets as Map<string, BodyAsset>).set(
          assetId,
          await getBodyMetadata(normalized.project.id, assetId),
        );
      } catch {
        // Referential validation emits a stable MISSING_BODY_ASSET finding.
      }
    }
    findings.push(...validateReferentialIntegrity(normalized));
    if (findings.length > 0) throw invalidProject(findings);
    return { snapshot: normalized, compiled: compileCandidate(normalized) };
  }

  function publish(projectId: string, prepared: Awaited<ReturnType<typeof prepare>>): void {
    snapshots.set(projectId, prepared.snapshot);
    compiled.set(projectId, prepared.compiled);
  }

  async function publishJson(
    projectId: string,
    candidate: ValidatedProjectSnapshot,
    relativeFile: string,
    record: (snapshot: ValidatedProjectSnapshot) => unknown,
  ): Promise<ValidatedProjectSnapshot> {
    const prepared = await prepare(candidate);
    await atomicWriter.writeJson(path.join(generationRoot(prepared.snapshot), relativeFile), record(prepared.snapshot));
    publish(projectId, prepared);
    return prepared.snapshot;
  }

  async function publishGeneration(
    projectId: string,
    candidate: ValidatedProjectSnapshot,
    bodyTransaction?: BodyImportTransaction,
    publicationOptions: {
      deferBodyCompletion?: boolean;
      failpoints?: PublicationFailpoints;
      onPointerPublished?(): void;
    } = {},
  ): Promise<ValidatedProjectSnapshot> {
    let staging: string | undefined;
    let ownedGeneration: string | undefined;
    let staged = false;
    let pointerPublished = false;
    try {
      const generationId = await allocateId(
        'gen',
        value => pathExists(path.join(projectRoot(projectId), 'generations', value)),
      );
      candidate.generationId = generationId;
      const getBodyMetadata = bodyTransaction === undefined
        ? bodyStore.getMetadata
        : (_projectId: string, assetId: string) => bodyTransaction.getMetadata(assetId);
      await publicationOptions.failpoints?.before('candidateCompile');
      const prepared = await prepare(candidate, getBodyMetadata);
      staging = path.join(projectRoot(projectId), 'generations', `.staging-${randomUUID()}`);
      staged = true;
      await publicationOptions.failpoints?.before('generationWrite');
      await fs.promises.mkdir(path.join(staging, 'endpoints'), { recursive: true });
      await fs.promises.mkdir(path.join(staging, 'states'), { recursive: true });
      await atomicWriter.writeJson(path.join(staging, 'project.json'), prepared.snapshot.project);
      await atomicWriter.writeJson(path.join(staging, 'settings.json'), prepared.snapshot.settings);
      for (const endpoint of prepared.snapshot.endpoints.values()) {
        await atomicWriter.writeJson(path.join(staging, 'endpoints', `${endpoint.id}.json`), endpoint);
      }
      for (const state of prepared.snapshot.states.values()) {
        await atomicWriter.writeJson(path.join(staging, 'states', `${state.id}.json`), state);
      }
      const finalGeneration = generationRoot(prepared.snapshot);
      await publicationOptions.failpoints?.before('generationRename');
      await fs.promises.rename(staging, finalGeneration);
      ownedGeneration = finalGeneration;
      staged = false;
      if (bodyTransaction) {
        await publicationOptions.failpoints?.before('bodyPromote');
        await bodyTransaction.promote();
      }
      await publicationOptions.failpoints?.before('pointerWrite');
      await atomicWriter.writeJson(path.join(projectRoot(projectId), 'current.json'), {
        schemaVersion: 4,
        generationId,
      }, {
        beforePublish: publicationOptions.failpoints === undefined
          ? undefined
          : () => publicationOptions.failpoints!.before('pointerPublish'),
      });
      pointerPublished = true;
      publicationOptions.onPointerPublished?.();
      ownedGeneration = undefined;
      await publicationOptions.failpoints?.before('memoryPublish');
      publish(projectId, prepared);
      if (bodyTransaction && publicationOptions.deferBodyCompletion !== true) {
        try {
          await bodyTransaction.complete();
        } catch {
          // Canonical publication succeeded; cleanup cannot replace that result.
        }
      }
      return prepared.snapshot;
    } catch (error) {
      if (pointerPublished) {
        const reloaded = await loadAndCompile(projectId);
        if (reloaded.compiledSuccessfully) {
          snapshots.set(projectId, reloaded.snapshot);
          compiled.set(projectId, reloaded.compiledValue);
          staticFiles.set(projectId, reloaded.staticEntries);
        }
      } else {
        if (ownedGeneration) {
          try {
            await fileSystem.rm(ownedGeneration, { recursive: true, force: true });
          } catch {
            // Preserve the publication error and continue transaction cleanup.
          }
        }
        if (bodyTransaction) {
          try {
            await bodyTransaction.rollback();
          } catch {
            // Preserve the publication error.
          }
        }
      }
      throw mapProjectIoError(error);
    } finally {
      if (staged && staging) {
        await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  function attachProjectId(projectId: string, findings: ValidationFinding[]): RepositoryDiagnostic[] {
    return findings.map(finding => ({ ...finding, projectId }));
  }

  function replaceProjectDiagnostics(projectId: string, next: RepositoryDiagnostic[]): void {
    diagnostics = [
      ...diagnostics.filter(finding => finding.projectId !== projectId),
      ...next,
    ];
  }

  function staticDiagnostic(
    projectId: string,
    code: 'STATIC_IO_ERROR' | 'INVALID_STATIC_TRANSACTION',
    filePath: string,
  ): RepositoryDiagnostic {
    return {
      severity: 'blocking', code, projectId,
      file: path.relative(rootDirectory, filePath).split(path.sep).join('/'),
      message: code === 'STATIC_IO_ERROR'
        ? 'Static storage could not be inspected or recovered.'
        : 'Static transaction state is malformed or unsafe.',
      recovery: code === 'STATIC_IO_ERROR'
        ? 'Restore writable static storage and retry initialization.'
        : 'Remove or repair the reserved static transaction state.',
    };
  }

  function transactionIncomplete(): HttpError {
    return new HttpError(
      500,
      'STATIC_TRANSACTION_INCOMPLETE',
      'Static transaction recovery is incomplete',
    );
  }

  const transactionRoot = (projectId: string): string => path.join(
    projectRoot(projectId), 'static', STATIC_TRANSACTION_DIRECTORY,
  );

  const transactionPointerPath = (projectId: string): string => path.join(
    projectRoot(projectId), 'static', STATIC_TRANSACTION_POINTER,
  );

  async function validateStaticRoot(projectId: string): Promise<RepositoryDiagnostic[]> {
    const staticRoot = path.join(projectRoot(projectId), 'static');
    for (const directory of [rootDirectory, path.join(rootDirectory, 'projects'), projectRoot(projectId), staticRoot]) {
      try {
        const stats = await fs.promises.lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          return [{
            severity: 'blocking', code: 'INVALID_STATIC_FILE', projectId,
            file: path.relative(rootDirectory, directory).split(path.sep).join('/') || '.',
            message: 'Static storage has an unsafe root or ancestor.',
            recovery: 'Replace the static root and its ancestors with real directories.',
          }];
        }
      } catch {
        return [staticDiagnostic(projectId, 'STATIC_IO_ERROR', directory)];
      }
    }
    return [];
  }

  async function lstatIfPresent(filePath: string): Promise<fs.Stats | undefined> {
    try {
      return await fs.promises.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async function removeFileIfPresent(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  function unsafeStaticTransactionTarget(): HttpError {
    return new HttpError(
      422,
      'INVALID_STATIC_TRANSACTION',
      'Static transaction target path is unsafe',
    );
  }

  async function inspectStaticTransactionTarget(
    projectId: string,
    relativePath: string,
    createMissingParents: boolean,
  ): Promise<fs.Stats | undefined> {
    const location = staticLocation(projectId, relativePath);
    const rootStats = await fs.promises.lstat(location.staticRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw unsafeStaticTransactionTarget();
    let current = location.staticRoot;
    const segments = location.normalized.split('/');
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(current);
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!createMissingParents) return undefined;
        try {
          await fs.promises.mkdir(current);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        stats = await fs.promises.lstat(current);
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw unsafeStaticTransactionTarget();
    }
    try {
      const stats = await fs.promises.lstat(location.absolute);
      if (!stats.isFile() || stats.isSymbolicLink()) throw unsafeStaticTransactionTarget();
      return stats;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async function restoreStaticTransaction(
    projectId: string,
    pendingDirectory: string,
    journal: StaticTransactionJournal,
  ): Promise<string> {
    const location = staticLocation(projectId, journal.path);
    const previousPath = path.join(pendingDirectory, 'previous');
    const previousStats = await lstatIfPresent(previousPath);
    const previous = journal.before.get(journal.path);
    if (previousStats) {
      if (!previousStats.isFile() || previousStats.isSymbolicLink()) throw new Error('Unsafe previous static content');
      const targetStats = await inspectStaticTransactionTarget(projectId, journal.path, true);
      if (targetStats) {
        await inspectStaticTransactionTarget(projectId, journal.path, true);
        await fs.promises.unlink(location.absolute);
      }
      await inspectStaticTransactionTarget(projectId, journal.path, true);
      await fs.promises.rename(previousPath, location.absolute);
    } else if (previous) {
      const targetStats = await inspectStaticTransactionTarget(projectId, journal.path, false);
      if (!targetStats || targetStats.size !== previous.size) {
        throw Object.assign(new Error('Prior static content is unavailable'), { code: 'EIO' });
      }
    } else {
      const targetStats = await inspectStaticTransactionTarget(projectId, journal.path, false);
      if (targetStats) {
        await inspectStaticTransactionTarget(projectId, journal.path, false);
        await fs.promises.unlink(location.absolute);
      }
    }
    const manifestPath = path.join(location.staticRoot, STATIC_METADATA_FILE);
    await inspectStaticTransactionTarget(projectId, journal.path, false);
    let manifestMatches = false;
    try {
      const current = parseStaticMetadata(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as unknown);
      manifestMatches = current !== undefined
        && JSON.stringify(serializeStaticMetadata(current)) === JSON.stringify(serializeStaticMetadata(journal.before));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!manifestMatches) {
      await inspectStaticTransactionTarget(projectId, journal.path, false);
      await atomicWriter.writeJson(manifestPath, serializeStaticMetadata(journal.before));
    }
    const restored = path.join(
      path.dirname(pendingDirectory),
      `restored-${journal.transactionId}`,
    );
    await fs.promises.rename(pendingDirectory, restored);
    return restored;
  }

  async function readStaticTransaction(
    projectId: string,
    state: string,
    directory: string,
    transactionId: string,
  ): Promise<{ journal?: StaticTransactionJournal; findings: RepositoryDiagnostic[] }> {
    let entries: fs.Dirent[];
    try {
      const stats = await fs.promises.lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return { findings: [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', directory)] };
      }
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return { findings: [staticDiagnostic(projectId, 'STATIC_IO_ERROR', directory)] };
    }
    const allowed = new Set([STATIC_TRANSACTION_JOURNAL, 'previous', 'next']);
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        return { findings: [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', child)] };
      }
      try {
        const stats = await fs.promises.lstat(child);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          return { findings: [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', child)] };
        }
      } catch {
        return { findings: [staticDiagnostic(projectId, 'STATIC_IO_ERROR', child)] };
      }
    }
    if (state === 'preparing') return { findings: [] };
    const journalPath = path.join(directory, STATIC_TRANSACTION_JOURNAL);
    let input: unknown;
    try {
      input = JSON.parse(await fs.promises.readFile(journalPath, 'utf8')) as unknown;
    } catch (error) {
      return {
        findings: [staticDiagnostic(
          projectId,
          isMissing(error) || error instanceof SyntaxError ? 'INVALID_STATIC_TRANSACTION' : 'STATIC_IO_ERROR',
          journalPath,
        )],
      };
    }
    const journal = parseStaticTransaction(input);
    if (!journal || journal.transactionId !== transactionId) {
      return { findings: [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', journalPath)] };
    }
    return { journal, findings: [] };
  }

  async function readStaticTransactionPointer(projectId: string): Promise<{
    pointer?: StaticTransactionPointer;
    present: boolean;
    findings: RepositoryDiagnostic[];
  }> {
    const pointerPath = transactionPointerPath(projectId);
    let stats: fs.Stats | undefined;
    try {
      stats = await lstatIfPresent(pointerPath);
    } catch {
      return { present: true, findings: [staticDiagnostic(projectId, 'STATIC_IO_ERROR', pointerPath)] };
    }
    if (!stats) return { present: false, findings: [] };
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { present: true, findings: [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', pointerPath)] };
    }
    let input: unknown;
    try {
      input = JSON.parse(await fs.promises.readFile(pointerPath, 'utf8')) as unknown;
    } catch (error) {
      return {
        present: true,
        findings: [staticDiagnostic(
          projectId,
          error instanceof SyntaxError ? 'INVALID_STATIC_TRANSACTION' : 'STATIC_IO_ERROR',
          pointerPath,
        )],
      };
    }
    const pointer = parseStaticTransactionPointer(input);
    return pointer
      ? { pointer, present: true, findings: [] }
      : { present: true, findings: [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', pointerPath)] };
  }

  async function staticStateMatches(
    projectId: string,
    journal: StaticTransactionJournal,
    expected: ReadonlyMap<string, StaticFileSummary>,
  ): Promise<boolean> {
    const location = staticLocation(projectId, journal.path);
    try {
      const manifest = parseStaticMetadata(JSON.parse(
        await fs.promises.readFile(path.join(location.staticRoot, STATIC_METADATA_FILE), 'utf8'),
      ) as unknown);
      if (!manifest
        || JSON.stringify(serializeStaticMetadata(manifest)) !== JSON.stringify(serializeStaticMetadata(expected))) {
        return false;
      }
      const summary = expected.get(journal.path);
      const stats = await inspectStaticTransactionTarget(projectId, journal.path, false);
      return summary === undefined
        ? stats === undefined
        : stats !== undefined && stats.isFile() && !stats.isSymbolicLink() && stats.size === summary.size;
    } catch {
      return false;
    }
  }

  async function recoverStaticTransactions(projectId: string): Promise<RepositoryDiagnostic[]> {
    const root = transactionRoot(projectId);
    const pointerResult = await readStaticTransactionPointer(projectId);
    let entries: fs.Dirent[];
    try {
      const stats = await lstatIfPresent(root);
      if (!stats) {
        return pointerResult.present
          ? [...pointerResult.findings, staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', root)]
          : [];
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', root)];
      }
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return [staticDiagnostic(projectId, 'STATIC_IO_ERROR', root)];
    }
    const findings: RepositoryDiagnostic[] = [...pointerResult.findings];
    const transactions: Array<{
      state: string;
      transactionId: string;
      directory: string;
      journal?: StaticTransactionJournal;
    }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const match = /^(preparing|pending|committed|restored)-([A-Za-z0-9_-]+)$/.exec(entry.name);
      const directory = path.join(root, entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink() || !isStablePathSegment(match[2])) {
        findings.push(staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', directory));
        continue;
      }
      const [, state, transactionId] = match;
      const loaded = await readStaticTransaction(projectId, state, directory, transactionId);
      findings.push(...loaded.findings);
      if (loaded.findings.length === 0) transactions.push({ state, transactionId, directory, journal: loaded.journal });
    }
    if (findings.length > 0) return findings;

    const preparing = transactions.filter(transaction => transaction.state === 'preparing');
    const pending = transactions.filter(transaction => transaction.state === 'pending');
    if (preparing.length > 0 || pending.length > 1) {
      return [staticDiagnostic(
        projectId,
        'INVALID_STATIC_TRANSACTION',
        (preparing[0] ?? pending[1]).directory,
      )];
    }

    const cleanupResidue = transactions.filter(
      transaction => transaction.state === 'committed' || transaction.state === 'restored',
    );
    const pointer = pointerResult.pointer;
    if (!pointer) {
      if (pending.length > 0) {
        return [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', pending[0].directory)];
      }
      await Promise.all(cleanupResidue.map(
        transaction => fs.promises.rm(transaction.directory, { recursive: true, force: true }).catch(() => undefined),
      ));
      return [];
    }

    const matching = transactions.filter(transaction => transaction.transactionId === pointer.transactionId);
    if (matching.length !== 1
      || matching[0].state === 'preparing'
      || pending.some(transaction => transaction.transactionId !== pointer.transactionId)) {
      return [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', transactionPointerPath(projectId))];
    }
    const active = matching[0];
    const journal = active.journal;
    if (!journal
      || journal.operation !== pointer.operation
      || journal.path !== pointer.path
      || staticTransactionDigest(journal) !== pointer.journalSha256) {
      return [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', transactionPointerPath(projectId))];
    }
    if (active.state === 'committed' && !await staticStateMatches(projectId, journal, journal.after)) {
      return [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', active.directory)];
    }
    if (active.state === 'restored' && !await staticStateMatches(projectId, journal, journal.before)) {
      return [staticDiagnostic(projectId, 'INVALID_STATIC_TRANSACTION', active.directory)];
    }

    let classifiedDirectory = active.directory;
    if (active.state === 'pending') {
      try {
        classifiedDirectory = await restoreStaticTransaction(projectId, active.directory, journal);
      } catch (error) {
        return [staticDiagnostic(
          projectId,
          error instanceof HttpError && error.code === 'INVALID_STATIC_TRANSACTION'
            ? 'INVALID_STATIC_TRANSACTION'
            : 'STATIC_IO_ERROR',
          active.directory,
        )];
      }
    }
    try {
      await removeFileIfPresent(transactionPointerPath(projectId));
    } catch {
      return [staticDiagnostic(projectId, 'STATIC_IO_ERROR', transactionPointerPath(projectId))];
    }
    await fs.promises.rm(classifiedDirectory, { recursive: true, force: true }).catch(() => undefined);
    await Promise.all(cleanupResidue
      .filter(transaction => transaction.directory !== active.directory)
      .map(transaction => fs.promises.rm(
        transaction.directory, { recursive: true, force: true },
      ).catch(() => undefined)));
    return [];
  }

  async function requireRecoveredStaticTransactions(projectId: string): Promise<void> {
    const rootFindings = await validateStaticRoot(projectId);
    if (rootFindings.length > 0) throw transactionIncomplete();
    const findings = await recoverStaticTransactions(projectId);
    if (findings.length > 0) throw transactionIncomplete();
  }

  async function scanStaticFiles(projectId: string): Promise<{
    files: Map<string, StaticFileSummary>;
    findings: RepositoryDiagnostic[];
  }> {
    const files = new Map<string, StaticFileSummary>();
    const findings: RepositoryDiagnostic[] = [];
    const staticRoot = path.join(projectRoot(projectId), 'static');
    const manifestPath = path.join(staticRoot, STATIC_METADATA_FILE);
    const invalidMetadata = (file = manifestPath): RepositoryDiagnostic => ({
      severity: 'blocking', code: 'INVALID_STATIC_METADATA', projectId,
      file: path.relative(rootDirectory, file).split(path.sep).join('/'),
      message: 'Static metadata is missing, invalid, or inconsistent with stored files.',
      recovery: 'Restore the static metadata manifest so it exactly describes regular static files.',
    });
    let manifestFiles: Map<string, StaticFileSummary> | undefined;
    try {
      const stats = await fs.promises.lstat(manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink()) return { files, findings: [invalidMetadata()] };
    } catch (error) {
      return {
        files,
        findings: [isMissing(error)
          ? invalidMetadata()
          : staticDiagnostic(projectId, 'STATIC_IO_ERROR', manifestPath)],
      };
    }
    let text: string;
    try {
      text = await fs.promises.readFile(manifestPath, 'utf8');
    } catch {
      return { files, findings: [staticDiagnostic(projectId, 'STATIC_IO_ERROR', manifestPath)] };
    }
    try {
      manifestFiles = parseStaticMetadata(JSON.parse(text) as unknown);
    } catch {
      return { files, findings: [invalidMetadata()] };
    }
    if (!manifestFiles) return { files, findings: [invalidMetadata()] };
    const physicalPaths = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return;
        findings.push({
          severity: 'blocking', code: 'STATIC_IO_ERROR', projectId,
          file: path.relative(rootDirectory, directory).split(path.sep).join('/'),
          message: 'Static storage could not be inspected.',
          recovery: 'Restore readable static storage and retry initialization.',
        });
        return;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (directory === staticRoot && entry.name === STATIC_METADATA_FILE) continue;
        if (directory === staticRoot && entry.name === STATIC_TRANSACTION_POINTER) continue;
        if (directory === staticRoot && entry.name === STATIC_TRANSACTION_DIRECTORY) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(staticRoot, absolute).split(path.sep).join('/');
        if (entry.name.includes('\\') || !isNormalizedStaticPath(relative) || physicalPaths.has(relative)) {
          findings.push(invalidMetadata(absolute));
          continue;
        }
        let stats: fs.Stats;
        try {
          stats = await fs.promises.lstat(absolute);
        } catch {
          findings.push({
            severity: 'blocking', code: 'STATIC_IO_ERROR', projectId,
            file: path.relative(rootDirectory, absolute).split(path.sep).join('/'),
            message: 'Static storage could not be inspected.',
            recovery: 'Restore readable static storage and retry initialization.',
          });
          continue;
        }
        if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
          findings.push({
            severity: 'blocking', code: 'INVALID_STATIC_FILE', projectId,
            file: path.relative(rootDirectory, absolute).split(path.sep).join('/'),
            message: 'Static storage contains a symlink or non-regular entry.',
            recovery: 'Replace the entry with a regular file or directory.',
          });
        } else if (stats.isDirectory()) {
          await visit(absolute);
        } else {
          physicalPaths.add(relative);
          const metadata = manifestFiles!.get(relative);
          if (!metadata || metadata.size !== stats.size) findings.push(invalidMetadata(absolute));
          else files.set(relative, metadata);
        }
      }
    };
    await visit(staticRoot);
    for (const relative of manifestFiles.keys()) {
      if (!physicalPaths.has(relative)) findings.push(invalidMetadata(path.join(staticRoot, ...relative.split('/'))));
    }
    return { files, findings };
  }

  async function loadAndCompile(projectId: string): Promise<
    | {
      compiledSuccessfully: true;
      snapshot: ValidatedProjectSnapshot;
      compiledValue: CompiledProject;
      findings: RepositoryDiagnostic[];
      staticEntries: Map<string, StaticFileSummary>;
    }
    | {
      compiledSuccessfully: false;
      findings: RepositoryDiagnostic[];
      staticEntries: Map<string, StaticFileSummary>;
    }
  > {
    const loaded = await loadProject({ rootDirectory, projectId, bodyStore });
    const rootFindings = await validateStaticRoot(projectId);
    const transactionFindings = rootFindings.length === 0
      ? await recoverStaticTransactions(projectId)
      : [];
    const staticResult = rootFindings.length === 0
      ? await scanStaticFiles(projectId)
      : { files: new Map<string, StaticFileSummary>(), findings: [] };
    const findings = [
      ...attachProjectId(projectId, loaded.diagnostics),
      ...rootFindings,
      ...transactionFindings,
      ...staticResult.findings,
    ];
    if (!loaded.ok || findings.length > 0) {
      return { compiledSuccessfully: false, findings, staticEntries: staticResult.files };
    }
    try {
      return {
        snapshot: loaded.snapshot,
        compiledValue: compileCandidate(loaded.snapshot),
        compiledSuccessfully: true,
        findings,
        staticEntries: staticResult.files,
      };
    } catch {
      return {
        compiledSuccessfully: false,
        findings: [{
          severity: 'blocking',
          code: 'PROJECT_COMPILATION_FAILED',
          projectId,
          file: `projects/${projectId}/current.json`,
          message: 'The selected Project generation could not be compiled.',
          recovery: 'Correct the Project records and retry loading the Project.',
        }],
        staticEntries: staticResult.files,
      };
    }
  }

  async function readWorkspace(): Promise<{ value: WorkspaceState; findings: RepositoryDiagnostic[] }> {
    let text: string;
    try {
      text = await fs.promises.readFile(workspacePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return { value: { schemaVersion: 4, revision: 0 }, findings: [] };
      return {
        value: { schemaVersion: 4, revision: 0 },
        findings: [{
          severity: 'blocking', code: 'WORKSPACE_IO_ERROR', file: 'workspace.json',
          message: 'Workspace state could not be read.',
          recovery: 'Restore readable workspace storage and retry initialization.',
        }],
      };
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      return {
        value: { schemaVersion: 4, revision: 0 },
        findings: [{
          severity: 'blocking', code: 'MALFORMED_JSON', file: 'workspace.json',
          message: 'Workspace state is not valid JSON.',
          recovery: 'Correct or restore workspace.json.',
        }],
      };
    }
    const parsed = parsePersistedRecord(WorkspaceStateSchema, input, 'workspace.json');
    return parsed.ok
      ? { value: parsed.value, findings: [] }
      : { value: { schemaVersion: 4, revision: 0 }, findings: parsed.findings };
  }

  async function assertSafeStaticComponents(projectId: string, absolute: string): Promise<void> {
    const root = projectRoot(projectId);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
    }
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stats = await fs.promises.lstat(current);
        if (stats.isSymbolicLink()) throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
        if (current !== absolute && !stats.isDirectory()) {
          throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
        }
        if (current === absolute && !stats.isFile()) {
          throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
        }
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
  }

  function staticLocation(projectId: string, relativePath: string): {
    normalized: string;
    staticRoot: string;
    absolute: string;
  } {
    const normalized = normalizeStaticPath(relativePath);
    const staticRoot = path.join(projectRoot(projectId), 'static');
    const absolute = path.join(staticRoot, ...normalized.split('/'));
    return { normalized, staticRoot, absolute };
  }

  async function publishStaticTransactionPointer(
    projectId: string,
    pendingDirectory: string,
    journal: StaticTransactionJournal,
  ): Promise<void> {
    try {
      await atomicWriter.writeJson(
        transactionPointerPath(projectId),
        serializeStaticTransactionPointer({
          transactionId: journal.transactionId,
          operation: journal.operation,
          path: journal.path,
          journalSha256: staticTransactionDigest(journal),
        }),
      );
    } catch (error) {
      try {
        await fs.promises.rm(pendingDirectory, { recursive: true, force: true });
      } catch {
        throw transactionIncomplete();
      }
      throw mapStaticIoError(error);
    }
  }

  async function finishStaticRestore(
    projectId: string,
    pendingDirectory: string,
    journal: StaticTransactionJournal,
  ): Promise<void> {
    const restored = await restoreStaticTransaction(projectId, pendingDirectory, journal);
    await removeFileIfPresent(transactionPointerPath(projectId));
    await fs.promises.rm(restored, { recursive: true, force: true }).catch(() => undefined);
  }

  async function releaseCommittedStaticTransaction(
    projectId: string,
    committedDirectory: string,
  ): Promise<void> {
    try {
      await removeFileIfPresent(transactionPointerPath(projectId));
    } catch {
      return;
    }
    await fs.promises.rm(committedDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  async function preparePutStaticTransaction(
    projectId: string,
    location: ReturnType<typeof staticLocation>,
    source: NodeJS.ReadableStream,
    metadata: { mediaType: string; maxBytes: number },
    before: Map<string, StaticFileSummary>,
  ): Promise<{
    pendingDirectory: string;
    journal: StaticTransactionJournal;
    summary: StaticFileSummary;
  }> {
    const transactionId = randomUUID().replaceAll('-', '');
    const root = transactionRoot(projectId);
    const preparingDirectory = path.join(root, `preparing-${transactionId}`);
    const pendingDirectory = path.join(root, `pending-${transactionId}`);
    try {
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.mkdir(preparingDirectory);
      const written = await atomicWriter.writeStream(
        path.join(preparingDirectory, 'next'),
        limitedStaticSource(source, metadata.maxBytes),
      );
      const summary: StaticFileSummary = {
        path: location.normalized,
        size: written.size,
        mediaType: metadata.mediaType,
      };
      const after = new Map(before);
      after.set(location.normalized, summary);
      const journal: StaticTransactionJournal = {
        transactionId,
        operation: 'put',
        path: location.normalized,
        before,
        after,
      };
      await atomicWriter.writeJson(
        path.join(preparingDirectory, STATIC_TRANSACTION_JOURNAL),
        serializeStaticTransaction(journal),
      );
      await fs.promises.rename(preparingDirectory, pendingDirectory);
      await publishStaticTransactionPointer(projectId, pendingDirectory, journal);
      return { pendingDirectory, journal, summary };
    } catch (error) {
      await fs.promises.rm(preparingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw mapStaticIoError(error);
    }
  }

  async function prepareDeleteStaticTransaction(
    projectId: string,
    location: ReturnType<typeof staticLocation>,
    before: Map<string, StaticFileSummary>,
  ): Promise<{ pendingDirectory: string; journal: StaticTransactionJournal }> {
    const transactionId = randomUUID().replaceAll('-', '');
    const root = transactionRoot(projectId);
    const preparingDirectory = path.join(root, `preparing-${transactionId}`);
    const pendingDirectory = path.join(root, `pending-${transactionId}`);
    const after = new Map(before);
    after.delete(location.normalized);
    const journal: StaticTransactionJournal = {
      transactionId,
      operation: 'delete',
      path: location.normalized,
      before,
      after,
    };
    try {
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.mkdir(preparingDirectory);
      await atomicWriter.writeJson(
        path.join(preparingDirectory, STATIC_TRANSACTION_JOURNAL),
        serializeStaticTransaction(journal),
      );
      await fs.promises.rename(preparingDirectory, pendingDirectory);
      await publishStaticTransactionPointer(projectId, pendingDirectory, journal);
      return { pendingDirectory, journal };
    } catch (error) {
      await fs.promises.rm(preparingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw mapStaticIoError(error);
    }
  }

  async function waitForOwnership<T>(ownership: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void ownership.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  function buildCurrentImportPlan(
    snapshot: ValidatedProjectSnapshot,
    input: ImportPreviewRequest,
  ): { plan: ImportPlan; variablesDigest: string } {
    const variablesDigest = digestVariables(input.variables ?? {}, importVariableDigestKey);
    return {
      plan: buildImportPlan(snapshot, parseImport(input), variablesDigest),
      variablesDigest,
    };
  }

  function repositoryImportCanonicalDigest(snapshot: ValidatedProjectSnapshot): string {
    const endpointNames = [...snapshot.endpoints.values()]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map(endpoint => ({ id: endpoint.id, name: endpoint.name }));
    return sha256Identity('repository-import-canonical-v1', {
      canonicalDigest: canonicalImportDigest(snapshot),
      endpointNames,
    });
  }

  function validateImportSelectionStructure(
    plan: ImportPlan,
    input: ImportCommitRequest,
  ): Map<string, ImportAction> {
    const items = new Map(plan.items.map(item => [item.preview.id, item]));
    if (items.size !== plan.items.length) throw invalidImportSelection();
    const selected = new Set(input.selectedItemIds);
    if (selected.size !== input.selectedItemIds.length
      || input.selectedItemIds.some(itemId => !items.has(itemId))) {
      throw invalidImportSelection();
    }

    const actions = new Map<string, ImportAction>();
    for (const action of input.actions) {
      if (actions.has(action.itemId) || !items.has(action.itemId)) throw invalidImportSelection();
      actions.set(action.itemId, action);
    }
    if (actions.size !== selected.size
      || [...selected].some(itemId => !actions.has(itemId))
      || [...actions].some(([itemId]) => !selected.has(itemId))) {
      throw invalidImportSelection();
    }

    return actions;
  }

  function validateImportSelectionSemantics(
    plan: ImportPlan,
    actions: Map<string, ImportAction>,
  ): void {
    const items = new Map(plan.items.map(item => [item.preview.id, item.preview]));
    for (const [itemId, action] of actions) {
      const keys = Object.keys(action).sort();
      const structurallyValid = action.action === 'create'
        ? (keys.join(',') === 'action,itemId'
          || (keys.join(',') === 'action,confirmOverlap,itemId'
            && typeof action.confirmOverlap === 'boolean'))
        : action.action === 'merge'
          ? keys.join(',') === 'action,endpointId,itemId' && typeof action.endpointId === 'string'
          : action.action === 'skip' && keys.join(',') === 'action,itemId';
      if (!structurallyValid) throw invalidImportSelection();
      const item = items.get(itemId)!;
      const invalidItem = item.errors.length > 0
        || (item.allowedActions.length === 1 && item.allowedActions[0] === 'skip');
      if (invalidItem) throw invalidImportSelection();
    }
  }

  async function allocateImportId(
    prefix: string,
    unavailable: (candidate: string) => boolean | Promise<boolean>,
  ): Promise<string> {
    try {
      return await allocateId(prefix, unavailable);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'ID_GENERATION_EXHAUSTED') {
        throw new HttpError(409, 'ID_COLLISION', 'Stable import ID allocation was exhausted');
      }
      throw error;
    }
  }

  return {
    async initialize(): Promise<RepositoryDiagnostics> {
      snapshots.clear();
      compiled.clear();
      staticFiles.clear();
      diagnostics = [];
      await fs.promises.mkdir(rootDirectory, { recursive: true });
      await atomicWriter.writeJsonIfAbsent(workspacePath, { schemaVersion: 4, revision: 0 });
      await fs.promises.mkdir(projectsRoot, { recursive: true });
      await fs.promises.mkdir(path.join(rootDirectory, 'trash'), { recursive: true });
      const workspaceResult = await readWorkspace();
      workspace = workspaceResult.value;
      diagnostics.push(...workspaceResult.findings);

      const entries = (await fs.promises.readdir(projectsRoot, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.staging-')) {
          diagnostics.push({
            severity: 'blocking',
            code: 'INCOMPLETE_PROJECT_STAGING',
            file: `projects/${entry.name}`,
            message: 'An incomplete staged Project was found.',
            recovery: 'Inspect and remove or recover the staged Project directory.',
          });
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || !isStablePathSegment(entry.name)) {
          diagnostics.push({
            severity: 'blocking', code: 'INVALID_PROJECT_DIRECTORY', projectId: entry.name,
            file: `projects/${entry.name}`,
            message: 'Project storage entry is not a safe regular directory.',
            recovery: 'Restore the Project as a safe directory with a stable ID.',
          });
          continue;
        }
        const loaded = await loadAndCompile(entry.name);
        diagnostics.push(...loaded.findings);
        if (loaded.compiledSuccessfully) {
          snapshots.set(entry.name, loaded.snapshot);
          compiled.set(entry.name, loaded.compiledValue);
          staticFiles.set(entry.name, loaded.staticEntries);
        }
      }

      if (workspace.activeProjectId !== undefined && !snapshots.has(workspace.activeProjectId)) {
        diagnostics.push({
          severity: 'blocking', code: 'INVALID_WORKSPACE_SELECTION', file: 'workspace.json',
          path: '$.activeProjectId',
          message: 'Workspace selection references a missing or invalid Project.',
          recovery: 'Select a valid Project or explicitly clear the selection.',
        });
        workspace = { schemaVersion: 4, revision: workspace.revision };
      }
      return { diagnostics: clone(diagnostics) };
    },

    async reloadProject(projectId): Promise<void> {
      requireStableId(projectId, 'project');
      await enqueue(projectId, async () => {
        const loaded = await loadAndCompile(projectId);
        replaceProjectDiagnostics(projectId, loaded.findings);
        if (!loaded.compiledSuccessfully) throw invalidProject(loaded.findings);
        snapshots.set(projectId, loaded.snapshot);
        compiled.set(projectId, loaded.compiledValue);
        staticFiles.set(projectId, loaded.staticEntries);
      });
    },

    listProjects(): ProjectSummary[] {
      return [...snapshots.values()]
        .map(({ project }) => ({
          id: project.id,
          name: project.name,
          ...(project.description === undefined ? {} : { description: project.description }),
          revision: project.revision,
          updatedAt: project.updatedAt,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(clone);
    },

    getProject(projectId): Project {
      return clone(requireSnapshot(projectId).project);
    },

    async createProject(input): Promise<Project> {
      return enqueue('__projects__', async () => {
        const projectId = await allocateId('prj', async candidate => snapshots.has(candidate)
          || diagnostics.some(finding => finding.projectId === candidate)
          || await pathExists(projectRoot(candidate)));
        const generationId = await allocateId(
          'gen',
          async candidate => [...snapshots.values()].some(snapshot => snapshot.generationId === candidate)
            || await pathExists(path.join(projectRoot(projectId), 'generations', candidate)),
        );
        const now = new Date().toISOString();
        const candidate: ValidatedProjectSnapshot = {
          project: {
            schemaVersion: 4,
            id: projectId,
            name: input.name,
            ...(input.description === undefined ? {} : { description: input.description }),
            appStateMode: 'enabled',
            revision: 0,
            createdAt: now,
            updatedAt: now,
          },
          settings: {
            schemaVersion: 4,
            projectId,
            interceptHosts: [],
            captureRawTraffic: false,
            debugProvenanceHeaders: false,
            revision: 0,
          },
          endpoints: new Map(),
          states: new Map(),
          bodyAssets: new Map(),
          generationId,
        };
        const prepared = await prepare(candidate);
        const staging = path.join(projectsRoot, `.staging-${randomUUID()}`);
        const stagedGeneration = path.join(staging, 'generations', generationId);
        let staged = true;
        try {
          await fs.promises.mkdir(path.join(stagedGeneration, 'endpoints'), { recursive: true });
          await fs.promises.mkdir(path.join(stagedGeneration, 'states'), { recursive: true });
          await fs.promises.mkdir(path.join(staging, 'bodies', 'sha256'), { recursive: true });
          await fs.promises.mkdir(path.join(staging, 'static'), { recursive: true });
          await atomicWriter.writeJson(path.join(stagedGeneration, 'project.json'), prepared.snapshot.project);
          await atomicWriter.writeJson(path.join(stagedGeneration, 'settings.json'), prepared.snapshot.settings);
          await atomicWriter.writeJson(
            path.join(staging, 'static', STATIC_METADATA_FILE),
            serializeStaticMetadata(new Map()),
          );
          await atomicWriter.writeJson(path.join(staging, 'current.json'), { schemaVersion: 4, generationId });
          await fs.promises.rename(staging, projectRoot(projectId));
          staged = false;
          publish(projectId, prepared);
          staticFiles.set(projectId, new Map());
          return clone(prepared.snapshot.project);
        } finally {
          if (staged) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    },

    async updateProject(projectId, expectedRevision, patch): Promise<Project> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        if (current.project.revision !== expectedRevision) {
          throw revisionConflict(expectedRevision, current.project.revision);
        }
        const candidate = cloneSnapshot(current);
        if (patch.name !== undefined) candidate.project.name = patch.name;
        applyNullablePatch(candidate.project, patch, 'description');
        candidate.project.revision += 1;
        candidate.project.updatedAt = new Date().toISOString();
        const published = await publishJson(projectId, candidate, 'project.json', value => value.project);
        return clone(published.project);
      });
    },

    async deleteProject(projectId, expectedRevision): Promise<void> {
      await enqueue('__workspace__', () => enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        if (current.project.revision !== expectedRevision) {
          throw revisionConflict(expectedRevision, current.project.revision);
        }
        if (workspace.activeProjectId === projectId) {
          throw new HttpError(409, 'ACTIVE_PROJECT', 'Active Project must be cleared before deletion');
        }
        const trashRoot = path.join(rootDirectory, 'trash');
        await fs.promises.mkdir(trashRoot, { recursive: true });
        await fs.promises.rename(
          projectRoot(projectId),
          path.join(trashRoot, `${projectId}-${Date.now()}-${randomUUID()}`),
        );
        snapshots.delete(projectId);
        compiled.delete(projectId);
        staticFiles.delete(projectId);
        replaceProjectDiagnostics(projectId, []);
      }));
    },

    getWorkspaceState(): WorkspaceState {
      return clone(workspace);
    },

    async setActiveProject(projectId, expectedRevision): Promise<WorkspaceState> {
      return enqueue('__workspace__', async () => {
        if (workspace.revision !== expectedRevision) {
          throw revisionConflict(expectedRevision, workspace.revision);
        }
        if (projectId !== null) requireSnapshot(projectId);
        const candidate: WorkspaceState = {
          schemaVersion: 4,
          ...(projectId === null ? {} : { activeProjectId: projectId }),
          revision: workspace.revision + 1,
        };
        const parsed = WorkspaceStateSchema.safeParse(candidate);
        if (!parsed.success) throw new HttpError(422, 'INVALID_WORKSPACE', 'Workspace state is invalid');
        await atomicWriter.writeJson(workspacePath, parsed.data);
        workspace = parsed.data;
        return clone(workspace);
      });
    },

    getRuntimeSettings(projectId): ProjectRuntimeSettings {
      return clone(requireSnapshot(projectId).settings);
    },

    getInterceptionGuidanceSources(projectId): InterceptionGuidanceSources {
      const snapshot = requireSnapshot(projectId);
      return {
        endpointOrigins: [...snapshot.endpoints.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(endpoint => endpoint.baseUrl),
        configuredPatterns: clone(snapshot.settings.interceptHosts),
      };
    },

    async updateRuntimeSettings(projectId, input): Promise<ProjectRuntimeSettings> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        if (current.settings.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, current.settings.revision);
        }
        const candidate = cloneSnapshot(current);
        for (const key of ['interceptHosts', 'captureRawTraffic', 'debugProvenanceHeaders'] as const) {
          candidate.settings[key] = clone(input[key]) as never;
        }
        candidate.settings.revision += 1;
        const published = await publishJson(projectId, candidate, 'settings.json', value => value.settings);
        return clone(published.settings);
      });
    },

    previewImport(projectId, input): ImportPreview {
      const current = requireSnapshot(projectId);
      const { plan, variablesDigest } = buildCurrentImportPlan(current, input);
      const canonicalDigest = repositoryImportCanonicalDigest(current);
      const planDigest = importPlanDigest(plan, variablesDigest);
      return clone({
        ...plan.preview,
        snapshotToken: importTokenCodec.issue({
          projectId,
          sourceType: plan.preview.sourceType,
          canonicalDigest,
          planDigest,
        }),
      });
    },

    async commitImport(projectId, input): Promise<ImportCommitResult> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const { plan, variablesDigest } = buildCurrentImportPlan(current, input);
        if (plan.preview.unresolvedVariables.length > 0) {
          throw importError(
            'IMPORT_VARIABLES_REQUIRED',
            'Import URL variables must be resolved before commit',
          );
        }
        const actions = validateImportSelectionStructure(plan, input);
        const token = importTokenCodec.verify(input.snapshotToken);
        const canonicalDigest = repositoryImportCanonicalDigest(current);
        if (token.projectId !== projectId || token.canonicalDigest !== canonicalDigest) {
          throw staleImportPreview();
        }
        const planDigest = importPlanDigest(plan, variablesDigest);
        if (token.sourceType !== plan.preview.sourceType || token.planDigest !== planDigest) {
          throw invalidImportSelection();
        }
        validateImportSelectionSemantics(plan, actions);

        const effectiveItems: Array<{
          planned: ImportPlan['items'][number];
          action: Exclude<ImportAction, { action: 'skip' }>;
          responses: PlannedImportResponse[];
        }> = [];
        for (const planned of plan.items) {
          const action = actions.get(planned.preview.id);
          if (!action) continue;
          if (!planned.preview.allowedActions.includes(action.action)) throw invalidImportSelection();
          if (action.action === 'skip') continue;
          if (action.action === 'merge') {
            const target = planned.preview.exactTargets.find(value => value.endpointId === action.endpointId);
            const responses = planned.mergeResponsesByEndpointId.get(action.endpointId);
            if (!target || !responses) throw invalidImportSelection();
            if (responses.length > 0) effectiveItems.push({ planned, action, responses });
            continue;
          }
          if (planned.preview.overlaps.some(overlap => overlap.confirmationRequired)
            && action.confirmOverlap !== true) {
            throw invalidImportSelection();
          }
          if (planned.createResponses.length > 0) {
            effectiveItems.push({ planned, action, responses: planned.createResponses });
          }
        }
        if (effectiveItems.length === 0) {
          throw importError('IMPORT_NO_CHANGES', 'Import selection has no effective changes');
        }

        const reservedEndpointIds = new Set(current.endpoints.keys());
        const reservedVariantIds = new Set([...current.endpoints.values()].flatMap(endpoint => (
          endpoint.variants.map(variant => variant.id)
        )));
        const allocations = new Map<string, { endpointId?: string; variantIds: string[] }>();
        for (const item of effectiveItems) {
          let endpointId: string | undefined;
          if (item.action.action === 'create') {
            endpointId = await allocateImportId('ep', async candidate => (
              reservedEndpointIds.has(candidate)
              || await pathExists(path.join(generationRoot(current), 'endpoints', `${candidate}.json`))
            ));
            reservedEndpointIds.add(endpointId);
          }
          const variantIds: string[] = [];
          for (let index = 0; index < item.responses.length; index += 1) {
            const variantId = await allocateImportId('var', candidate => reservedVariantIds.has(candidate));
            reservedVariantIds.add(variantId);
            variantIds.push(variantId);
          }
          allocations.set(item.planned.preview.id, {
            ...(endpointId === undefined ? {} : { endpointId }),
            variantIds,
          });
        }

        const bodyTransaction = await bodyStore.beginImport(projectId);
        let publicationStarted = false;
        try {
          const candidate = cloneSnapshot(current);
          const createdEndpointIds: string[] = [];
          const updatedEndpointIds: string[] = [];
          const createdVariantIds: string[] = [];
          for (const item of effectiveItems) {
            const allocation = allocations.get(item.planned.preview.id)!;
            if (item.action.action === 'create') {
              const endpointId = allocation.endpointId!;
              const variants: ResponseVariant[] = [];
              for (let index = 0; index < item.responses.length; index += 1) {
                const response = item.responses[index];
                const variantId = allocation.variantIds[index];
                const asset = response.body === undefined
                  ? undefined
                  : await bodyTransaction.stage(response.body, {
                      mediaType: 'application/octet-stream',
                    });
                variants.push({
                  id: variantId,
                  endpointId,
                  name: response.summary.name,
                  status: response.summary.status,
                  responseHeaders: clone(response.summary.responseHeaders),
                  ...(asset === undefined ? {} : { bodyAssetId: asset.id }),
                  revision: 0,
                });
                createdVariantIds.push(variantId);
              }
              const endpoint: EndpointDetail = {
                schemaVersion: 4,
                id: endpointId,
                projectId,
                name: item.planned.preview.name,
                ...(item.planned.preview.description === undefined
                  ? {}
                  : { description: item.planned.preview.description }),
                baseUrl: item.planned.canonicalRequest.baseUrl,
                matcher: clone(item.planned.canonicalRequest.matcher),
                mode: 'mock',
                defaultVariantId: variants[0].id,
                variants,
                revision: 0,
              };
              (candidate.endpoints as Map<string, EndpointDetail>).set(endpointId, endpoint);
              createdEndpointIds.push(endpointId);
              continue;
            }

            const endpoint = (candidate.endpoints as Map<string, EndpointDetail>)
              .get(item.action.endpointId);
            if (!endpoint) throw staleImportPreview();
            const identities = new Set(endpoint.variants.map(responseIdentity));
            let additions = 0;
            for (let index = 0; index < item.responses.length; index += 1) {
              const response = item.responses[index];
              if (identities.has(response.summary.identity)) continue;
              identities.add(response.summary.identity);
              const variantId = allocation.variantIds[index];
              const asset = response.body === undefined
                ? undefined
                : await bodyTransaction.stage(response.body, {
                    mediaType: 'application/octet-stream',
                  });
              endpoint.variants.push({
                id: variantId,
                endpointId: endpoint.id,
                name: response.summary.name,
                status: response.summary.status,
                responseHeaders: clone(response.summary.responseHeaders),
                ...(asset === undefined ? {} : { bodyAssetId: asset.id }),
                revision: 0,
              });
              createdVariantIds.push(variantId);
              additions += 1;
            }
            if (additions > 0) {
              endpoint.revision += 1;
              updatedEndpointIds.push(endpoint.id);
            }
          }

          publicationStarted = true;
          await publishGeneration(projectId, candidate, bodyTransaction);
          const validItems = plan.items.filter(item => !(
            item.preview.errors.length > 0
            || (item.preview.allowedActions.length === 1 && item.preview.allowedActions[0] === 'skip')
          ));
          const skippedItemIds = validItems
            .filter(item => !actions.has(item.preview.id) || actions.get(item.preview.id)!.action === 'skip')
            .map(item => item.preview.id);
          return {
            createdEndpointIds,
            updatedEndpointIds,
            createdVariantIds,
            skippedItemIds,
          };
        } catch (error) {
          if (!publicationStarted) {
            try {
              await bodyTransaction.rollback();
            } catch {
              // Preserve the import operation error.
            }
          }
          if (error instanceof HttpError && error.code === 'ID_GENERATION_EXHAUSTED') {
            throw new HttpError(409, 'ID_COLLISION', 'Stable import ID allocation was exhausted');
          }
          throw error;
        }
      });
    },

    async lookupTrafficPromotionReceipt(projectId, trafficId, input) {
      const current = requireSnapshot(projectId);
      return lookupTrafficPromotionReceipt(current.endpoints.values(), trafficId, input);
    },

    async promoteTraffic(snapshot, lease, input) {
      return enqueue(snapshot.projectId, async () => {
        const receipt = lookupTrafficPromotionReceipt(
          requireSnapshot(snapshot.projectId).endpoints.values(),
          snapshot.trafficId,
          input,
        );
        if (receipt.state === 'exact') {
          return { result: receipt.result, async complete() {} };
        }
        if (receipt.state === 'conflict') {
          throw new HttpError(
            409,
            'TRAFFIC_PROMOTION_CONFLICT',
            'Traffic was already promoted with a different command',
          );
        }
        if (snapshot.projectId !== snapshot.accepted.projectId
          || snapshot.trafficId !== snapshot.accepted.trafficId
          || snapshot.generation !== snapshot.accepted.generation
          || lease.projectId !== snapshot.projectId
          || lease.sha256 !== snapshot.accepted.response.body.sha256
          || lease.byteCount !== snapshot.accepted.response.body.retainedSize) {
          throw new HttpError(409, 'TRAFFIC_PROMOTION_STALE', 'Traffic promotion review is stale');
        }
        await options.publicationFailpoints?.before('validation');
        const current = requireSnapshot(snapshot.projectId);
        const metadata = promotionBodyMetadata(snapshot.accepted);
        const expectedBody: BodyAsset = {
          schemaVersion: 4,
          id: lease.sha256,
          mediaType: metadata.mediaType,
          size: lease.byteCount,
          ...(metadata.encoding === undefined ? {} : { encoding: metadata.encoding }),
          createdAt: snapshot.accepted.acceptedAt,
        };
        const targets = resolveTrafficPromotionTargets(current, snapshot.accepted, input, expectedBody);
        await options.publicationFailpoints?.before('bodyStaging');
        const bodyTransaction = await bodyStore.beginImport(snapshot.projectId);
        let publicationCommitted = false;
        try {
          const body = await bodyTransaction.stageStream(
            lease.openStream(),
            { sha256: lease.sha256, byteCount: lease.byteCount },
            metadata,
          );
          const endpointId = targets.currentEndpoint === undefined
            ? await allocateId('ep', async candidate => current.endpoints.has(candidate)
              || await pathExists(path.join(generationRoot(current), 'endpoints', `${candidate}.json`)))
            : undefined;
          const variantId = targets.currentVariant === undefined
            ? await allocateId('var', candidate => [...current.endpoints.values()]
              .some(endpoint => endpoint.variants.some(variant => variant.id === candidate)))
            : undefined;
          const publication = applyTrafficPromotion({
            current,
            accepted: snapshot.accepted,
            input,
            body,
            ...(endpointId === undefined ? {} : { endpointId }),
            ...(variantId === undefined ? {} : { variantId }),
          });
          await publishGeneration(
            snapshot.projectId,
            publication.candidate,
            targets.currentVariant === undefined ? bodyTransaction : undefined,
            {
              deferBodyCompletion: true,
              ...(options.publicationFailpoints === undefined
                ? {}
                : { failpoints: options.publicationFailpoints }),
              onPointerPublished() { publicationCommitted = true; },
            },
          );
          let completed = false;
          return {
            result: structuredClone(publication.result),
            async complete() {
              if (completed) return;
              completed = true;
              await bodyTransaction.complete();
            },
          };
        } catch (error) {
          try {
            if (publicationCommitted) await bodyTransaction.complete();
            else await bodyTransaction.rollback();
          } catch {
            // Preserve the promotion error.
          }
          throw error;
        }
      });
    },

    listEndpoints(projectId): EndpointSummary[] {
      const snapshot = requireSnapshot(projectId);
      return [...snapshot.endpoints.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(endpoint => ({
          schemaVersion: endpoint.schemaVersion,
          id: endpoint.id,
          projectId: endpoint.projectId,
          name: endpoint.name,
          baseUrl: endpoint.baseUrl,
          mode: endpoint.mode,
          method: endpoint.matcher.method,
          path: endpoint.matcher.path,
          queryConstraintCount: Object.values(endpoint.matcher.query ?? {})
            .reduce((count, expressions) => count + expressions.length, 0),
          headerConstraintCount: Object.keys(endpoint.matcher.headers ?? {}).length,
          variantCount: endpoint.variants.length,
          mockReady: endpoint.variants.length > 0
            && endpoint.defaultVariantId !== undefined
            && endpoint.variants.some(variant => variant.id === endpoint.defaultVariantId),
          revision: endpoint.revision,
        }))
        .map(clone);
    },

    getEndpoint(projectId, endpointId): EndpointDetail {
      return clone(requireEndpoint(requireSnapshot(projectId), endpointId));
    },

    getEndpointDeletionImpact(projectId, endpointId): EndpointDeletionImpact {
      const snapshot = requireSnapshot(projectId);
      const endpoint = requireEndpoint(snapshot, endpointId);
      const affectedStates = [...snapshot.states.values()]
        .filter(state => Object.prototype.hasOwnProperty.call(state.bindings, endpointId))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(appStateReference);
      return {
        endpointId,
        endpointRevision: endpoint.revision,
        affectedStates,
      };
    },

    async createEndpoint(projectId, input): Promise<EndpointDetail> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const inputVariants = input.variants ?? [];
        if ((inputVariants.length > 0 && input.defaultVariantIndex === undefined)
          || (input.defaultVariantIndex !== undefined && (
            !Number.isInteger(input.defaultVariantIndex)
            || input.defaultVariantIndex < 0
            || input.defaultVariantIndex >= inputVariants.length
          ))
          || (input.mode === 'mock' && inputVariants.length === 0)) {
          throw new HttpError(422, 'INVALID_DEFAULT_VARIANT', 'Default variant index is invalid');
        }
        const endpointId = await allocateId('ep', async candidate => current.endpoints.has(candidate)
          || await pathExists(path.join(generationRoot(current), 'endpoints', `${candidate}.json`)));
        const usedVariantIds = new Set(
          [...current.endpoints.values()].flatMap(endpoint => endpoint.variants.map(variant => variant.id)),
        );
        const variants: ResponseVariant[] = [];
        for (const inputVariant of inputVariants) {
          const variantId = await allocateId('var', candidate => usedVariantIds.has(candidate));
          usedVariantIds.add(variantId);
          variants.push({ ...clone(inputVariant), id: variantId, endpointId, revision: 0 });
        }
        const endpoint: EndpointDetail = {
          schemaVersion: 4,
          id: endpointId,
          projectId,
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          baseUrl: input.baseUrl,
          matcher: clone(input.matcher),
          mode: input.mode,
          ...(input.defaultVariantIndex === undefined
            ? {}
            : { defaultVariantId: variants[input.defaultVariantIndex].id }),
          variants,
          revision: 0,
        };
        const candidate = cloneSnapshot(current);
        (candidate.endpoints as Map<string, EndpointDetail>).set(endpointId, endpoint);
        const published = await publishJson(
          projectId, candidate, `endpoints/${endpointId}.json`, value => value.endpoints.get(endpointId),
        );
        return clone(published.endpoints.get(endpointId)!);
      });
    },

    async updateEndpoint(projectId, endpointId, expectedRevision, patch): Promise<EndpointDetail> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const endpoint = requireEndpoint(current, endpointId);
        if (endpoint.revision !== expectedRevision) throw revisionConflict(expectedRevision, endpoint.revision);
        if (patch.defaultVariantId !== undefined
          && !endpoint.variants.some(variant => variant.id === patch.defaultVariantId)) {
          throw new HttpError(
            422,
            'INVALID_DEFAULT_VARIANT',
            'Fallback Variant must belong to the Endpoint',
          );
        }
        const candidate = cloneSnapshot(current);
        const updated = (candidate.endpoints as Map<string, EndpointDetail>).get(endpointId)!;
        if (patch.name !== undefined) updated.name = patch.name;
        if (patch.baseUrl !== undefined) updated.baseUrl = patch.baseUrl;
        if (patch.matcher !== undefined) updated.matcher = clone(patch.matcher);
        if (patch.defaultVariantId !== undefined) updated.defaultVariantId = patch.defaultVariantId;
        applyNullablePatch(updated, patch, 'description');
        updated.revision += 1;
        const published = await publishJson(
          projectId, candidate, `endpoints/${endpointId}.json`, value => value.endpoints.get(endpointId),
        );
        return clone(published.endpoints.get(endpointId)!);
      });
    },

    async setEndpointMode(projectId, endpointId, input): Promise<EndpointDetail> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const endpoint = requireEndpoint(current, endpointId);
        if (endpoint.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, endpoint.revision);
        }
        if (input.mode === 'mock' && (endpoint.defaultVariantId === undefined
          || !endpoint.variants.some(variant => variant.id === endpoint.defaultVariantId))) {
          throw new HttpError(
            409,
            'ENDPOINT_FALLBACK_REQUIRED',
            'Endpoint requires a fallback Variant before switching to mock mode',
          );
        }
        const candidate = cloneSnapshot(current);
        const updated = (candidate.endpoints as Map<string, EndpointDetail>).get(endpointId)!;
        updated.mode = input.mode;
        updated.revision += 1;
        const published = await publishJson(
          projectId, candidate, `endpoints/${endpointId}.json`, value => value.endpoints.get(endpointId),
        );
        return clone(published.endpoints.get(endpointId)!);
      });
    },

    async deleteEndpoint(projectId, endpointId, expectedRevision): Promise<void> {
      await enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const endpoint = requireEndpoint(current, endpointId);
        if (endpoint.revision !== expectedRevision) throw revisionConflict(expectedRevision, endpoint.revision);
        const candidate = cloneSnapshot(current);
        (candidate.endpoints as Map<string, EndpointDetail>).delete(endpointId);
        for (const state of candidate.states.values()) {
          if (!Object.prototype.hasOwnProperty.call(state.bindings, endpointId)) continue;
          delete state.bindings[endpointId];
          state.revision += 1;
        }
        await publishGeneration(projectId, candidate);
      });
    },

    async createVariant(projectId, endpointId, expectedEndpointRevision, input): Promise<ResponseVariant> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const endpoint = requireEndpoint(current, endpointId);
        if (endpoint.revision !== expectedEndpointRevision) {
          throw revisionConflict(expectedEndpointRevision, endpoint.revision);
        }
        const variantId = await allocateId('var', candidate => [...current.endpoints.values()]
          .some(value => value.variants.some(variant => variant.id === candidate)));
        const variant: ResponseVariant = {
          ...clone(input), id: variantId, endpointId, revision: 0,
        };
        const candidate = cloneSnapshot(current);
        const updated = (candidate.endpoints as Map<string, EndpointDetail>).get(endpointId)!;
        if (updated.variants.length === 0) updated.defaultVariantId = variant.id;
        updated.variants.push(variant);
        updated.revision += 1;
        const published = await publishJson(
          projectId, candidate, `endpoints/${endpointId}.json`, value => value.endpoints.get(endpointId),
        );
        return clone(published.endpoints.get(endpointId)!.variants.find(value => value.id === variant.id)!);
      });
    },

    async updateVariant(projectId, endpointId, variantId, expectedRevision, patch): Promise<ResponseVariant> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const endpoint = requireEndpoint(current, endpointId);
        const existing = endpoint.variants.find(variant => variant.id === variantId);
        if (!existing) throw notFound('variant');
        if (existing.revision !== expectedRevision) throw revisionConflict(expectedRevision, existing.revision);
        const candidate = cloneSnapshot(current);
        const updated = (candidate.endpoints as Map<string, EndpointDetail>)
          .get(endpointId)!.variants.find(variant => variant.id === variantId)!;
        for (const key of ['name', 'status', 'responseHeaders'] as const) {
          if (patch[key] !== undefined) updated[key] = clone(patch[key]) as never;
        }
        applyNullablePatch(updated, patch, 'description');
        applyNullablePatch(updated, patch, 'bodyAssetId');
        applyNullablePatch(updated, patch, 'delayMs');
        updated.revision += 1;
        const published = await publishJson(
          projectId, candidate, `endpoints/${endpointId}.json`, value => value.endpoints.get(endpointId),
        );
        return clone(published.endpoints.get(endpointId)!.variants.find(variant => variant.id === variantId)!);
      });
    },

    getVariantDeletionImpact(projectId, endpointId, variantId): VariantDeletionImpact {
      const snapshot = requireSnapshot(projectId);
      const endpoint = requireEndpoint(snapshot, endpointId);
      const variant = endpoint.variants.find(value => value.id === variantId);
      if (!variant) throw notFound('variant');
      const affectedStates = [...snapshot.states.values()]
        .filter(state => state.bindings[endpointId] === variantId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(appStateReference);
      const replacementVariants = endpoint.variants
        .filter(value => value.id !== variantId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(value => ({ id: value.id, name: value.name, revision: value.revision }));
      return {
        endpointId,
        endpointRevision: endpoint.revision,
        variantId,
        variantRevision: variant.revision,
        isFallback: endpoint.defaultVariantId === variantId,
        affectedStates,
        replacementVariants,
      };
    },

    async deleteVariant(
      projectId,
      endpointId,
      variantId,
      expectedRevision,
      options: VariantDeleteOptions = {},
    ): Promise<void> {
      await enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const endpoint = requireEndpoint(current, endpointId);
        const variant = endpoint.variants.find(value => value.id === variantId);
        if (!variant) throw notFound('variant');
        if (variant.revision !== expectedRevision) throw revisionConflict(expectedRevision, variant.revision);
        const isFallback = endpoint.defaultVariantId === variantId;
        if (endpoint.variants.length === 1 && endpoint.mode === 'mock') {
          throw new HttpError(
            409,
            'ENDPOINT_FALLBACK_REQUIRED',
            'Mock Endpoints require a fallback Variant',
          );
        }
        const affectedStates = [...current.states.values()]
          .filter(state => state.bindings[endpointId] === variantId);
        if (affectedStates.length > 0) {
          throw new HttpError(
            409,
            'VARIANT_IN_USE',
            'Variant is referenced by one or more App States',
          );
        }
        if (endpoint.variants.length === 1) {
          const candidate = cloneSnapshot(current);
          const updated = (candidate.endpoints as Map<string, EndpointDetail>).get(endpointId)!;
          updated.variants = [];
          delete updated.defaultVariantId;
          updated.revision += 1;
          await publishGeneration(projectId, candidate);
          return;
        }
        const hasExpectedEndpointRevision = options.expectedEndpointRevision !== undefined;
        const hasReplacementVariantId = options.replacementVariantId !== undefined;
        if ((isFallback && (!hasExpectedEndpointRevision || !hasReplacementVariantId))
          || hasExpectedEndpointRevision !== hasReplacementVariantId) {
          throw new HttpError(
            409,
            'VARIANT_REPLACEMENT_REQUIRED',
            'Deleting this Variant requires a replacement and current Endpoint revision',
          );
        }
        let replacementVariant: ResponseVariant | undefined;
        if (hasExpectedEndpointRevision && hasReplacementVariantId) {
          if (endpoint.revision !== options.expectedEndpointRevision) {
            throw revisionConflict(options.expectedEndpointRevision!, endpoint.revision);
          }
          replacementVariant = endpoint.variants.find(value => (
            value.id === options.replacementVariantId && value.id !== variantId
          ));
          if (!replacementVariant) {
            throw new HttpError(
              422,
              'INVALID_VARIANT_REPLACEMENT',
              'Replacement Variant must be different and belong to the Endpoint',
            );
          }
        }
        const candidate = cloneSnapshot(current);
        const updated = (candidate.endpoints as Map<string, EndpointDetail>).get(endpointId)!;
        if (isFallback) updated.defaultVariantId = replacementVariant!.id;
        updated.variants = updated.variants.filter(value => value.id !== variantId);
        updated.revision += 1;
        await publishGeneration(projectId, candidate);
      });
    },

    listStates(projectId): AppStateSummary[] {
      const snapshot = requireSnapshot(projectId);
      const compiledProject = compiled.get(projectId)!;
      return [...snapshot.states.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(state => {
          const coverage = calculateStateCoverage(compiledProject, state.id);
          return {
            id: state.id,
            projectId: state.projectId,
            name: state.name,
            tags: clone(state.tags),
            revision: state.revision,
            boundEndpointCount: coverage.bound,
            totalEndpointCount: coverage.total,
            missingEndpointIds: coverage.missingEndpointIds,
          };
        })
        .map(clone);
    },

    getState(projectId, stateId): AppState {
      return clone(requireState(requireSnapshot(projectId), stateId));
    },

    async createState(projectId, input): Promise<AppState> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const stateId = await allocateId('state', async candidate => current.states.has(candidate)
          || await pathExists(path.join(generationRoot(current), 'states', `${candidate}.json`)));
        const state: AppState = { ...clone(input), schemaVersion: 4, id: stateId, projectId, revision: 0 };
        const candidate = cloneSnapshot(current);
        (candidate.states as Map<string, AppState>).set(stateId, state);
        const published = await publishJson(
          projectId, candidate, `states/${stateId}.json`, value => value.states.get(stateId),
        );
        return clone(published.states.get(stateId)!);
      });
    },

    async updateState(projectId, stateId, expectedRevision, patch): Promise<AppState> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const state = requireState(current, stateId);
        if (state.revision !== expectedRevision) throw revisionConflict(expectedRevision, state.revision);
        const candidate = cloneSnapshot(current);
        const updated = (candidate.states as Map<string, AppState>).get(stateId)!;
        for (const key of ['name', 'tags', 'bindings'] as const) {
          if (patch[key] !== undefined) updated[key] = clone(patch[key]) as never;
        }
        applyNullablePatch(updated, patch, 'description');
        applyNullablePatch(updated, patch, 'expectedUi');
        updated.revision += 1;
        const published = await publishJson(
          projectId, candidate, `states/${stateId}.json`, value => value.states.get(stateId),
        );
        return clone(published.states.get(stateId)!);
      });
    },

    async deleteState(projectId, stateId, expectedRevision): Promise<void> {
      await enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        const state = requireState(current, stateId);
        if (state.revision !== expectedRevision) throw revisionConflict(expectedRevision, state.revision);
        const candidate = cloneSnapshot(current);
        (candidate.states as Map<string, AppState>).delete(stateId);
        let selectionChanged = false;
        if (candidate.project.activeStateId === stateId) {
          delete candidate.project.activeStateId;
          selectionChanged = true;
        }
        if (candidate.project.baseStateId === stateId) {
          delete candidate.project.baseStateId;
          selectionChanged = true;
        }
        if (selectionChanged) {
          candidate.project.revision += 1;
          candidate.project.updatedAt = new Date().toISOString();
        }
        await publishGeneration(projectId, candidate);
      });
    },

    async setStateSelection(projectId, expectedRevision, input): Promise<Project> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        if (current.project.revision !== expectedRevision) {
          throw revisionConflict(expectedRevision, current.project.revision);
        }
        for (const stateId of [input.activeStateId, input.baseStateId]) {
          if (stateId !== undefined && stateId !== null) {
            requireState(current, stateId);
            const coverage = calculateStateCoverage(compiled.get(projectId)!, stateId);
            if (!input.allowFallback && coverage.missingEndpointIds.length > 0) {
              throw new HttpError(409, 'INCOMPLETE_STATE_COVERAGE', 'App State does not bind every Endpoint', {
                details: { stateId, ...coverage },
              });
            }
          }
        }
        const candidate = cloneSnapshot(current);
        applyNullablePatch(candidate.project, input, 'activeStateId');
        applyNullablePatch(candidate.project, input, 'baseStateId');
        candidate.project.revision += 1;
        candidate.project.updatedAt = new Date().toISOString();
        const published = await publishJson(projectId, candidate, 'project.json', value => value.project);
        return clone(published.project);
      });
    },

    async setAppStateMode(projectId, input): Promise<Project> {
      return enqueue(projectId, async () => {
        const current = requireSnapshot(projectId);
        if (current.project.revision !== input.expectedProjectRevision) {
          throw revisionConflict(input.expectedProjectRevision, current.project.revision);
        }
        const candidate = cloneSnapshot(current);
        candidate.project.appStateMode = input.appStateMode;
        candidate.project.revision += 1;
        candidate.project.updatedAt = new Date().toISOString();
        const published = await publishJson(projectId, candidate, 'project.json', value => value.project);
        return clone(published.project);
      });
    },

    resolve(projectId, request): EndpointDecision | null {
      const current = compiled.get(projectId);
      if (!current) return null;
      const match = matchRequest(current, request);
      return match === null ? null : resolveEndpoint(current, match);
    },

    listAllDiagnostics(): RepositoryDiagnostic[] {
      return clone(diagnostics);
    },

    listDiagnostics(projectId): RepositoryDiagnostic[] {
      return clone(diagnostics.filter(finding => finding.projectId === projectId));
    },

    listStaticFiles(projectId): StaticFileSummary[] {
      requireSnapshot(projectId);
      return [...(staticFiles.get(projectId) ?? new Map()).values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(clone);
    },

    async putStaticFile(projectId, relativePath, stream, metadata): Promise<StaticFileSummary> {
      return enqueue(projectId, async () => {
        requireSnapshot(projectId);
        await requireRecoveredStaticTransactions(projectId);
        if (!Number.isSafeInteger(metadata.maxBytes) || metadata.maxBytes < 0 || metadata.mediaType.length === 0) {
          throw new HttpError(400, 'INVALID_STATIC_METADATA', 'Static file metadata is invalid');
        }
        const location = staticLocation(projectId, relativePath);
        try {
          await assertSafeStaticComponents(projectId, location.absolute);
          await fs.promises.mkdir(location.staticRoot, { recursive: true });
          await fs.promises.mkdir(path.dirname(location.absolute), { recursive: true });
        } catch (error) {
          throw mapStaticIoError(error);
        }
        const before = new Map(staticFiles.get(projectId) ?? new Map());
        const transaction = await preparePutStaticTransaction(
          projectId, location, stream, metadata, before,
        );
        const previousPath = path.join(transaction.pendingDirectory, 'previous');
        let committedDirectory: string | undefined;
        try {
          const stats = await lstatIfPresent(location.absolute);
          if (transaction.journal.before.has(location.normalized)) {
            if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
              throw new HttpError(422, 'STATIC_FILE_INTEGRITY_ERROR', 'Static file changed during publication');
            }
            await fs.promises.rename(location.absolute, previousPath);
          } else if (stats) {
            throw new HttpError(422, 'STATIC_FILE_INTEGRITY_ERROR', 'Static file changed during publication');
          }
          await fs.promises.rename(path.join(transaction.pendingDirectory, 'next'), location.absolute);
          await atomicWriter.writeJson(
            path.join(location.staticRoot, STATIC_METADATA_FILE),
            serializeStaticMetadata(transaction.journal.after),
          );
          committedDirectory = path.join(
            path.dirname(transaction.pendingDirectory),
            `committed-${transaction.journal.transactionId}`,
          );
          await fs.promises.rename(transaction.pendingDirectory, committedDirectory);
        } catch (error) {
          try {
            await finishStaticRestore(projectId, transaction.pendingDirectory, transaction.journal);
          } catch {
            throw transactionIncomplete();
          }
          throw mapStaticIoError(error);
        }
        staticFiles.set(projectId, transaction.journal.after);
        await releaseCommittedStaticTransaction(projectId, committedDirectory);
        return clone(transaction.summary);
      });
    },

    openStaticFile(projectId, relativePath): NodeJS.ReadableStream {
      requireSnapshot(projectId);
      const location = staticLocation(projectId, relativePath);
      const controller = new AbortController();
      let ownedHandle: fs.promises.FileHandle | undefined;
      const ownership = enqueue(projectId, async () => {
        requireSnapshot(projectId);
        await requireRecoveredStaticTransactions(projectId);
        if (controller.signal.aborted) throw controller.signal.reason;
        const committed = staticFiles.get(projectId)?.get(location.normalized);
        if (!committed) {
          throw new HttpError(404, 'STATIC_FILE_NOT_FOUND', 'Static file was not found');
        }
        await assertSafeStaticComponents(projectId, location.absolute);
        const pathStats = await fs.promises.lstat(location.absolute);
        if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
          throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
        }
        ownedHandle = await fs.promises.open(
          location.absolute,
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
        );
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const handleStats = await ownedHandle.stat();
          if (!handleStats.isFile()
            || handleStats.dev !== pathStats.dev
            || handleStats.ino !== pathStats.ino
            || handleStats.size !== committed.size) {
            throw new HttpError(422, 'STATIC_FILE_INTEGRITY_ERROR', 'Static file changed during validation');
          }
          return ownedHandle;
        } catch (error) {
          await ownedHandle.close().catch(() => undefined);
          ownedHandle = undefined;
          throw error;
        }
      });
      const result = Readable.from((async function* () {
        let handle: fs.promises.FileHandle | undefined;
        try {
          handle = await waitForOwnership(ownership, controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason;
          for await (const chunk of handle.createReadStream({ autoClose: false })) yield chunk;
        } catch (error) {
          if (isMissing(error)) throw new HttpError(404, 'STATIC_FILE_NOT_FOUND', 'Static file was not found');
          throw mapStaticIoError(error);
        } finally {
          await (handle ?? ownedHandle)?.close().catch(() => undefined);
          ownedHandle = undefined;
        }
      })());
      const destroy = result.destroy.bind(result);
      result.destroy = error => {
        controller.abort(error ?? new Error('Static stream was cancelled'));
        return destroy(error);
      };
      result.once('close', () => controller.abort(new Error('Static stream was cancelled')));
      return result;
    },

    async deleteStaticFile(projectId, relativePath): Promise<void> {
      await enqueue(projectId, async () => {
        requireSnapshot(projectId);
        await requireRecoveredStaticTransactions(projectId);
        const location = staticLocation(projectId, relativePath);
        const before = new Map(staticFiles.get(projectId) ?? new Map());
        if (!before.has(location.normalized)) {
          throw new HttpError(404, 'STATIC_FILE_NOT_FOUND', 'Static file was not found');
        }
        try {
          await assertSafeStaticComponents(projectId, location.absolute);
          const stats = await fs.promises.lstat(location.absolute);
          if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new HttpError(400, 'INVALID_STATIC_PATH', 'Static file path is invalid');
          }
        } catch (error) {
          if (isMissing(error)) throw new HttpError(404, 'STATIC_FILE_NOT_FOUND', 'Static file was not found');
          throw mapStaticIoError(error);
        }
        const transaction = await prepareDeleteStaticTransaction(projectId, location, before);
        const previousPath = path.join(transaction.pendingDirectory, 'previous');
        let committedDirectory: string | undefined;
        try {
          await fs.promises.rename(location.absolute, previousPath);
          await atomicWriter.writeJson(
            path.join(location.staticRoot, STATIC_METADATA_FILE),
            serializeStaticMetadata(transaction.journal.after),
          );
          committedDirectory = path.join(
            path.dirname(transaction.pendingDirectory),
            `committed-${transaction.journal.transactionId}`,
          );
          await fs.promises.rename(transaction.pendingDirectory, committedDirectory);
        } catch (error) {
          try {
            await finishStaticRestore(projectId, transaction.pendingDirectory, transaction.journal);
          } catch {
            throw transactionIncomplete();
          }
          throw mapStaticIoError(error);
        }
        staticFiles.set(projectId, transaction.journal.after);
        await releaseCommittedStaticTransaction(projectId, committedDirectory);
      });
    },

    async putBody(projectId, stream, metadata, policy): Promise<BodyAsset> {
      return enqueue(projectId, async () => {
        requireSnapshot(projectId);
        const asset = await bodyStore.put(projectId, stream, metadata, policy);
        return clone(asset);
      });
    },

    getBodyMetadata(projectId, assetId): BodyAsset {
      const asset = requireSnapshot(projectId).bodyAssets.get(assetId);
      if (asset === undefined) {
        throw new HttpError(404, 'BODY_ASSET_NOT_FOUND', 'Body Asset metadata was not found');
      }
      return clone(asset);
    },

    async getBody(projectId, assetId): Promise<BodyAsset> {
      requireSnapshot(projectId);
      return clone(await bodyStore.getMetadata(projectId, assetId));
    },

    openBody(projectId, assetId, range): NodeJS.ReadableStream {
      requireSnapshot(projectId);
      return bodyStore.openReadStream(projectId, assetId, range);
    },
  };
}
