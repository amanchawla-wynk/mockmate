import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAtomicFileWriter } from './atomic-write';
import { createBodyStore } from './body-store';
import { nodeFileSystem } from './file-system';
import { createProjectRepository, type ProjectRepository } from './project-repository';

let root: string;
let repository: ProjectRepository;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-schema-v4-core-'));
  const atomicWriter = createAtomicFileWriter(nodeFileSystem);
  repository = createProjectRepository({
    rootDirectory: root,
    atomicWriter,
    bodyStore: createBodyStore({ rootDirectory: root, atomicWriter, fileSystem: nodeFileSystem }),
    idSource: (() => {
      let value = 0;
      return () => String(++value);
    })(),
  });
  await repository.initialize();
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('schema-v4 repository core', () => {
  it('creates only v4 Project, settings, workspace, pointer, and static metadata records', async () => {
    const project = await repository.createProject({ name: 'Project' });
    expect(project).toMatchObject({ schemaVersion: 4, appStateMode: 'disabled', revision: 0 });
    expect(project).not.toHaveProperty('baseUrl');
    expect(repository.getRuntimeSettings(project.id)).toEqual({
      schemaVersion: 4,
      projectId: project.id,
      interceptHosts: [],
      captureRawTraffic: true,
      debugProvenanceHeaders: false,
      revision: 0,
    });
    expect(repository.getWorkspaceState()).toEqual({ schemaVersion: 4, revision: 0 });

    const projectRoot = path.join(root, 'projects', project.id);
    expect(JSON.parse(await fs.promises.readFile(path.join(projectRoot, 'current.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 4 });
    expect(JSON.parse(await fs.promises.readFile(
      path.join(projectRoot, 'static', '.mockmate-static.json'),
      'utf8',
    ))).toEqual({ schemaVersion: 4, files: [] });
  });

  it('persists full runtime settings without the confirmation bit', async () => {
    const project = await repository.createProject({ name: 'Project' });
    const settings = await repository.updateRuntimeSettings(project.id, {
      interceptHosts: ['*.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: true,
      expectedRevision: 0,
      confirmInterceptAll: true,
    });
    expect(settings).toMatchObject({
      interceptHosts: ['*.example.test'],
      captureRawTraffic: true,
      debugProvenanceHeaders: true,
      revision: 1,
    });
    expect(settings).not.toHaveProperty('confirmInterceptAll');
  });

  it('creates summaries with repeated query counts and reversible modes', async () => {
    const project = await repository.createProject({ name: 'Project' });
    const endpoint = await repository.createEndpoint(project.id, {
      name: 'Users',
      baseUrl: 'https://api.example.test',
      matcher: {
        method: 'GET',
        path: '/users',
        query: { q: [
          { operator: 'equals', value: 'a' },
          { operator: 'glob', value: 'a*' },
        ] },
        headers: { 'x-mode': { operator: 'equals', value: 'preview' } },
      },
      mode: 'mock',
      variants: [{ name: 'Default', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    expect(repository.listEndpoints(project.id)).toEqual([expect.objectContaining({
      schemaVersion: 4,
      baseUrl: 'https://api.example.test',
      mode: 'mock',
      method: 'GET',
      path: '/users',
      queryConstraintCount: 2,
      headerConstraintCount: 1,
      variantCount: 1,
      mockReady: true,
    })]);

    const passthrough = await repository.setEndpointMode(project.id, endpoint.id, {
      mode: 'passthrough', expectedRevision: 0,
    });
    expect(passthrough).toMatchObject({ mode: 'passthrough', revision: 1 });
    expect(passthrough.variants).toEqual(endpoint.variants);
    const mock = await repository.setEndpointMode(project.id, endpoint.id, {
      mode: 'mock', expectedRevision: 1,
    });
    expect(mock).toMatchObject({ mode: 'mock', revision: 2 });
  });

  it('preserves dormant State data when App State mode changes', async () => {
    const project = await repository.createProject({ name: 'Project' });
    const endpoint = await repository.createEndpoint(project.id, {
      name: 'Users', baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/users' }, mode: 'mock',
      variants: [{ name: 'Default', status: 200, responseHeaders: {} }],
      defaultVariantIndex: 0,
    });
    const state = await repository.createState(project.id, {
      name: 'State', tags: [], bindings: { [endpoint.id]: endpoint.variants[0].id },
    });
    await repository.setStateSelection(project.id, 0, { activeStateId: state.id });
    const disabled = await repository.setAppStateMode(project.id, {
      appStateMode: 'disabled', expectedProjectRevision: 1,
    });
    expect(disabled).toMatchObject({
      appStateMode: 'disabled', activeStateId: state.id, revision: 2,
    });
    expect(repository.getState(project.id, state.id).bindings).toEqual({
      [endpoint.id]: endpoint.variants[0].id,
    });
  });

  it('allows empty passthrough Endpoints but blocks switching them to mock', async () => {
    const project = await repository.createProject({ name: 'Project' });
    const endpoint = await repository.createEndpoint(project.id, {
      name: 'Pass', baseUrl: 'https://api.example.test',
      matcher: { method: 'GET', path: '/pass' }, mode: 'passthrough',
    });
    expect(endpoint).toMatchObject({ mode: 'passthrough', variants: [] });
    expect(endpoint).not.toHaveProperty('defaultVariantId');
    await expect(repository.setEndpointMode(project.id, endpoint.id, {
      mode: 'mock', expectedRevision: 0,
    })).rejects.toMatchObject({ code: 'ENDPOINT_FALLBACK_REQUIRED' });
  });
});
