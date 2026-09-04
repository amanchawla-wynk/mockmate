import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';

import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  GenerationPointer,
  Project,
  ProjectRuntimeSettings,
} from '../domain/model';
import {
  AppStateSchema,
  EndpointSchema,
  GenerationPointerSchema,
  ProjectRuntimeSettingsSchema,
  ProjectSchema,
} from '../domain/schemas';
import { parsePersistedRecord, type ValidationFinding } from '../domain/validation';
import { isStablePathSegment } from '../services/storage';
import type { BodyStore } from './body-store';
import { validateReferentialIntegrity } from './referential-integrity';
import type { ValidatedProjectSnapshot } from './snapshot';

export type LoadProjectResult =
  | { ok: true; snapshot: ValidatedProjectSnapshot; diagnostics: [] }
  | { ok: false; diagnostics: ValidationFinding[] };

interface LoadProjectOptions {
  rootDirectory: string;
  projectId: string;
  bodyStore: BodyStore;
}

function relativeFile(rootDirectory: string, filePath: string): string {
  return path.relative(rootDirectory, filePath).split(path.sep).join('/');
}

function malformedJson(file: string): ValidationFinding {
  return {
    severity: 'blocking',
    code: 'MALFORMED_JSON',
    file,
    message: 'The persisted record is not valid JSON.',
    recovery: 'Correct or restore the JSON record and retry loading the Project.',
  };
}

function invalidFile(file: string): ValidationFinding {
  return {
    severity: 'blocking',
    code: 'INVALID_RECORD_FILE',
    file,
    message: 'A persisted record path is not a regular JSON file.',
    recovery: 'Replace the entry with a regular JSON file or remove it.',
  };
}

function missingRecord(file: string): ValidationFinding {
  return {
    severity: 'blocking',
    code: 'MISSING_RECORD',
    file,
    message: 'A required persisted record is missing.',
    recovery: 'Restore the required record and retry loading the Project.',
  };
}

function missingRecordDirectory(file: string): ValidationFinding {
  return {
    severity: 'blocking',
    code: 'MISSING_RECORD_DIRECTORY',
    file,
    message: 'A required persisted record directory is missing.',
    recovery: 'Restore the required directory and retry loading the Project.',
  };
}

function invalidRecordId(file: string): ValidationFinding {
  return {
    severity: 'blocking',
    code: 'INVALID_RECORD_ID',
    file,
    path: '$.id',
    message: 'The persisted record ID is not a safe stable segment.',
    recovery: 'Replace the ID with a non-empty segment without separators, traversal, or NUL bytes.',
  };
}

async function hasSymlinkComponent(rootDirectory: string, candidate: string): Promise<boolean> {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  let current = path.resolve(rootDirectory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  return false;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readRecord<T>(
  rootDirectory: string,
  filePath: string,
  schema: z.ZodType<T>,
): Promise<{ value?: T; findings: ValidationFinding[] }> {
  const file = relativeFile(rootDirectory, filePath);
  let text: string;
  try {
    if (await hasSymlinkComponent(rootDirectory, filePath)) return { findings: [invalidFile(file)] };
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return { findings: [invalidFile(file)] };
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { findings: [missingRecord(file)] };
    return { findings: [invalidFile(file)] };
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { findings: [malformedJson(file)] };
  }
  const parsed = parsePersistedRecord(schema, input, file);
  return parsed.ok ? { value: parsed.value, findings: [] } : { findings: parsed.findings };
}

async function loadRecordDirectory<T extends { id: string }>(
  rootDirectory: string,
  directory: string,
  schema: z.ZodType<T>,
): Promise<{ records: Map<string, T>; findings: ValidationFinding[] }> {
  const records = new Map<string, T>();
  const findings: ValidationFinding[] = [];
  let entries: fs.Dirent[];
  try {
    if (await hasSymlinkComponent(rootDirectory, directory)) {
      return { records, findings: [invalidFile(relativeFile(rootDirectory, directory))] };
    }
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        records,
        findings: [missingRecordDirectory(relativeFile(rootDirectory, directory))],
      };
    }
    return {
      records,
      findings: [invalidFile(relativeFile(rootDirectory, directory))],
    };
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    const file = relativeFile(rootDirectory, filePath);
    if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name) !== '.json') {
      findings.push(invalidFile(file));
      continue;
    }
    const loaded = await readRecord(rootDirectory, filePath, schema);
    findings.push(...loaded.findings);
    if (!loaded.value) continue;

    const expectedId = path.basename(entry.name, '.json');
    if (!isStablePathSegment(expectedId) || !isStablePathSegment(loaded.value.id)) {
      findings.push(invalidRecordId(file));
    }
    if (loaded.value.id !== expectedId) {
      findings.push({
        severity: 'blocking',
        code: 'RECORD_ID_MISMATCH',
        file,
        path: '$.id',
        message: 'The record ID does not match its filename.',
        recovery: 'Rename the file or correct the record ID so they match.',
      });
    }
    if (records.has(loaded.value.id)) {
      findings.push({
        severity: 'blocking',
        code: 'DUPLICATE_RECORD_ID',
        file,
        path: '$.id',
        message: 'The record ID is duplicated in this generation.',
        recovery: 'Assign every persisted record a unique stable ID.',
      });
    } else {
      records.set(loaded.value.id, loaded.value);
    }
  }
  return { records, findings };
}

export async function loadProject(options: LoadProjectOptions): Promise<LoadProjectResult> {
  const { rootDirectory, projectId, bodyStore } = options;
  const projectDirectory = path.join(rootDirectory, 'projects', projectId);
  const pointerResult = await readRecord(
    rootDirectory,
    path.join(projectDirectory, 'current.json'),
    GenerationPointerSchema,
  );
  const findings = [...pointerResult.findings];
  const pointer = pointerResult.value as GenerationPointer | undefined;
  if (!pointer) return { ok: false, diagnostics: findings };
  if (!isStablePathSegment(pointer.generationId)) {
    findings.push({
      severity: 'blocking',
      code: 'INVALID_GENERATION_POINTER',
      file: relativeFile(rootDirectory, path.join(projectDirectory, 'current.json')),
      path: '$.generationId',
      message: 'The selected generation ID is not a safe path segment.',
      recovery: 'Select a generation with a stable safe ID.',
    });
    return { ok: false, diagnostics: findings };
  }

  const generationDirectory = path.join(projectDirectory, 'generations', pointer.generationId);
  const [projectResult, settingsResult, endpointResult, stateResult] = await Promise.all([
    readRecord(rootDirectory, path.join(generationDirectory, 'project.json'), ProjectSchema),
    readRecord(
      rootDirectory,
      path.join(generationDirectory, 'settings.json'),
      ProjectRuntimeSettingsSchema,
    ),
    loadRecordDirectory(rootDirectory, path.join(generationDirectory, 'endpoints'), EndpointSchema),
    loadRecordDirectory(rootDirectory, path.join(generationDirectory, 'states'), AppStateSchema),
  ]);
  findings.push(
    ...projectResult.findings,
    ...settingsResult.findings,
    ...endpointResult.findings,
    ...stateResult.findings,
  );
  const project = projectResult.value as Project | undefined;
  const settings = settingsResult.value as ProjectRuntimeSettings | undefined;
  if (project && project.id !== projectId) {
    findings.push({
      severity: 'blocking',
      code: 'RECORD_ID_MISMATCH',
      file: relativeFile(rootDirectory, path.join(generationDirectory, 'project.json')),
      path: '$.id',
      message: 'The Project ID does not match its directory name.',
      recovery: 'Rename the Project directory or correct the Project ID so they match.',
    });
  }
  if (project && !isStablePathSegment(project.id)) {
    findings.push(invalidRecordId(
      relativeFile(rootDirectory, path.join(generationDirectory, 'project.json')),
    ));
  }
  if (!project || !settings) return { ok: false, diagnostics: findings };

  const bodyAssets = new Map<string, BodyAsset>();
  const referencedAssetIds = new Set<string>();
  for (const endpoint of endpointResult.records.values() as Iterable<EndpointDetail>) {
    for (const variant of endpoint.variants) {
      if (variant.bodyAssetId) referencedAssetIds.add(variant.bodyAssetId);
    }
  }
  for (const assetId of [...referencedAssetIds].sort()) {
    try {
      bodyAssets.set(assetId, await bodyStore.getMetadata(projectId, assetId));
    } catch {
      // Referential validation emits one stable, sanitized finding at the referencing field.
    }
  }

  const snapshot: ValidatedProjectSnapshot = {
    project,
    settings,
    endpoints: endpointResult.records as Map<string, EndpointDetail>,
    states: stateResult.records as Map<string, AppState>,
    bodyAssets,
    generationId: pointer.generationId,
  };
  findings.push(...validateReferentialIntegrity(snapshot).map(finding => ({
    ...finding,
    file: relativeFile(rootDirectory, path.join(generationDirectory, finding.file)),
  })));
  return findings.length === 0
    ? { ok: true, snapshot, diagnostics: [] }
    : { ok: false, diagnostics: findings };
}
