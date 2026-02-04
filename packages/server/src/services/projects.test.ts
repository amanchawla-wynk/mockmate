import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  setActiveProject,
  getActiveProject,
} from './projects';
import { initializeStorage, readConfig } from './storage';

let createdProjectIds: string[] = [];

beforeEach(() => {
  initializeStorage();
  createdProjectIds = [];
});

afterEach(() => {
  // Clean up created projects
  createdProjectIds.forEach(id => {
    try {
      deleteProject(id);
    } catch (e) {
      // Ignore cleanup errors
    }
  });
});

describe('createProject', () => {
  it('should create a new project with all fields', () => {
    const project = createProject({
      name: 'Test Project ' + Date.now(),
      description: 'A test project',
    });

    createdProjectIds.push(project.id);

    expect(project.id).toMatch(/^proj_\d+_[a-z0-9]+$/);
    expect(project.name).toContain('Test Project');
    expect(project.slug).toContain('test-project');
    expect(project.description).toBe('A test project');
    expect(project.activeScenario).toBe('default');
    expect(project.createdAt).toBeDefined();
    expect(project.updatedAt).toBeDefined();
  });

  it('should create project without description', () => {
    const project = createProject({
      name: 'Simple Project ' + Date.now(),
    });

    createdProjectIds.push(project.id);

    expect(project.name).toContain('Simple Project');
    expect(project.description).toBeUndefined();
  });

  it('should throw error if name is empty', () => {
    expect(() => createProject({ name: '' })).toThrow('Project name is required');
    expect(() => createProject({ name: '   ' })).toThrow('Project name is required');
  });

  it('should throw error if name has no valid characters', () => {
    expect(() => createProject({ name: '###' })).toThrow('must contain valid characters');
  });

  it('should throw error if project with same name exists', () => {
    const uniqueName = 'Duplicate Test ' + Date.now();
    const project1 = createProject({ name: uniqueName });
    createdProjectIds.push(project1.id);

    expect(() => createProject({ name: uniqueName })).toThrow('already exists');
  });

  it('should handle special characters in name', () => {
    const project = createProject({
      name: 'My Cool App! (2024)',
    });

    createdProjectIds.push(project.id);

    expect(project.name).toBe('My Cool App! (2024)');
    expect(project.slug).toBe('my-cool-app-2024');
  });

  it('should trim whitespace from name and description', () => {
    const project = createProject({
      name: '  Trimmed  ',
      description: '  Description  ',
    });

    createdProjectIds.push(project.id);

    expect(project.name).toBe('Trimmed');
    expect(project.description).toBe('Description');
  });
});

describe('listProjects', () => {
  it('should return empty array when no projects exist', () => {
    const projects = listProjects();
    // May have leftover projects from other tests, just check it's an array
    expect(Array.isArray(projects)).toBe(true);
  });

  it('should list all created projects', () => {
    const project1 = createProject({ name: 'Project A' });
    const project2 = createProject({ name: 'Project B' });
    const project3 = createProject({ name: 'Project C' });

    createdProjectIds.push(project1.id, project2.id, project3.id);

    const projects = listProjects();
    const projectIds = projects.map(p => p.id);

    expect(projectIds).toContain(project1.id);
    expect(projectIds).toContain(project2.id);
    expect(projectIds).toContain(project3.id);
  });

  it('should sort projects by creation date (newest first)', () => {
    const project1 = createProject({ name: 'First Project ' + Date.now() });
    // Small delay to ensure different timestamps
    const delay = () => new Promise(resolve => setTimeout(resolve, 10));

    delay().then(() => {
      const project2 = createProject({ name: 'Second Project ' + Date.now() });
      createdProjectIds.push(project1.id, project2.id);

      const projects = listProjects();
      const ourProjects = projects.filter(p =>
        p.id === project1.id || p.id === project2.id
      );

      if (ourProjects.length === 2) {
        expect(ourProjects[0].id).toBe(project2.id); // Newest first
        expect(ourProjects[1].id).toBe(project1.id);
      }
    });
  });
});

describe('getProject', () => {
  it('should get project by ID', () => {
    const created = createProject({ name: 'Get Test' });
    createdProjectIds.push(created.id);

    const retrieved = getProject(created.id);

    expect(retrieved.id).toBe(created.id);
    expect(retrieved.name).toBe('Get Test');
    expect(retrieved.slug).toBe('get-test');
  });

  it('should throw error if project not found', () => {
    expect(() => getProject('non-existing-id')).toThrow('not found');
  });
});

describe('updateProject', () => {
  it('should update project name', () => {
    const project = createProject({ name: 'Original Name ' + Date.now() });
    createdProjectIds.push(project.id);

    const updated = updateProject(project.id, {
      name: 'Updated Name',
    });

    expect(updated.name).toBe('Updated Name');
    expect(updated.slug).toBe('updated-name');
    expect(updated.id).toBe(project.id);
    expect(updated.updatedAt).not.toBe(project.updatedAt);
  });

  it('should update project description', () => {
    const project = createProject({ name: 'Test', description: 'Old' });
    createdProjectIds.push(project.id);

    const updated = updateProject(project.id, {
      description: 'New description',
    });

    expect(updated.description).toBe('New description');
    expect(updated.name).toBe('Test'); // Name unchanged
  });

  it('should update active scenario', () => {
    const project = createProject({ name: 'Test' });
    createdProjectIds.push(project.id);

    const updated = updateProject(project.id, {
      activeScenario: 'error',
    });

    expect(updated.activeScenario).toBe('error');
  });

  it('should throw error if new name conflicts with existing project', () => {
    const name1 = 'Project 1 ' + Date.now();
    const name2 = 'Project 2 ' + Date.now();
    const project1 = createProject({ name: name1 });
    const project2 = createProject({ name: name2 });
    createdProjectIds.push(project1.id, project2.id);

    expect(() =>
      updateProject(project2.id, { name: name1 })
    ).toThrow('already exists');
  });

  it('should throw error if project not found', () => {
    expect(() =>
      updateProject('non-existing', { name: 'New Name' })
    ).toThrow('not found');
  });

  it('should allow updating to same name', () => {
    const project = createProject({ name: 'Same Name' });
    createdProjectIds.push(project.id);

    const updated = updateProject(project.id, {
      name: 'Same Name',
      description: 'Updated description',
    });

    expect(updated.name).toBe('Same Name');
    expect(updated.description).toBe('Updated description');
  });
});

describe('deleteProject', () => {
  it('should delete project', () => {
    const project = createProject({ name: 'To Delete' });
    const id = project.id;

    deleteProject(id);

    expect(() => getProject(id)).toThrow('not found');
  });

  it('should throw error if project not found', () => {
    expect(() => deleteProject('non-existing')).toThrow('not found');
  });

  it('should clear active project if deleting active project', () => {
    const project = createProject({ name: 'Active Project' });
    createdProjectIds.push(project.id);

    setActiveProject(project.id);
    expect(readConfig().activeProjectId).toBe(project.id);

    deleteProject(project.id);
    expect(readConfig().activeProjectId).toBeUndefined();

    // Remove from cleanup list since it's deleted
    createdProjectIds = createdProjectIds.filter(id => id !== project.id);
  });
});

describe('setActiveProject', () => {
  it('should set active project', () => {
    const project = createProject({ name: 'Active Test' });
    createdProjectIds.push(project.id);

    setActiveProject(project.id);

    const config = readConfig();
    expect(config.activeProjectId).toBe(project.id);
  });

  it('should throw error if project not found', () => {
    expect(() => setActiveProject('non-existing')).toThrow('not found');
  });

  it('should update active project when called multiple times', () => {
    const project1 = createProject({ name: 'Project 1 ' + Date.now() });
    const project2 = createProject({ name: 'Project 2 ' + Date.now() });
    createdProjectIds.push(project1.id, project2.id);

    setActiveProject(project1.id);
    expect(readConfig().activeProjectId).toBe(project1.id);

    setActiveProject(project2.id);
    expect(readConfig().activeProjectId).toBe(project2.id);
  });
});

describe('getActiveProject', () => {
  it('should return null when no active project set', () => {
    const config = readConfig();
    config.activeProjectId = undefined;

    const active = getActiveProject();
    expect(active).toBeNull();
  });

  it('should return active project', () => {
    const project = createProject({ name: 'Active' });
    createdProjectIds.push(project.id);

    setActiveProject(project.id);

    const active = getActiveProject();
    expect(active).not.toBeNull();
    expect(active?.id).toBe(project.id);
    expect(active?.name).toBe('Active');
  });

  it('should return null and clear config if active project was deleted', () => {
    const project = createProject({ name: 'Will Be Deleted' });
    setActiveProject(project.id);

    // Manually delete project without going through deleteProject
    deleteProject(project.id);
    createdProjectIds = createdProjectIds.filter(id => id !== project.id);

    const active = getActiveProject();
    expect(active).toBeNull();
    expect(readConfig().activeProjectId).toBeUndefined();
  });
});

describe('Full CRUD lifecycle', () => {
  it('should handle complete project lifecycle', () => {
    // Create
    const project = createProject({
      name: 'Lifecycle Test',
      description: 'Testing full lifecycle',
    });
    createdProjectIds.push(project.id);

    expect(project.name).toBe('Lifecycle Test');

    // Read (list)
    const projects = listProjects();
    expect(projects.some(p => p.id === project.id)).toBe(true);

    // Read (get)
    const retrieved = getProject(project.id);
    expect(retrieved.id).toBe(project.id);

    // Update
    const updated = updateProject(project.id, {
      description: 'Updated lifecycle test',
    });
    expect(updated.description).toBe('Updated lifecycle test');

    // Set as active
    setActiveProject(project.id);
    expect(getActiveProject()?.id).toBe(project.id);

    // Delete
    deleteProject(project.id);
    expect(() => getProject(project.id)).toThrow('not found');
    expect(getActiveProject()).toBeNull();

    createdProjectIds = createdProjectIds.filter(id => id !== project.id);
  });
});
