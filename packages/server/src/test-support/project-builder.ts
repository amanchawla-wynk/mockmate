import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  GenerationPointer,
  Project,
  ProjectRuntimeSettings,
  WorkspaceState,
} from '../domain/model';

export const FIXED_TIME = '2026-08-27T00:00:00.000Z';

export function projectRecord(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 4,
    id: 'prj_1',
    name: 'Project One',
    appStateMode: 'enabled',
    revision: 1,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  };
}

export function endpointRecord(overrides: Partial<EndpointDetail> = {}): EndpointDetail {
  return {
    schemaVersion: 4,
    id: 'ep_1',
    projectId: 'prj_1',
    name: 'Get profile',
    baseUrl: 'https://api.example.test',
    matcher: { method: 'GET', path: '/profile' },
    mode: 'mock',
    defaultVariantId: 'var_1',
    variants: [{
      id: 'var_1',
      endpointId: 'ep_1',
      name: 'Default',
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      revision: 1,
    }],
    revision: 1,
    ...overrides,
  };
}

export function stateRecord(overrides: Partial<AppState> = {}): AppState {
  return {
    schemaVersion: 4,
    id: 'state_1',
    projectId: 'prj_1',
    name: 'Signed in',
    tags: ['auth'],
    bindings: { ep_1: 'var_1' },
    revision: 1,
    ...overrides,
  };
}

export function settingsRecord(
  overrides: Partial<ProjectRuntimeSettings> = {},
): ProjectRuntimeSettings {
  return {
    schemaVersion: 4,
    projectId: 'prj_1',
    interceptHosts: [],
    captureRawTraffic: false,
    debugProvenanceHeaders: false,
    revision: 1,
    ...overrides,
  };
}

export class ProjectBuilder {
  readonly projectId: string;
  readonly generationId: string;

  constructor(
    readonly root: string,
    options: { projectId?: string; generationId?: string } = {},
  ) {
    this.projectId = options.projectId ?? 'prj_1';
    this.generationId = options.generationId ?? 'gen_current';
  }

  projectDirectory(projectId = this.projectId): string {
    return path.join(this.root, 'projects', projectId);
  }

  generationDirectory(
    generationId = this.generationId,
    projectId = this.projectId,
  ): string {
    return path.join(this.projectDirectory(projectId), 'generations', generationId);
  }

  async writeWorkspace(workspace: WorkspaceState = { schemaVersion: 4, revision: 0 }): Promise<void> {
    await this.writeJson(path.join(this.root, 'workspace.json'), workspace);
  }

  async writePointer(
    generationId = this.generationId,
    projectId = this.projectId,
  ): Promise<void> {
    const pointer: GenerationPointer = { schemaVersion: 4, generationId };
    await this.writeJson(path.join(this.projectDirectory(projectId), 'current.json'), pointer);
  }

  async writeGeneration(options: {
    generationId?: string;
    project?: Project;
    settings?: ProjectRuntimeSettings;
    endpoints?: EndpointDetail[];
    states?: AppState[];
  } = {}): Promise<void> {
    const generationId = options.generationId ?? this.generationId;
    const project = options.project ?? projectRecord({ id: this.projectId });
    const settings = options.settings ?? settingsRecord({ projectId: project.id });
    const endpoints = options.endpoints ?? [endpointRecord({ projectId: project.id })];
    const states = options.states ?? [stateRecord({ projectId: project.id })];
    const generation = this.generationDirectory(generationId, project.id);

    await Promise.all([
      fs.promises.mkdir(path.join(generation, 'endpoints'), { recursive: true }),
      fs.promises.mkdir(path.join(generation, 'states'), { recursive: true }),
      this.writeJson(path.join(this.projectDirectory(project.id), 'static', '.mockmate-static.json'), {
        schemaVersion: 4,
        files: [],
      }),
    ]);
    await Promise.all([
      this.writeJson(path.join(generation, 'project.json'), project),
      this.writeJson(path.join(generation, 'settings.json'), settings),
      ...endpoints.map(endpoint => this.writeJson(
        path.join(generation, 'endpoints', `${endpoint.id}.json`),
        endpoint,
      )),
      ...states.map(state => this.writeJson(
        path.join(generation, 'states', `${state.id}.json`),
        state,
      )),
    ]);
  }

  async writeValid(options: Parameters<ProjectBuilder['writeGeneration']>[0] = {}): Promise<void> {
    const project = options.project ?? projectRecord({ id: this.projectId });
    await this.writeWorkspace();
    await this.writeGeneration({ ...options, project });
    await this.writePointer(options.generationId ?? this.generationId, project.id);
  }

  async writeEndpointRaw(fileName: string, value: unknown): Promise<void> {
    await this.writeJson(path.join(this.generationDirectory(), 'endpoints', fileName), value);
  }

  async writeStateRaw(fileName: string, value: unknown): Promise<void> {
    await this.writeJson(path.join(this.generationDirectory(), 'states', fileName), value);
  }

  async readEndpoint(endpointId: string): Promise<EndpointDetail> {
    return this.readJson(path.join(this.generationDirectory(), 'endpoints', `${endpointId}.json`));
  }

  async writeBody(bytes: Buffer, mediaType = 'application/octet-stream'): Promise<BodyAsset> {
    const id = createHash('sha256').update(bytes).digest('hex');
    const asset: BodyAsset = {
      schemaVersion: 4,
      id,
      mediaType,
      size: bytes.length,
      createdAt: FIXED_TIME,
    };
    const directory = path.join(
      this.projectDirectory(),
      'bodies',
      'sha256',
      id.slice(0, 2),
    );
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, id), bytes);
    await this.writeJson(path.join(directory, `${id}.json`), asset);
    return asset;
  }

  async allProjectFiles(projectId = this.projectId): Promise<string[]> {
    const root = this.projectDirectory(projectId);
    const visit = async (directory: string): Promise<string[]> => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      const values = await Promise.all(entries.map(async entry => {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? visit(absolute) : [path.relative(root, absolute).split(path.sep).join('/')];
      }));
      return values.flat();
    };
    return (await visit(root)).sort();
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(value));
  }

  private async readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
  }
}
