/* eslint-disable no-console */

import * as fs from 'fs';
import * as path from 'path';

import type { Project, Resource } from '../types';
import { initializeStorage, getProjectDirectory, listFiles, readJsonFile, writeJsonFile, readConfig } from '../services/storage';
import { getProject, listProjects, updateProject } from '../services/projects';

function usageAndExit(): never {
  console.log('Usage: npx tsx src/scripts/migrate-auth-scenarios.ts [--project <projectId|slug>]');
  process.exit(1);
}

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) return undefined;
  return val;
}

function resolveProjectRef(ref: string | undefined): Project {
  if (ref) {
    // First try as ID
    const byId = listProjects().find(p => p.id === ref);
    if (byId) return byId;
    // Then as slug
    const bySlug = listProjects().find(p => p.slug === ref);
    if (bySlug) return bySlug;
    throw new Error(`Project not found: ${ref}`);
  }

  const cfg = readConfig();
  if (!cfg.activeProjectId) {
    throw new Error('No active project. Activate a project or pass --project.');
  }
  return getProject(cfg.activeProjectId);
}

function migrateScenarioName(name: string): string {
  if (name === 'test_login') return 'auth_subscribed';
  if (name === 'test_logout') return 'auth_logged_out';
  return name;
}

function migrateResource(resource: Resource): { changed: boolean; migrated: Resource } {
  let changed = false;

  const migratedScenarios = resource.scenarios
    .map(s => {
      const next = migrateScenarioName(s.name);
      if (next !== s.name) changed = true;
      return { ...s, name: next };
    })
    // If both old + new existed, dedupe by name (keep first occurrence)
    .filter((s, idx, arr) => arr.findIndex(x => x.name === s.name) === idx);

  const migrated: Resource = {
    ...resource,
    scenarios: migratedScenarios,
    updatedAt: changed ? new Date().toISOString() : resource.updatedAt,
  };

  return { changed, migrated };
}

function main() {
  if (process.argv.includes('--help')) usageAndExit();
  initializeStorage();

  const ref = getArgValue('--project');
  const project = resolveProjectRef(ref);

  // Migrate project-level scenario fields
  const migratedActive = migrateScenarioName((project.activeScenario ?? '').trim());
  const migratedBase = migrateScenarioName((project.baseScenario ?? '').trim());
  if (migratedActive !== project.activeScenario || migratedBase !== project.baseScenario) {
    updateProject(project.id, {
      activeScenario: migratedActive || 'default',
      baseScenario: migratedBase || 'default',
    });
    console.log(`Updated project scenarios: active=${migratedActive} base=${migratedBase}`);
  }

  const projectDir = getProjectDirectory(project.slug);
  const resourcesDir = path.join(projectDir, 'resources');
  if (!fs.existsSync(resourcesDir)) {
    console.log('No resources directory found:', resourcesDir);
    return;
  }

  const files = listFiles(resourcesDir).filter(f => f.endsWith('.json'));
  let updated = 0;

  for (const file of files) {
    const filePath = path.join(resourcesDir, file);
    let resource: Resource;
    try {
      resource = readJsonFile<Resource>(filePath);
    } catch {
      continue;
    }

    const { changed, migrated } = migrateResource(resource);
    if (!changed) continue;

    writeJsonFile(filePath, migrated);
    updated += 1;
  }

  console.log(`Migrated ${updated} resource file(s) in project ${project.slug}`);
}

main();
