import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { EndpointDetail } from '../domain/model';
import { canonicalEndpointIdentity } from '../repository/compile-project';
import type { ProjectRepository } from '../repository/project-repository';
import { createProcessTrafficContext, createRuntime } from '../runtime/create-runtime';
import { getStorageConfig } from '../services/storage';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ImportXstreamAutomationOptions {
  repository: ProjectRepository;
  fixturesDirectory: string;
  staticDirectory?: string;
}

export interface ImportedXstreamAutomation {
  projectId: string;
}

const projectName = 'Airtel Mobility UI Automation';
const apiHost = 'apimaster-preprod.wynk.in';
const contentHost = 'contentapi-preprod.wynk.in';
const playbackHost = 'play-preprod.wynk.in';
const syncHost = 'sync-preprod.wynk.in';
const packageHost = 'package-preprod.wynk.in';
const interceptHosts = [apiHost, contentHost, playbackHost, syncHost, packageHost];
const requiredFixtureNames = [
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
] as const;

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith('--') ? path.resolve(value) : undefined;
}

async function loadFixtures(directory: string): Promise<Map<string, Json>> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error('Fixtures directory is not readable');
  }
  const jsonNames = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();
  for (const required of requiredFixtureNames) {
    if (!jsonNames.includes(required)) throw new Error(`Required automation fixture is missing: ${required}`);
  }
  const fixtures = new Map<string, Json>();
  for (const fileName of jsonNames) {
    try {
      fixtures.set(fileName, JSON.parse(await fs.promises.readFile(path.join(directory, fileName), 'utf8')) as Json);
    } catch {
      throw new Error(`Automation fixture is not valid JSON: ${fileName}`);
    }
  }
  return fixtures;
}

function fixture(fixtures: Map<string, Json>, fileName: string): Json {
  const value = fixtures.get(fileName);
  if (value === undefined) throw new Error(`Required automation fixture is missing: ${fileName}`);
  return value;
}

function replaceInJson(value: Json, from: string, to: string): Json {
  return JSON.parse(JSON.stringify(value).split(from).join(to)) as Json;
}

type RequestMatcher = EndpointDetail['matcher'];

const equals = (value: string) => [{ operator: 'equals' as const, value }];

async function putJsonBody(repository: ProjectRepository, projectId: string, value: Json) {
  const bytes = Buffer.from(JSON.stringify(value));
  return repository.putBody(
    projectId,
    Readable.from(bytes),
    { mediaType: 'application/json' },
    { maxBytes: Math.max(1, bytes.length) },
  );
}

async function ensureEndpoint(
  repository: ProjectRepository,
  projectId: string,
  baseUrl: string,
  matcher: RequestMatcher,
  body: Json | undefined,
): Promise<EndpointDetail> {
  const identity = canonicalEndpointIdentity({ baseUrl, matcher });
  const existingSummary = repository.listEndpoints(projectId)
    .find(summary => canonicalEndpointIdentity(repository.getEndpoint(projectId, summary.id)) === identity);
  const asset = body === undefined ? undefined : await putJsonBody(repository, projectId, body);
  if (!existingSummary) {
    return repository.createEndpoint(projectId, {
      name: `${matcher.method} ${matcher.path}`,
      baseUrl,
      matcher,
      mode: 'mock',
      variants: [{
        name: 'Default', status: 200,
        responseHeaders: { 'content-type': 'application/json' },
        ...(asset ? { bodyAssetId: asset.id } : {}),
      }],
      defaultVariantIndex: 0,
    });
  }
  let endpoint = repository.getEndpoint(projectId, existingSummary.id);
  const current = endpoint.variants.find(variant => variant.id === endpoint.defaultVariantId)!;
  if (asset && (current.status !== 200
    || current.bodyAssetId !== asset.id
    || current.responseHeaders['content-type'] !== 'application/json')) {
    const saved = await repository.updateVariant(projectId, endpoint.id, current.id, current.revision, {
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      bodyAssetId: asset.id,
    });
    endpoint = {
      ...endpoint,
      variants: endpoint.variants.map(variant => variant.id === saved.id ? saved : variant),
    };
  }
  return endpoint;
}

async function ensureStateVariant(
  repository: ProjectRepository,
  projectId: string,
  endpointId: string,
  stateName: string,
  body: Json,
): Promise<void> {
  const asset = await putJsonBody(repository, projectId, body);
  const endpoint = repository.getEndpoint(projectId, endpointId);
  let variant = endpoint.variants.find(candidate => candidate.name === stateName);
  if (!variant) {
    variant = await repository.createVariant(projectId, endpoint.id, endpoint.revision, {
      name: stateName,
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      bodyAssetId: asset.id,
    });
  } else if (variant.status !== 200
    || variant.bodyAssetId !== asset.id
    || variant.responseHeaders['content-type'] !== 'application/json') {
    variant = await repository.updateVariant(projectId, endpoint.id, variant.id, variant.revision, {
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      bodyAssetId: asset.id,
    });
  }

  const stateSummary = repository.listStates(projectId).find(state => state.name === stateName);
  const state = stateSummary
    ? repository.getState(projectId, stateSummary.id)
    : await repository.createState(projectId, { name: stateName, tags: [], bindings: {} });
  if (state.bindings[endpoint.id] !== variant.id) {
    await repository.updateState(projectId, state.id, state.revision, {
      bindings: { ...state.bindings, [endpoint.id]: variant.id },
    });
  }
}

async function importStaticDirectory(
  repository: ProjectRepository,
  projectId: string,
  sourceRoot: string,
): Promise<void> {
  const mediaTypes: Record<string, string> = {
    '.html': 'text/html',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.mp4': 'video/mp4',
    '.ts': 'video/mp2t',
  };
  let rootStats: fs.Stats;
  try {
    rootStats = await fs.promises.stat(sourceRoot);
  } catch {
    throw new Error('Static files directory is not readable');
  }
  if (!rootStats.isDirectory()) throw new Error('Static files path is not a directory');

  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await fs.promises.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const size = (await fs.promises.stat(absolute)).size;
        await repository.putStaticFile(
          projectId,
          path.relative(sourceRoot, absolute).split(path.sep).join('/'),
          fs.createReadStream(absolute),
          { mediaType: mediaTypes[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream', maxBytes: Math.max(1, size) },
        );
      }
    }
  };
  await visit(sourceRoot);
}

export async function importXstreamAutomation(
  options: ImportXstreamAutomationOptions,
): Promise<ImportedXstreamAutomation> {
  const fixtures = await loadFixtures(options.fixturesDirectory);
  const files = [...fixtures.keys()];
  const unsupportedStateFile = files.find(fileName => {
    if (!fileName.startsWith('test') || !fileName.includes('_content_sync_')) return false;
    const direct = /^(test\d+)_content_sync_(init|content_added|content_data)\.json$/.test(fileName);
    const watchlist = /^(test\d+_watch_list_[^_]+)_content_sync_(content_added|data)\.json$/.test(fileName);
    return !direct && !watchlist;
  });
  if (unsupportedStateFile) {
    throw new Error(`Automation state fixture name is not representable: ${unsupportedStateFile}`);
  }

  const existing = options.repository.listProjects().find(project => project.name === projectName);
  const project = existing
    ? options.repository.getProject(existing.id)
    : await options.repository.createProject({ name: projectName });
  const settings = options.repository.getRuntimeSettings(project.id);
  if (JSON.stringify(settings.interceptHosts) !== JSON.stringify(interceptHosts)) {
    await options.repository.updateRuntimeSettings(project.id, {
      interceptHosts,
      captureRawTraffic: settings.captureRawTraffic,
      debugProvenanceHeaders: settings.debugProvenanceHeaders,
      expectedRevision: settings.revision,
    });
  }

  const endpoint = (host: string, matcher: RequestMatcher, body: Json | undefined) => ensureEndpoint(
    options.repository, project.id, `https://${host}`, matcher, body,
  );
  const state = (target: EndpointDetail, name: string, body: Json) => ensureStateVariant(
    options.repository, project.id, target.id, name, body,
  );
  const empty = fixture(fixtures, 'empty_file.json');

  const otp = await endpoint(apiHost, { method: 'POST', path: '/v2/user/profile/generateOtp' }, empty);
  await state(otp, 'auth_subscribed', fixture(fixtures, 'generate_otp_success.json'));
  await state(otp, 'auth_logged_out', empty);
  const login = await endpoint(apiHost, { method: 'POST', path: '/v5/user/login' }, empty);
  await state(login, 'auth_subscribed', fixture(fixtures, 'login_success.json'));
  await state(login, 'auth_logged_out', fixture(fixtures, 'non_loggedin.json'));
  const profile = await endpoint(apiHost, { method: 'PATCH', path: '/v5/user/profile' }, empty);
  await state(profile, 'auth_subscribed', fixture(fixtures, 'profile.json'));
  await state(profile, 'auth_logged_out', empty);
  await endpoint(apiHost, { method: 'POST', path: '/v2/user/config' }, fixture(fixtures, 'user_config.json'));
  await endpoint(apiHost, { method: 'GET', path: '/v2/geoLocation' }, fixture(fixtures, 'geoLocation.json'));

  const homepage = await endpoint(
    packageHost,
    { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('homepage2') } },
    fixture(fixtures, 'test001_open_cdp_from_home.json'),
  );
  await state(homepage, 'test_player_controls', fixture(fixtures, 'player_automation_home_layout.json'));
  for (const name of [
    'test001_test_watch_list',
    'test002_test_watch_list',
    'test003_test_watch_list',
    'test004_watch_list_sync_backend',
    'test005_watch_list_received_from_backend',
    'test006_watch_list_icon_disabled_from_backend',
    'test001_nonLoggedIn_watchList',
  ]) await state(homepage, name, fixture(fixtures, 'test001_test_watch_list_home_page.json'));

  await endpoint(
    packageHost,
    { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('contentDetail') } },
    fixture(fixtures, 'test001_cdp.json'),
  );
  await endpoint(
    packageHost,
    { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('moreLikeThis') } },
    fixture(fixtures, 'test001_more_like_this.json'),
  );
  await endpoint(
    packageHost,
    { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('youPageV2') } },
    fixture(fixtures, 'package_youPageV2.json'),
  );
  await endpoint(
    packageHost,
    { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('bottomTabLayout') } },
    fixture(fixtures, 'package_bottomTabLayout.json'),
  );

  for (const fileName of files) {
    if (fileName.startsWith('package_contentDetail_')) {
      const noWatchlist = fileName.endsWith('_no_watchlist.json');
      const id = fileName.replace(/^package_contentDetail_/, '')
        .replace(/_no_watchlist\.json$/, '').replace(/\.json$/, '');
      if (!id) throw new Error(`Automation content-detail fixture has no stable content ID: ${fileName}`);
      const target = await endpoint(
        packageHost,
        { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('contentDetail'), contentId: equals(id) } },
        noWatchlist ? undefined : fixture(fixtures, fileName),
      );
      if (noWatchlist) {
        await state(target, 'test006_watch_list_icon_disabled_from_backend', fixture(fixtures, fileName));
      }
    }
    if (fileName.startsWith('package_moreLikeThis_')) {
      const id = fileName.replace(/^package_moreLikeThis_/, '').replace(/\.json$/, '');
      if (!id) throw new Error(`Automation related-content fixture has no stable content ID: ${fileName}`);
      await endpoint(
        packageHost,
        { method: 'GET', path: '/app/v3/layout', query: { pageId: equals('moreLikeThis'), contentId: equals(id) } },
        fixture(fixtures, fileName),
      );
    }
    if (fileName.startsWith('content_') && fileName !== 'content_playback_response.json') {
      const id = fileName.replace(/^content_/, '').replace(/\.json$/, '');
      if (!id) throw new Error(`Automation content fixture has no stable content ID: ${fileName}`);
      await endpoint(
        contentHost,
        { method: 'GET', path: '/app/v4/content', query: { id: equals(id) } },
        fixture(fixtures, fileName),
      );
    }
  }

  const localPrefix = 'http://mylocalfiles.com/static_files/';
  const servedPrefix = `https://${playbackHost}/static_files/`;
  await endpoint(
    playbackHost,
    { method: 'GET', path: '/v4/user/playback' },
    replaceInJson(fixture(fixtures, 'content_playback_response.json'), localPrefix, servedPrefix),
  );
  await endpoint(
    playbackHost,
    { method: 'GET', path: '/v2/playback/trailer' },
    replaceInJson(fixture(fixtures, 'trailer_playback_response.json'), localPrefix, servedPrefix),
  );
  await endpoint(
    playbackHost,
    { method: 'GET', path: '/v3/user/download/content' },
    replaceInJson(fixture(fixtures, 'download_api_response.json'), localPrefix, servedPrefix),
  );

  const downloadEmpty = fixture(fixtures, 'download_sync_empty_response.json');
  const downloadFetch = await endpoint(
    syncHost, { method: 'GET', path: '/v2/user/syncDownload/fetch' }, downloadEmpty,
  );
  const downloadSync = await endpoint(
    syncHost, { method: 'POST', path: '/v2/user/syncDownload/sync' }, downloadEmpty,
  );
  for (const name of [
    'test001_downloads_movie__content_download',
    'test003_downloadPopUp__content_download',
    'test005_downloaded_rail__content_download',
  ]) {
    await state(downloadFetch, name, fixture(fixtures, 'download_api_downloaded_movie_response.json'));
    await state(downloadSync, name, fixture(fixtures, 'download_api_downloaded_movie_response.json'));
  }
  for (const name of [
    'test006_download_tv_show__content_download',
    'test007_download_tv_show__content_download',
  ]) {
    await state(downloadFetch, name, fixture(fixtures, 'download_api_downloaded_tv_show_response.json'));
    await state(downloadSync, name, fixture(fixtures, 'download_api_downloaded_tv_show_response.json'));
  }

  const contentSync = await endpoint(
    syncHost,
    { method: 'POST', path: '/v5/user/content/sync' },
    fixture(fixtures, 'content_sync_empty.json'),
  );
  const testNameMap: Record<string, string> = {
    test008: 'test008_test_continue_watching',
    test009: 'test009_test_continue_watching',
    test010: 'test010_test_continue_watching',
    test011: 'test011_test_continue_watching_episodes_stack',
  };
  for (const fileName of files.filter(name => name.startsWith('test') && name.includes('_content_sync_'))) {
    const direct = fileName.match(/^(test\d+)_content_sync_(init|content_added|content_data)\.json$/);
    if (direct) {
      const testName = testNameMap[direct[1]];
      if (!testName) throw new Error(`Automation state fixture has no named test mapping: ${fileName}`);
      const stateName = direct[2] === 'init'
        ? testName
        : direct[2] === 'content_data'
          ? `${testName}__app_sent_background`
          : `${testName}__content_added`;
      await state(contentSync, stateName, fixture(fixtures, fileName));
      if (direct[2] === 'init' && (direct[1] === 'test009' || direct[1] === 'test011')) {
        await state(contentSync, `${testName}__content_removed`, fixture(fixtures, fileName));
      }
      continue;
    }
    const watchlist = fileName.match(/^(test\d+_watch_list_[^_]+)_content_sync_(content_added|data)\.json$/)!;
    await state(
      contentSync,
      watchlist[2] === 'data' ? `${watchlist[1]}__app_sent_background` : `${watchlist[1]}__content_added`,
      fixture(fixtures, fileName),
    );
  }

  if (options.staticDirectory) {
    await importStaticDirectory(options.repository, project.id, options.staticDirectory);
  }
  const workspace = options.repository.getWorkspaceState();
  if (workspace.activeProjectId !== project.id) {
    await options.repository.setActiveProject(project.id, workspace.revision);
  }
  return { projectId: project.id };
}

async function main(): Promise<void> {
  const fixturesDirectory = argument('--fixtures');
  if (!fixturesDirectory) {
    throw new Error('Usage: import-xstream-automation --fixtures <dir> [--static-files <dir>]');
  }
  const runtime = await createRuntime({
    rootDirectory: getStorageConfig().baseDir,
    processTraffic: createProcessTrafficContext(),
    isAdminRequestLocal: () => true,
  });
  try {
    await importXstreamAutomation({
      repository: runtime.repository,
      fixturesDirectory,
      ...(argument('--static-files') ? { staticDirectory: argument('--static-files') } : {}),
    });
  } finally {
    await runtime.dispose();
  }
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
