/**
 * Storage service for file-based persistence
 * Handles all file system operations for MockMate data
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { GlobalConfig, StorageConfig } from '../types';

/**
 * Get storage configuration paths
 */
export function getStorageConfig(): StorageConfig {
  const baseDir = path.join(os.homedir(), '.mockmate');
  return {
    baseDir,
    projectsDir: path.join(baseDir, 'projects'),
    certsDir: path.join(baseDir, 'certs'),
    configFile: path.join(baseDir, 'config.json'),
  };
}

/**
 * Initialize storage directory structure
 * Creates ~/.mockmate/ directory with subdirectories if they don't exist
 */
export function initializeStorage(): void {
  const config = getStorageConfig();

  // Create base directory
  if (!fs.existsSync(config.baseDir)) {
    fs.mkdirSync(config.baseDir, { recursive: true });
  }

  // Create projects directory
  if (!fs.existsSync(config.projectsDir)) {
    fs.mkdirSync(config.projectsDir, { recursive: true });
  }

  // Create config file if it doesn't exist
  if (!fs.existsSync(config.configFile)) {
    const defaultConfig: GlobalConfig = {
      server: {
        httpPort: 3456,
        httpsPort: 3457,
      },
    };
    writeJsonFile(config.configFile, defaultConfig);
  }
}

/**
 * Read global configuration
 */
export function readConfig(): GlobalConfig {
  const config = getStorageConfig();
  return readJsonFile<GlobalConfig>(config.configFile);
}

/**
 * Write global configuration
 */
export function writeConfig(config: GlobalConfig): void {
  const storageConfig = getStorageConfig();
  writeJsonFile(storageConfig.configFile, config);
}

/**
 * Ensure a project directory exists
 * @param projectSlug - URL-safe project slug
 */
export function ensureProjectDirectory(projectSlug: string): string {
  const config = getStorageConfig();
  const projectDir = path.join(config.projectsDir, projectSlug);
  const resourcesDir = path.join(projectDir, 'resources');

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  return projectDir;
}

/**
 * Get project directory path
 */
export function getProjectDirectory(projectSlug: string): string {
  const config = getStorageConfig();
  return path.join(config.projectsDir, projectSlug);
}

/**
 * Get resources directory path for a project
 */
export function getResourcesDirectory(projectSlug: string): string {
  return path.join(getProjectDirectory(projectSlug), 'resources');
}

/**
 * Check if a project directory exists
 */
export function projectExists(projectSlug: string): boolean {
  const projectDir = getProjectDirectory(projectSlug);
  return fs.existsSync(projectDir);
}

/**
 * List all project directories
 */
export function listProjectDirectories(): string[] {
  const config = getStorageConfig();

  if (!fs.existsSync(config.projectsDir)) {
    return [];
  }

  return fs.readdirSync(config.projectsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

/**
 * Delete a project directory and all its contents
 */
export function deleteProjectDirectory(projectSlug: string): void {
  const projectDir = getProjectDirectory(projectSlug);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Read a JSON file
 * @throws Error if file doesn't exist or JSON is invalid
 */
export function readJsonFile<T>(filePath: string): T {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw new Error(`Failed to read JSON file: ${filePath} - ${(error as Error).message}`);
  }
}

/**
 * Write a JSON file with pretty formatting
 */
export function writeJsonFile(filePath: string, data: any): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write JSON file: ${filePath} - ${(error as Error).message}`);
  }
}

/**
 * Delete a file
 */
export function deleteFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * List all files in a directory
 */
export function listFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(dirent => dirent.isFile())
    .map(dirent => dirent.name);
}

/**
 * Check if a file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
