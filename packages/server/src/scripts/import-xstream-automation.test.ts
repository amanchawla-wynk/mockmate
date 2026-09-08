import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import * as importer from './import-xstream-automation';
import { createApp } from '../app';
import {
  createProcessTrafficContext,
  createRuntime,
  type RuntimeContext,
} from '../runtime/create-runtime';
import type { ProjectRepository } from '../repository/project-repository';
import { createSetupRouter } from '../routes/setup';

const requiredFixtures = [
  'generate_otp_success.json',
  'login_success.json',
  'non_loggedin.json',
  'profile.json',
  'empty_file.json',
  'user_config.json',
  'geoLocation.json',
  'test001_open_cdp_from_home.json',
  'test001_test_watch_list_home_page.json',
  'player_automation_home_layout.json',
  'test001_cdp.json',
  'test001_more_like_this.json',
  'package_youPageV2.json',
  'package_bottomTabLayout.json',
  'content_playback_response.json',
  'trailer_playback_response.json',
  'download_api_response.json',
  'download_sync_empty_response.json',
  'download_api_downloaded_movie_response.json',
  'download_api_downloaded_tv_show_response.json',
  'content_sync_empty.json',
];

let root: string;
let fixturesDirectory: string;
let repository: ProjectRepository;
let runtime: RuntimeContext;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mockmate-xstream-'));
  fixturesDirectory = path.join(root, 'fixtures');
  await fs.promises.mkdir(fixturesDirectory);
  runtime = await createRuntime({
    rootDirectory: path.join(root, 'storage'),
    processTraffic: createProcessTrafficContext(),
    isAdminRequestLocal: () => true,
  });
  repository = runtime.repository;
});

afterEach(async () => {
  await runtime.dispose();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function writeFixtures(): Promise<void> {
  await Promise.all(requiredFixtures.map(fileName => fs.promises.writeFile(
    path.join(fixturesDirectory, fileName),
    JSON.stringify({ fixture: fileName }),
  )));
  await fs.promises.writeFile(
    path.join(fixturesDirectory, 'content_playback_response.json'),
    JSON.stringify({ url: 'http://mylocalfiles.com/static_files/movie/master.m3u8' }),
  );
  await fs.promises.writeFile(
    path.join(fixturesDirectory, 'package_contentDetail_movie-1.json'),
    JSON.stringify({ fixture: 'content-detail' }),
  );
  await fs.promises.writeFile(
    path.join(fixturesDirectory, 'package_contentDetail_movie-1_no_watchlist.json'),
    JSON.stringify({ fixture: 'no-watchlist' }),
  );
  await fs.promises.writeFile(
    path.join(fixturesDirectory, 'content_movie-1.json'),
    JSON.stringify({ fixture: 'content' }),
  );
  await fs.promises.writeFile(
    path.join(fixturesDirectory, 'test009_content_sync_init.json'),
    JSON.stringify({ fixture: 'continue-watching' }),
  );
}

async function readBody(projectId: string, assetId: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of repository.openBody(projectId, assetId) as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('XStream automation import', () => {
  it('exports a callable repository importer without running the CLI on module import', () => {
    expect(importer.importXstreamAutomation).toBeTypeOf('function');
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves automation matchers, fixture rewrites, and named App-State bindings idempotently', async () => {
    await writeFixtures();
    const staticDirectory = path.join(root, 'static');
    await fs.promises.mkdir(path.join(staticDirectory, 'movie'), { recursive: true });
    await fs.promises.writeFile(path.join(staticDirectory, 'movie', 'master.m3u8'), '#EXTM3U');
    await fs.promises.writeFile(path.join(staticDirectory, 'movie', 'segment.ts'), Buffer.from([0x47, 0x00]));
    await fs.promises.writeFile(path.join(staticDirectory, 'movie', 'trailer.mp4'), Buffer.from([0x00, 0x00]));
    await fs.promises.writeFile(path.join(staticDirectory, 'movie', 'player.html'), '<video></video>');

    const options = {
      repository,
      fixturesDirectory,
      staticDirectory,
      staticBaseUrl: 'https://192.168.1.20:3457',
    };
    const first = await importer.importXstreamAutomation(options);
    const project = repository.getProject(first.projectId);
    const endpoints = repository.listEndpoints(project.id)
      .map(endpoint => repository.getEndpoint(project.id, endpoint.id));
    const endpointCount = endpoints.length;
    const stateCount = repository.listStates(project.id).length;

    expect(repository.getWorkspaceState().activeProjectId).toBe(project.id);
    expect(repository.getRuntimeSettings(project.id).interceptHosts).toEqual(expect.arrayContaining([
      'apimaster-preprod.wynk.in',
      'contentapi-preprod.wynk.in',
      'play-preprod.wynk.in',
      'sync-preprod.wynk.in',
      'package-preprod.wynk.in',
    ]));
    expect(endpoints.some(endpoint => endpoint.matcher.path.startsWith('/xstream/'))).toBe(false);

    const otp = endpoints.find(endpoint => endpoint.matcher.path === '/v2/user/profile/generateOtp')!;
    expect(otp).toMatchObject({
      baseUrl: 'https://apimaster-preprod.wynk.in',
      mode: 'mock',
      matcher: { method: 'POST', path: '/v2/user/profile/generateOtp' },
    });
    expect(otp.matcher).not.toHaveProperty('host');
    const homepage = endpoints.find(endpoint => endpoint.matcher.query?.pageId?.some(
      expression => expression.operator === 'equals' && expression.value === 'homepage2',
    ))!;
    expect(homepage).toMatchObject({
      baseUrl: 'https://package-preprod.wynk.in',
      matcher: {
        method: 'GET', path: '/app/v3/layout',
        query: { pageId: [{ operator: 'equals', value: 'homepage2' }] },
      },
    });
    const content = endpoints.find(endpoint => endpoint.matcher.query?.id?.some(
      expression => expression.operator === 'equals' && expression.value === 'movie-1',
    ))!;
    expect(content).toMatchObject({
      baseUrl: 'https://contentapi-preprod.wynk.in',
      matcher: {
        path: '/app/v4/content',
        query: { id: [{ operator: 'equals', value: 'movie-1' }] },
      },
    });
    const contentDetail = endpoints.find(endpoint => endpoint.matcher.query?.contentId?.some(
      expression => expression.operator === 'equals' && expression.value === 'movie-1',
    ))!;
    const contentDetailDefault = contentDetail.variants.find(variant => variant.id === contentDetail.defaultVariantId)!;
    expect(await readBody(project.id, contentDetailDefault.bodyAssetId!)).toContain('content-detail');

    const authState = repository.listStates(project.id).find(state => state.name === 'auth_subscribed')!;
    const auth = repository.getState(project.id, authState.id);
    expect(otp.variants.find(variant => variant.id === auth.bindings[otp.id])?.name).toBe('auth_subscribed');
    const continueState = repository.listStates(project.id)
      .find(state => state.name === 'test009_test_continue_watching')!;
    expect(continueState).toBeDefined();

    const playback = endpoints.find(endpoint => endpoint.matcher.path === '/v4/user/playback')!;
    const playbackBodyId = playback.variants.find(variant => variant.id === playback.defaultVariantId)?.bodyAssetId;
    expect(await readBody(project.id, playbackBodyId!))
      .toContain('https://192.168.1.20:3457/static_files/movie/master.m3u8');
    expect(repository.listStaticFiles(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'movie/master.m3u8', size: 7, mediaType: 'application/vnd.apple.mpegurl' }),
      expect.objectContaining({ path: 'movie/segment.ts', mediaType: 'video/mp2t' }),
      expect.objectContaining({ path: 'movie/trailer.mp4', mediaType: 'video/mp4' }),
      expect.objectContaining({ path: 'movie/player.html', mediaType: 'text/html' }),
    ]));
    const getPorts = () => ({ http: 3000, https: 3443, proxy: 8080 });
    const app = createApp({
      runtime,
      setupRouter: createSetupRouter({
        certificateDirectory: path.join(root, 'certificates'),
        getPorts,
      }),
      getPorts,
    });
    for (const [staticPath, mediaType] of [
      ['movie/master.m3u8', 'application/vnd.apple.mpegurl'],
      ['movie/segment.ts', 'video/mp2t'],
      ['movie/trailer.mp4', 'video/mp4'],
      ['movie/player.html', 'text/html'],
    ] as const) {
      const served = await request(app).get(`/static_files/${staticPath}`);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe(mediaType);
    }

    const second = await importer.importXstreamAutomation(options);
    expect(second.projectId).toBe(first.projectId);
    expect(repository.listEndpoints(project.id)).toHaveLength(endpointCount);
    expect(repository.listStates(project.id)).toHaveLength(stateCount);
    expect(repository.listEndpoints(project.id).map(endpoint => endpoint.id))
      .toEqual(endpoints.map(endpoint => endpoint.id));
    expect(repository.listStaticFiles(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'movie/master.m3u8', mediaType: 'application/vnd.apple.mpegurl' }),
      expect.objectContaining({ path: 'movie/segment.ts', mediaType: 'video/mp2t' }),
      expect.objectContaining({ path: 'movie/trailer.mp4', mediaType: 'video/mp4' }),
      expect.objectContaining({ path: 'movie/player.html', mediaType: 'text/html' }),
    ]));
  }, 30_000);

  it('fails with an actionable fixture name instead of silently importing partial semantics', async () => {
    await expect(importer.importXstreamAutomation({
      repository,
      fixturesDirectory,
      staticBaseUrl: 'https://192.168.1.20:3457',
    }))
      .rejects.toThrow('generate_otp_success.json');
  });
});
