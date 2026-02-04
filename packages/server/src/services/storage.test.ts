import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getStorageConfig,
  initializeStorage,
  readConfig,
  writeConfig,
  ensureProjectDirectory,
  getProjectDirectory,
  getResourcesDirectory,
  projectExists,
  listProjectDirectories,
  deleteProjectDirectory,
  readJsonFile,
  writeJsonFile,
  deleteFile,
  listFiles,
  fileExists,
} from './storage';
import type { GlobalConfig } from '../types';

// Use actual ~/.mockmate for tests (will be created and cleaned up)
// In a real production environment, we might use a different approach
// but for now this tests the actual functionality

let testProjectSlugs: string[] = [];

beforeEach(() => {
  // Initialize storage for each test
  initializeStorage();
  testProjectSlugs = [];
});

afterEach(() => {
  // Clean up any test projects created
  testProjectSlugs.forEach(slug => {
    try {
      deleteProjectDirectory(slug);
    } catch (e) {
      // Ignore cleanup errors
    }
  });
});

describe('getStorageConfig', () => {
  it('should return correct storage paths', () => {
    const config = getStorageConfig();
    expect(config.baseDir).toContain('.mockmate');
    expect(config.projectsDir).toContain('projects');
    expect(config.certsDir).toContain('certs');
    expect(config.configFile).toContain('config.json');
  });
});

describe('initializeStorage', () => {
  it('should create storage directories', () => {
    const config = getStorageConfig();

    expect(fs.existsSync(config.baseDir)).toBe(true);
    expect(fs.existsSync(config.projectsDir)).toBe(true);
    expect(fs.existsSync(config.configFile)).toBe(true);
  });

  it('should create config file with default values on first run', () => {
    // Delete config file to test fresh initialization
    const config = getStorageConfig();
    deleteFile(config.configFile);

    initializeStorage();
    const configData = readJsonFile<GlobalConfig>(config.configFile);

    expect(configData.server?.httpPort).toBe(3456);
    expect(configData.server?.httpsPort).toBe(3457);
  });

  it('should not overwrite existing config', () => {
    const customConfig: GlobalConfig = {
      activeProjectId: 'test-id',
      server: { httpPort: 9999 },
    };
    writeConfig(customConfig);

    initializeStorage();
    const config = readConfig();
    expect(config.activeProjectId).toBe('test-id');
    expect(config.server?.httpPort).toBe(9999);
  });
});

describe('readConfig and writeConfig', () => {
  it('should read and write config', () => {
    const config: GlobalConfig = {
      activeProjectId: 'proj_123',
      server: { httpPort: 8080 },
    };

    writeConfig(config);
    const readData = readConfig();

    expect(readData.activeProjectId).toBe('proj_123');
    expect(readData.server?.httpPort).toBe(8080);
  });
});

describe('ensureProjectDirectory', () => {
  it('should create project directory structure', () => {
    const slug = 'test-project-' + Date.now();
    testProjectSlugs.push(slug);
    const projectDir = ensureProjectDirectory(slug);

    expect(fs.existsSync(projectDir)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'resources'))).toBe(true);
  });

  it('should not fail if directory already exists', () => {
    const slug = 'test-project-exists-' + Date.now();
    testProjectSlugs.push(slug);
    ensureProjectDirectory(slug);
    ensureProjectDirectory(slug); // Should not throw

    expect(projectExists(slug)).toBe(true);
  });
});

describe('projectExists', () => {
  it('should return true for existing project', () => {
    const slug = 'my-project-' + Date.now();
    testProjectSlugs.push(slug);
    ensureProjectDirectory(slug);
    expect(projectExists(slug)).toBe(true);
  });

  it('should return false for non-existing project', () => {
    expect(projectExists('non-existing-' + Date.now())).toBe(false);
  });
});

describe('listProjectDirectories', () => {
  it('should list all project directories', () => {
    const slug1 = 'project-1-' + Date.now();
    const slug2 = 'project-2-' + Date.now();
    const slug3 = 'project-3-' + Date.now();
    testProjectSlugs.push(slug1, slug2, slug3);

    ensureProjectDirectory(slug1);
    ensureProjectDirectory(slug2);
    ensureProjectDirectory(slug3);

    const projects = listProjectDirectories();
    expect(projects).toContain(slug1);
    expect(projects).toContain(slug2);
    expect(projects).toContain(slug3);
    expect(projects.length).toBeGreaterThanOrEqual(3);
  });

  it('should return array with directories', () => {
    const projects = listProjectDirectories();
    expect(Array.isArray(projects)).toBe(true);
  });
});

describe('deleteProjectDirectory', () => {
  it('should delete project and all contents', () => {
    const slug = 'to-delete-' + Date.now();
    ensureProjectDirectory(slug);
    const projectDir = getProjectDirectory(slug);

    // Add some files
    writeJsonFile(path.join(projectDir, 'project.json'), { name: 'test' });
    writeJsonFile(path.join(projectDir, 'resources', 'test.json'), { data: 'test' });

    deleteProjectDirectory(slug);
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('should not fail if project does not exist', () => {
    deleteProjectDirectory('non-existing-' + Date.now()); // Should not throw
  });
});

describe('readJsonFile and writeJsonFile', () => {
  it('should write and read JSON file', () => {
    const filePath = path.join(getStorageConfig().baseDir, 'test-' + Date.now() + '.json');
    const data = { name: 'test', value: 123 };

    writeJsonFile(filePath, data);
    const readData = readJsonFile(filePath);

    expect(readData).toEqual(data);

    // Cleanup
    deleteFile(filePath);
  });

  it('should throw error if file does not exist', () => {
    const filePath = path.join(getStorageConfig().baseDir, 'non-existing-' + Date.now() + '.json');

    expect(() => readJsonFile(filePath)).toThrow('File not found');
  });

  it('should create parent directories if needed', () => {
    const filePath = path.join(getStorageConfig().baseDir, 'deep-' + Date.now(), 'nested', 'file.json');

    writeJsonFile(filePath, { test: true });
    expect(fs.existsSync(filePath)).toBe(true);

    // Cleanup
    const deepDir = path.dirname(path.dirname(filePath));
    fs.rmSync(deepDir, { recursive: true, force: true });
  });
});

describe('deleteFile', () => {
  it('should delete existing file', () => {
    const filePath = path.join(getStorageConfig().baseDir, 'to-delete-' + Date.now() + '.json');
    writeJsonFile(filePath, { test: true });

    deleteFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should not fail if file does not exist', () => {
    const filePath = path.join(getStorageConfig().baseDir, 'non-existing-' + Date.now() + '.json');
    deleteFile(filePath); // Should not throw
  });
});

describe('listFiles', () => {
  it('should list all files in directory', () => {
    const testDir = path.join(getStorageConfig().baseDir, 'list-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    writeJsonFile(path.join(testDir, 'file1.json'), {});
    writeJsonFile(path.join(testDir, 'file2.json'), {});
    writeJsonFile(path.join(testDir, 'file3.json'), {});

    const files = listFiles(testDir);
    expect(files).toContain('file1.json');
    expect(files).toContain('file2.json');
    expect(files).toContain('file3.json');

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty array if directory does not exist', () => {
    const files = listFiles('/non/existing/path');
    expect(files).toEqual([]);
  });

  it('should only return files, not directories', () => {
    const testDir = path.join(getStorageConfig().baseDir, 'files-dirs-test-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });

    writeJsonFile(path.join(testDir, 'file.json'), {});
    fs.mkdirSync(path.join(testDir, 'subdir'));

    const files = listFiles(testDir);
    expect(files).toContain('file.json');
    expect(files).not.toContain('subdir');

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

describe('fileExists', () => {
  it('should return true for existing file', () => {
    const filePath = path.join(getStorageConfig().baseDir, 'exists-test-' + Date.now() + '.json');
    writeJsonFile(filePath, {});

    expect(fileExists(filePath)).toBe(true);

    // Cleanup
    deleteFile(filePath);
  });

  it('should return false for non-existing file', () => {
    expect(fileExists('/non/existing/file-' + Date.now() + '.json')).toBe(false);
  });
});
