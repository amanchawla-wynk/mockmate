/* eslint-disable no-console */

import * as fs from 'fs';
import * as path from 'path';

import { initializeStorage, getProjectDirectory } from '../services/storage';
import {
  createProject,
  listProjects,
  setActiveProject,
  updateProject,
} from '../services/projects';
import {
  createResource,
  listResources,
  addScenario,
  updateScenario,
} from '../services/resources';
import { slugify } from '../utils/slugify';
import type { CreateResourceRequest, Resource } from '../types';

type Json = any;

function readJson(filePath: string): Json {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function replaceInJson(value: Json, from: string, to: string): Json {
  const s = JSON.stringify(value);
  return JSON.parse(s.split(from).join(to));
}

function usageAndExit(): never {
  console.log('Usage: npx tsx src/scripts/import-xstream-automation.ts --fixtures <dir> [--static-files <dir>]');
  console.log('');
  console.log('  --fixtures     Directory containing test_cases_response JSON fixtures');
  console.log('  --static-files Directory containing static media files (HLS, mp4, html)');
  console.log('                 Files are copied to the MockMate project\'s static_files/ folder,');
  console.log('                 preserving the directory structure.');
  process.exit(1);
}

function importStaticFiles(srcDir: string, projectSlug: string): void {
  const destRoot = path.join(getProjectDirectory(projectSlug), 'static_files');

  let copied = 0;
  let skipped = 0;

  function walk(dir: string): void {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = path.relative(srcDir, abs);
      const dest = path.join(destRoot, rel);
      // Skip if already up-to-date (same size + mtime).
      if (fs.existsSync(dest)) {
        const destStat = fs.statSync(dest);
        if (destStat.size === stat.size && Math.abs(destStat.mtimeMs - stat.mtimeMs) < 1000) {
          skipped++;
          continue;
        }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      copied++;
    }
  }

  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    console.warn(`[static-files] Directory not found: ${srcDir} — skipping`);
    return;
  }

  walk(srcDir);
  console.log(`[static-files] Copied ${copied} file(s), skipped ${skipped} unchanged file(s) → ${destRoot}`);
}

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) return undefined;
  return val;
}

function getOrCreateProject(opts: {
  name: string;
  interceptHosts: string[];
}): { id: string; slug: string } {
  const slug = slugify(opts.name);
  const existing = listProjects().find(p => p.slug === slug);

  if (existing) {
    updateProject(existing.id, { interceptHosts: opts.interceptHosts });
    return { id: existing.id, slug: existing.slug };
  }

  const created = createProject({
    name: opts.name,
    interceptHosts: opts.interceptHosts,
  });
  return { id: created.id, slug: created.slug };
}

function findRule(projectId: string, rule: CreateResourceRequest): Resource | undefined {
  const resources = listResources(projectId);
  const host = (rule.host ?? '').trim().toLowerCase() || undefined;
  const matchQuery = rule.match?.query ?? undefined;

  return resources.find(r =>
    r.method === rule.method &&
    (r.host ?? '').trim().toLowerCase() === (host ?? '') &&
    r.path === rule.path &&
    JSON.stringify(r.match?.query ?? {}) === JSON.stringify(matchQuery ?? {})
  );
}

function upsertRule(projectId: string, rule: CreateResourceRequest): Resource {
  const existing = findRule(projectId, rule);
  if (existing) return existing;
  return createResource(projectId, rule);
}

function ensureScenario(projectId: string, resource: Resource, scenarioName: string, body: Json) {
  const has = resource.scenarios.some(s => s.name === scenarioName);
  if (!has) {
    addScenario(projectId, resource.id, {
      name: scenarioName,
      statusCode: 200,
      body,
    });
    return;
  }

  updateScenario(projectId, resource.id, scenarioName, {
    statusCode: 200,
    body,
  });
}

function setDefaultScenario(projectId: string, resource: Resource, body: Json) {
  updateScenario(projectId, resource.id, 'default', {
    statusCode: 200,
    body,
  });
}

async function main() {
  const fixturesDir = getArgValue('--fixtures');
  const staticFilesDir = getArgValue('--static-files');
  if (!fixturesDir) usageAndExit();
  if (!fs.existsSync(fixturesDir) || !fs.statSync(fixturesDir).isDirectory()) {
    console.error('Fixtures dir not found:', fixturesDir);
    process.exit(1);
  }

  initializeStorage();

  // Hosts from movies_ios UI_AUTOMATION (preprod)
  const apiHost = 'apimaster-preprod.wynk.in';
  const contentHost = 'contentapi-preprod.wynk.in';
  const playbackHost = 'play-preprod.wynk.in';
  const syncHost = 'sync-preprod.wynk.in';
  const packageHost = 'package-preprod.wynk.in';

  const projectName = 'Airtel Mobility UI Automation';
  const interceptHosts = [apiHost, contentHost, playbackHost, syncHost, packageHost];

  const project = getOrCreateProject({ name: projectName, interceptHosts });
  setActiveProject(project.id);

  console.log('Active project:', projectName);
  console.log('Fixtures:', fixturesDir);

  // --- Auth/User endpoints ---
  const otpSuccess = readJson(path.join(fixturesDir, 'generate_otp_success.json'));
  const loginSuccess = readJson(path.join(fixturesDir, 'login_success.json'));
  const nonLoggedIn = readJson(path.join(fixturesDir, 'non_loggedin.json'));
  const profile = readJson(path.join(fixturesDir, 'profile.json'));
  const empty = readJson(path.join(fixturesDir, 'empty_file.json'));
  const userConfig = readJson(path.join(fixturesDir, 'user_config.json'));
  const geoLocation = readJson(path.join(fixturesDir, 'geoLocation.json'));

  const otpRule = upsertRule(project.id, { method: 'POST', host: apiHost, path: '/v2/user/profile/generateOtp' });
  setDefaultScenario(project.id, otpRule, empty);
  ensureScenario(project.id, otpRule, 'auth_subscribed', otpSuccess);
  ensureScenario(project.id, otpRule, 'auth_logged_out', empty);

  const loginRule = upsertRule(project.id, { method: 'POST', host: apiHost, path: '/v5/user/login' });
  setDefaultScenario(project.id, loginRule, empty);
  ensureScenario(project.id, loginRule, 'auth_subscribed', loginSuccess);
  ensureScenario(project.id, loginRule, 'auth_logged_out', nonLoggedIn);

  const profileRule = upsertRule(project.id, { method: 'PATCH', host: apiHost, path: '/v5/user/profile' });
  setDefaultScenario(project.id, profileRule, empty);
  ensureScenario(project.id, profileRule, 'auth_subscribed', profile);
  ensureScenario(project.id, profileRule, 'auth_logged_out', empty);

  const userConfigRule = upsertRule(project.id, { method: 'POST', host: apiHost, path: '/v2/user/config' });
  setDefaultScenario(project.id, userConfigRule, userConfig);

  const geoRule = upsertRule(project.id, { method: 'GET', host: apiHost, path: '/v2/geoLocation' });
  setDefaultScenario(project.id, geoRule, geoLocation);

  // --- Layout (/app/v3/layout) ---
  const homepageDefault = readJson(path.join(fixturesDir, 'test001_open_cdp_from_home.json'));
  const homepageWatchlist = readJson(path.join(fixturesDir, 'test001_test_watch_list_home_page.json'));
  const homepagePlayerControls = readJson(path.join(fixturesDir, 'player_automation_home_layout.json'));
  const cdpFallback = readJson(path.join(fixturesDir, 'test001_cdp.json'));
  const moreLikeFallback = readJson(path.join(fixturesDir, 'test001_more_like_this.json'));
  const youPage = readJson(path.join(fixturesDir, 'package_youPageV2.json'));
  const bottomTabs = readJson(path.join(fixturesDir, 'package_bottomTabLayout.json'));

  // homepage2 is scenario-driven (varies per test suite)
  const homepageRule = upsertRule(project.id, {
    method: 'GET',
    host: packageHost,
    path: '/app/v3/layout',
    match: { query: { pageId: 'homepage2' } },
  });
  setDefaultScenario(project.id, homepageRule, homepageDefault);
  ensureScenario(project.id, homepageRule, 'test_player_controls', homepagePlayerControls);

  const watchlistHomeScenarios = [
    'test001_test_watch_list',
    'test002_test_watch_list',
    'test003_test_watch_list',
    'test004_watch_list_sync_backend',
    'test005_watch_list_received_from_backend',
    'test006_watch_list_icon_disabled_from_backend',
    'test001_nonLoggedIn_watchList',
  ];
  for (const s of watchlistHomeScenarios) {
    ensureScenario(project.id, homepageRule, s, homepageWatchlist);
  }

  // contentDetail fallback (real files override via more specific rules)
  const cdpFallbackRule = upsertRule(project.id, {
    method: 'GET',
    host: packageHost,
    path: '/app/v3/layout',
    match: { query: { pageId: 'contentDetail' } },
  });
  setDefaultScenario(project.id, cdpFallbackRule, cdpFallback);

  // moreLikeThis fallback
  const moreLikeFallbackRule = upsertRule(project.id, {
    method: 'GET',
    host: packageHost,
    path: '/app/v3/layout',
    match: { query: { pageId: 'moreLikeThis' } },
  });
  setDefaultScenario(project.id, moreLikeFallbackRule, moreLikeFallback);

  // youPageV2
  const youRule = upsertRule(project.id, {
    method: 'GET',
    host: packageHost,
    path: '/app/v3/layout',
    match: { query: { pageId: 'youPageV2' } },
  });
  setDefaultScenario(project.id, youRule, youPage);

  // bottomTabLayout
  const bottomRule = upsertRule(project.id, {
    method: 'GET',
    host: packageHost,
    path: '/app/v3/layout',
    match: { query: { pageId: 'bottomTabLayout' } },
  });
  setDefaultScenario(project.id, bottomRule, bottomTabs);

  // Import package_contentDetail_* and package_moreLikeThis_* rules
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    if (file.startsWith('package_contentDetail_')) {
      const noWatchlist = file.endsWith('_no_watchlist.json');
      const id = file
        .replace(/^package_contentDetail_/, '')
        .replace(/_no_watchlist\.json$/, '')
        .replace(/\.json$/, '');

      const body = readJson(path.join(fixturesDir, file));

      const rule = upsertRule(project.id, {
        method: 'GET',
        host: packageHost,
        path: '/app/v3/layout',
        match: { query: { pageId: 'contentDetail', contentId: id } },
      });

      if (noWatchlist) {
        ensureScenario(project.id, rule, 'test006_watch_list_icon_disabled_from_backend', body);
      } else {
        setDefaultScenario(project.id, rule, body);
      }
    }

    if (file.startsWith('package_moreLikeThis_')) {
      const id = file
        .replace(/^package_moreLikeThis_/, '')
        .replace(/\.json$/, '');
      const body = readJson(path.join(fixturesDir, file));

      const rule = upsertRule(project.id, {
        method: 'GET',
        host: packageHost,
        path: '/app/v3/layout',
        match: { query: { pageId: 'moreLikeThis', contentId: id } },
      });
      setDefaultScenario(project.id, rule, body);
    }
  }

  // --- Content (/app/v4/content) ---
  for (const file of files) {
    if (!file.startsWith('content_') || file === 'content_playback_response.json') continue;
    const id = file.replace(/^content_/, '').replace(/\.json$/, '');
    const body = readJson(path.join(fixturesDir, file));

    const rule = upsertRule(project.id, {
      method: 'GET',
      host: contentHost,
      path: '/app/v4/content',
      match: { query: { id } },
    });
    setDefaultScenario(project.id, rule, body);
  }

  // --- Playback/Download endpoints (basic stubs) ---
  const playback = readJson(path.join(fixturesDir, 'content_playback_response.json'));
  const trailer = readJson(path.join(fixturesDir, 'trailer_playback_response.json'));
  const downloadApi = readJson(path.join(fixturesDir, 'download_api_response.json'));

  // Rewrite legacy local URLs to an intercepted host so /static_files can be served
  // via the proxy from MOCKMATE_STATIC_DIR.
  const localPrefix = 'http://mylocalfiles.com/static_files/';
  const rewrittenPrefix = `https://${playbackHost}/static_files/`;
  const playbackBody = replaceInJson(playback, localPrefix, rewrittenPrefix);
  const trailerBody = replaceInJson(trailer, localPrefix, rewrittenPrefix);
  const downloadBody = replaceInJson(downloadApi, localPrefix, rewrittenPrefix);

  const playbackRule = upsertRule(project.id, { method: 'GET', host: playbackHost, path: '/v4/user/playback' });
  setDefaultScenario(project.id, playbackRule, playbackBody);

  const trailerRule = upsertRule(project.id, { method: 'GET', host: playbackHost, path: '/v2/playback/trailer' });
  setDefaultScenario(project.id, trailerRule, trailerBody);

  const downloadRule = upsertRule(project.id, { method: 'GET', host: playbackHost, path: '/v3/user/download/content' });
  setDefaultScenario(project.id, downloadRule, downloadBody);

  // --- Download sync ---
  const downloadEmpty = readJson(path.join(fixturesDir, 'download_sync_empty_response.json'));
  const downloadedMovie = readJson(path.join(fixturesDir, 'download_api_downloaded_movie_response.json'));
  const downloadedTv = readJson(path.join(fixturesDir, 'download_api_downloaded_tv_show_response.json'));

  const downloadFetchRule = upsertRule(project.id, { method: 'GET', host: syncHost, path: '/v2/user/syncDownload/fetch' });
  setDefaultScenario(project.id, downloadFetchRule, downloadEmpty);

  const downloadSyncRule = upsertRule(project.id, { method: 'POST', host: syncHost, path: '/v2/user/syncDownload/sync' });
  setDefaultScenario(project.id, downloadSyncRule, downloadEmpty);

  const movieDownloadScenarios = [
    'test001_downloads_movie__content_download',
    'test003_downloadPopUp__content_download',
    'test005_downloaded_rail__content_download',
  ];
  for (const s of movieDownloadScenarios) {
    ensureScenario(project.id, downloadFetchRule, s, downloadedMovie);
    ensureScenario(project.id, downloadSyncRule, s, downloadedMovie);
  }

  const tvDownloadScenarios = [
    'test006_download_tv_show__content_download',
    'test007_download_tv_show__content_download',
  ];
  for (const s of tvDownloadScenarios) {
    ensureScenario(project.id, downloadFetchRule, s, downloadedTv);
    ensureScenario(project.id, downloadSyncRule, s, downloadedTv);
  }

  // --- Content sync ---
  const contentSyncEmpty = readJson(path.join(fixturesDir, 'content_sync_empty.json'));
  const contentSyncRule = upsertRule(project.id, { method: 'POST', host: syncHost, path: '/v5/user/content/sync' });
  setDefaultScenario(project.id, contentSyncRule, contentSyncEmpty);

  const stateFiles = files.filter(f => f.startsWith('test') && f.includes('_content_sync_'));
  const testNameMap: Record<string, string> = {
    test008: 'test008_test_continue_watching',
    test009: 'test009_test_continue_watching',
    test010: 'test010_test_continue_watching',
    test011: 'test011_test_continue_watching_episodes_stack',
  };

  for (const file of stateFiles) {
    const body = readJson(path.join(fixturesDir, file));

    // Example: test009_content_sync_init.json
    const m1 = file.match(/^(test\d+)_content_sync_(init|content_added|content_data)\.json$/);
    if (m1) {
      const prefix = m1[1];
      const kind = m1[2];
      const testName = testNameMap[prefix];
      if (!testName) continue;

      const scenarioName = kind === 'init'
        ? testName
        : kind === 'content_data'
          ? `${testName}__app_sent_background`
          : `${testName}__content_added`;

      ensureScenario(project.id, contentSyncRule, scenarioName, body);

      // Some tests reuse init response for additional states.
      if (testName === 'test009_test_continue_watching' && kind === 'init') {
        ensureScenario(project.id, contentSyncRule, `${testName}__content_removed`, body);
      }
      if (testName === 'test011_test_continue_watching_episodes_stack' && kind === 'init') {
        ensureScenario(project.id, contentSyncRule, `${testName}__content_removed`, body);
      }
      continue;
    }

    // Example: test004_watch_list_content_sync_content_added.json
    const m2 = file.match(/^(test\d+_watch_list_[^_]+)_content_sync_(content_added|data)\.json$/);
    if (m2) {
      const testName = m2[1];
      const kind = m2[2];
      const scenarioName = kind === 'data'
        ? `${testName}__app_sent_background`
        : `${testName}__content_added`;

      ensureScenario(project.id, contentSyncRule, scenarioName, body);
    }
  }

  // Import static media files if provided.
  if (staticFilesDir) {
    importStaticFiles(staticFilesDir, project.slug);
  }

  console.log('Import complete.');
  if (!staticFilesDir) {
    console.log('Tip: re-run with --static-files <dir> to also copy HLS/mp4 automation media.');
  }
  console.log('Next: start mockmate server and set device proxy to the MockMate proxy port.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
