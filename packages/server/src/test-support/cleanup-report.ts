import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

export const CLEANUP_MANIFEST_FILE = 'cleanup-manifest.json';
export const CLEANUP_OWNER_CLOSE_FILE = 'cleanup-owner-close.json';

const rootOwnerSchema = z.enum([
  'runtime',
  'traffic-cache',
  'certificates',
  'body-staging',
  'upstream',
  'playwright-output',
  'playwright-traces',
]);
const rootPolicySchema = z.enum(['absent-or-empty', 'contained-until-parent-removal']);
const relativePathSchema = z.string().min(1).refine(value => {
  if (path.isAbsolute(value) || value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && value !== '..' && !value.startsWith('../');
}, 'Cleanup root must be a normalized contained relative path');
const cleanupRootSchema = z.strictObject({
  owner: rootOwnerSchema,
  relativePath: relativePathSchema,
  afterOwnerClose: rootPolicySchema,
});
const cleanupManifestSchema = z.strictObject({
  listeners: z.array(z.string().min(1)),
  socketOwners: z.array(z.string().min(1)),
  roots: z.array(cleanupRootSchema),
}).superRefine((value, context) => {
  for (const [label, values] of [
    ['listener', value.listeners],
    ['socket owner', value.socketOwners],
    ['root', value.roots.map(root => `${root.owner}:${root.relativePath}`)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate cleanup ${label}` });
    }
  }
});
const rootStateSchema = z.enum(['absent', 'empty', 'contained']);
const ownerCloseRootSchema = z.strictObject({
  owner: rootOwnerSchema,
  relativePath: relativePathSchema,
  state: rootStateSchema,
});
const ownerCloseReportSchema = z.strictObject({
  manifest: cleanupManifestSchema,
  closedListeners: z.array(z.string().min(1)),
  closedSocketOwners: z.array(z.string().min(1)),
  rootsAfterOwnerClose: z.array(ownerCloseRootSchema),
}).superRefine((value, context) => {
  for (const [label, values] of [
    ['closed listener', value.closedListeners],
    ['closed socket owner', value.closedSocketOwners],
    ['reported root', value.rootsAfterOwnerClose.map(root => `${root.owner}:${root.relativePath}`)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate ${label}` });
    }
  }
});

export interface CleanupManifest {
  listeners: readonly string[];
  socketOwners: readonly string[];
  roots: ReadonlyArray<{
    owner: z.infer<typeof rootOwnerSchema>;
    relativePath: string;
    afterOwnerClose: z.infer<typeof rootPolicySchema>;
  }>;
}

export interface CleanupOwnerCloseReport {
  manifest: CleanupManifest;
  closedListeners: readonly string[];
  closedSocketOwners: readonly string[];
  rootsAfterOwnerClose: ReadonlyArray<{
    owner: CleanupManifest['roots'][number]['owner'];
    relativePath: string;
    state: 'absent' | 'empty' | 'contained';
  }>;
}

export interface CleanupReport extends CleanupOwnerCloseReport {
  parentRemoved: boolean;
  rootsAfterParentRemoval: ReadonlyArray<{
    owner: CleanupManifest['roots'][number]['owner'];
    relativePath: string;
    state: 'absent';
  }>;
}

function checkedParent(parentRoot: string): string {
  const absolute = path.resolve(parentRoot);
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporaryRelative = path.relative(temporaryRoot, absolute);
  if (temporaryRelative === ''
    || temporaryRelative.startsWith('..')
    || path.isAbsolute(temporaryRelative)) {
    throw new Error(`Refusing cleanup parent outside temporary storage: ${parentRoot}`);
  }
  if (!/^mockmate-(?:integration|e2e)-/.test(path.basename(absolute))) {
    throw new Error(`Refusing unsafe cleanup parent: ${parentRoot}`);
  }
  return absolute;
}

function parseManifest(value: unknown): CleanupManifest {
  return cleanupManifestSchema.parse(value);
}

function parseOwnerCloseReport(value: unknown): CleanupOwnerCloseReport {
  return ownerCloseReportSchema.parse(value);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function containedPath(parentRoot: string, relativePath: string): string {
  const parent = checkedParent(parentRoot);
  const absolute = path.resolve(parent, relativePath);
  const relative = path.relative(parent, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cleanup root escapes parent: ${relativePath}`);
  }
  return absolute;
}

async function pathState(parentRoot: string, relativePath: string): Promise<'absent' | 'empty' | 'contained'> {
  const parent = checkedParent(parentRoot);
  const realParent = await fs.promises.realpath(parent);
  const absolute = containedPath(parent, relativePath);
  try {
    const real = await fs.promises.realpath(absolute);
    const relative = path.relative(realParent, real);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Cleanup root resolves outside parent: ${relativePath}`);
    }
    const stat = await fs.promises.stat(real);
    if (stat.isDirectory() && (await fs.promises.readdir(real)).length === 0) return 'empty';
    return 'contained';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

async function atomicJson(parentRoot: string, filename: string, value: unknown): Promise<void> {
  const parent = checkedParent(parentRoot);
  const target = path.join(parent, filename);
  const temporary = path.join(parent, `.${filename}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

export async function writeCleanupManifest(
  parentRoot: string,
  manifest: CleanupManifest,
): Promise<void> {
  await atomicJson(parentRoot, CLEANUP_MANIFEST_FILE, parseManifest(manifest));
}

export async function readCleanupManifest(parentRoot: string): Promise<CleanupManifest> {
  const parent = checkedParent(parentRoot);
  return parseManifest(JSON.parse(
    await fs.promises.readFile(path.join(parent, CLEANUP_MANIFEST_FILE), 'utf8'),
  ) as unknown);
}

export async function extendCleanupManifest(
  parentRoot: string,
  additions: CleanupManifest,
): Promise<CleanupManifest> {
  const current = await readCleanupManifest(parentRoot);
  const extended = parseManifest({
    listeners: [...current.listeners, ...additions.listeners],
    socketOwners: [...current.socketOwners, ...additions.socketOwners],
    roots: [...current.roots, ...additions.roots],
  });
  await writeCleanupManifest(parentRoot, extended);
  return extended;
}

export async function writeOwnerCloseReport(
  parentRoot: string,
  report: CleanupOwnerCloseReport,
): Promise<void> {
  await atomicJson(parentRoot, CLEANUP_OWNER_CLOSE_FILE, parseOwnerCloseReport(report));
}

export async function readOwnerCloseReport(parentRoot: string): Promise<CleanupOwnerCloseReport> {
  const parent = checkedParent(parentRoot);
  return parseOwnerCloseReport(JSON.parse(
    await fs.promises.readFile(path.join(parent, CLEANUP_OWNER_CLOSE_FILE), 'utf8'),
  ) as unknown);
}

export async function validateOwnerCloseReport(
  parentRoot: string,
  report: CleanupOwnerCloseReport,
): Promise<void> {
  const parsed = parseOwnerCloseReport(report);
  const persisted = await readCleanupManifest(parentRoot);
  if (!sameJson(parsed.manifest, persisted)) throw new Error('Cleanup report manifest identity mismatch');
  if (!sameJson(sorted(parsed.closedListeners), sorted(persisted.listeners))) {
    throw new Error('Cleanup report listener settlement mismatch');
  }
  if (!sameJson(sorted(parsed.closedSocketOwners), sorted(persisted.socketOwners))) {
    throw new Error('Cleanup report socket-owner settlement mismatch');
  }
  const manifestRoots = new Map(persisted.roots.map(root => [`${root.owner}:${root.relativePath}`, root]));
  const reportedRoots = new Map(parsed.rootsAfterOwnerClose.map(root => [
    `${root.owner}:${root.relativePath}`,
    root,
  ]));
  if (!sameJson(sorted([...manifestRoots.keys()]), sorted([...reportedRoots.keys()]))) {
    throw new Error('Cleanup report root settlement mismatch');
  }
  for (const [identity, root] of manifestRoots) {
    const reported = reportedRoots.get(identity)!;
    if (root.afterOwnerClose === 'absent-or-empty'
      && reported.state !== 'absent'
      && reported.state !== 'empty') {
      throw new Error(`Cleanup root violates ephemeral policy: ${identity}`);
    }
    const actual = await pathState(parentRoot, root.relativePath);
    if (actual !== reported.state) throw new Error(`Cleanup root state mismatch: ${identity}`);
  }
}

export async function finalizeCleanup(
  parentRoot: string,
  report: CleanupOwnerCloseReport,
): Promise<CleanupReport> {
  const parent = checkedParent(parentRoot);
  const parsed = parseOwnerCloseReport(report);
  const persisted = await readOwnerCloseReport(parent);
  if (!sameJson(parsed, persisted)) throw new Error('Cleanup owner-close artifact mismatch');
  await validateOwnerCloseReport(parent, parsed);
  const rootsAfterParentRemoval = parsed.manifest.roots.map(root => ({
    owner: root.owner,
    relativePath: root.relativePath,
    state: 'absent' as const,
  }));
  await fs.promises.rm(parent, { recursive: true, force: true });
  if (fs.existsSync(parent)) throw new Error('Cleanup parent remains after removal');
  for (const root of rootsAfterParentRemoval) {
    if (fs.existsSync(path.join(parent, root.relativePath))) {
      throw new Error(`Cleanup root remains after parent removal: ${root.owner}:${root.relativePath}`);
    }
  }
  return {
    ...parsed,
    parentRemoved: true,
    rootsAfterParentRemoval,
  };
}
