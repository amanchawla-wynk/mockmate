import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const tool = new URL('./slice3-review-artifacts.mjs', import.meta.url).pathname;
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const baselineNames = [
  'head.txt',
  'status.zlist',
  'worktree.patch',
  'index.patch',
  'deleted-paths.zlist',
  'head.tar',
  'existing-paths.zlist',
  'worktree-existing.tar',
  'archived-paths.txt',
  'LOCATION.txt',
];
const captureSuffixes = [
  'current.tar',
  'existing-paths.zlist',
  'deleted-paths.zlist',
  'status.zlist',
  'members.zlist',
  'baseline-to-current.patch',
  'whitespace-check.txt',
  'hashes.json',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function git(repo, args, options = {}) {
  const result = run(realGit, args, { cwd: repo, ...options });
  assert.equal(result.status, 0, `${realGit} ${args.join(' ')}\n${result.stderr.toString()}`);
  return result.stdout;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function write(path, value, mode) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
  if (mode !== undefined) await chmod(path, mode);
}

async function createBaseline(repo, baselineDir) {
  await mkdir(baselineDir);
  const output = new Map();
  output.set('head.txt', git(repo, ['rev-parse', 'HEAD']));
  output.set('status.zlist', git(repo, ['status', '--porcelain=v1', '-z']));
  output.set('worktree.patch', git(repo, ['diff', '--binary']));
  output.set('index.patch', git(repo, ['diff', '--cached', '--binary']));
  output.set('deleted-paths.zlist', git(repo, ['diff', '--name-only', '--diff-filter=D', '-z']));
  output.set('head.tar', git(repo, ['archive', '--format=tar', 'HEAD']));

  const listed = git(repo, ['ls-files', '-c', '-o', '--exclude-standard', '-z']);
  const existing = [];
  for (const path of listed.toString().split('\0').filter(Boolean)) {
    try {
      await lstat(join(repo, path));
      existing.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  output.set('existing-paths.zlist', Buffer.from(`${existing.join('\0')}\0`));
  const listPath = join(baselineDir, '.baseline-paths.zlist');
  await writeFile(listPath, output.get('existing-paths.zlist'));
  const archive = run('tar', ['--null', '-T', listPath, '-cf', '-'], { cwd: repo });
  assert.equal(archive.status, 0, archive.stderr.toString());
  output.set('worktree-existing.tar', archive.stdout);
  const members = run('tar', ['-tf', '-'], { input: archive.stdout });
  assert.equal(members.status, 0, members.stderr.toString());
  output.set('archived-paths.txt', members.stdout);
  output.set('LOCATION.txt', Buffer.from(`${baselineDir}\n`));
  await rm(listPath);

  for (const [name, contents] of output) await writeFile(join(baselineDir, name), contents);
  const sums = baselineNames.map(name => {
    const contents = output.get(name);
    return `${sha256(contents)}  ${join(baselineDir, name)}`;
  }).join('\n');
  await writeFile(join(baselineDir, 'SHA256SUMS'), `${sums}\n`);
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mockmate-review-artifacts-test-'));
  const repo = join(root, 'repo');
  const baselineDir = join(root, 'baseline');
  await mkdir(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'MockMate Test']);
  git(repo, ['config', 'user.email', 'mockmate@example.test']);
  await write(join(repo, 'plain.txt'), 'baseline\n');
  await write(join(repo, 'delete me.txt'), 'remove me\n');
  await write(join(repo, 'space name.txt'), 'space\n');
  await write(join(repo, 'line\nbreak.txt'), 'newline\n');
  await write(join(repo, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  await symlink('plain.txt', join(repo, 'plain-link'));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);
  await createBaseline(repo, baselineDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { baselineDir, repo, root };
}

function cli(repo, args, env = {}) {
  return run(process.execPath, [tool, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
  });
}

function output(result) {
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function capture(repo, baselineDir, label, env) {
  return cli(repo, ['capture-diff', '--baseline-dir', baselineDir, '--label', label], env);
}

function verify(repo, baselineDir, label) {
  return cli(repo, ['verify-capture', '--baseline-dir', baselineDir, '--label', label]);
}

async function assertNoLabelArtifacts(baselineDir, label) {
  const names = await readdir(baselineDir);
  assert.deepEqual(names.filter(name => name.startsWith(`${label}-`)), []);
}

test('capture preserves NUL-safe names, symlinks, modes, deletions, and untracked files', async t => {
  const { baselineDir, repo, root } = await createFixture(t);
  await write(join(repo, 'plain.txt'), 'changed\n');
  await rm(join(repo, 'delete me.txt'));
  await write(join(repo, 'untracked space.txt'), 'new\n');
  await write(join(repo, 'untracked\nline.txt'), 'new line\n');
  await rm(join(repo, 'plain-link'));
  await symlink('space name.txt', join(repo, 'plain-link'));

  const result = capture(repo, baselineDir, 'complete');
  assert.equal(result.status, 0, output(result));
  assert.equal(verify(repo, baselineDir, 'complete').status, 0);

  const paths = await readFile(join(baselineDir, 'complete-existing-paths.zlist'));
  assert(paths.includes(Buffer.from('untracked space.txt\0')));
  assert(paths.includes(Buffer.from('untracked\nline.txt\0')));
  const members = await readFile(join(baselineDir, 'complete-members.zlist'));
  assert.deepEqual(members, paths);
  assert.deepEqual(
    (await readFile(join(baselineDir, 'complete-deleted-paths.zlist'))).toString().split('\0').filter(Boolean),
    ['delete me.txt'],
  );
  assert.match(await readFile(join(baselineDir, 'complete-whitespace-check.txt'), 'utf8'), /^PASS\n$/);

  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  const untar = run('tar', ['-xf', join(baselineDir, 'complete-current.tar'), '-C', extracted]);
  assert.equal(untar.status, 0, untar.stderr.toString());
  assert.equal((await lstat(join(extracted, 'bin', 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(extracted, 'plain-link'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(extracted, 'plain-link')), 'space name.txt');
  await assert.rejects(lstat(join(extracted, 'delete me.txt')), { code: 'ENOENT' });

  const hashes = JSON.parse(await readFile(join(baselineDir, 'complete-hashes.json'), 'utf8'));
  assert.equal(hashes.label, 'complete');
  assert.equal(hashes.changedDuringCapture, false);
  assert.equal(hashes.whitespaceCheck, 'PASS');
  assert.deepEqual(Object.keys(hashes.artifacts).sort(), captureSuffixes.slice(0, -1).sort());
});

test('rejects a repository-contained artifact directory before writing', async t => {
  const { repo } = await createFixture(t);
  const contained = join(repo, 'artifacts');
  await mkdir(contained);
  const result = capture(repo, contained, 'inside');
  assert.notEqual(result.status, 0);
  assert.match(output(result), /outside|contained/i);
  await assertNoLabelArtifacts(contained, 'inside');
});

test('rejects an immutable baseline hash mismatch', async t => {
  const { baselineDir, repo } = await createFixture(t);
  await writeFile(join(baselineDir, 'head.txt'), 'tampered\n');
  const result = capture(repo, baselineDir, 'tampered');
  assert.notEqual(result.status, 0);
  assert.match(output(result), /SHA256SUMS|hash/i);
  await assertNoLabelArtifacts(baselineDir, 'tampered');
});

test('rejects whitespace errors in a non-ignored untracked file atomically', async t => {
  const { baselineDir, repo } = await createFixture(t);
  await writeFile(join(repo, 'new file.txt'), 'trailing space \n');
  const result = capture(repo, baselineDir, 'whitespace');
  assert.notEqual(result.status, 0);
  assert.match(output(result), /whitespace|trailing/i);
  await assertNoLabelArtifacts(baselineDir, 'whitespace');
});

test('rejects a worktree that changes during capture', async t => {
  const { baselineDir, repo, root } = await createFixture(t);
  const bin = join(root, 'bin');
  const marker = join(root, 'changed-once');
  await mkdir(bin);
  await write(join(bin, 'git'), [
    '#!/bin/sh',
    `"${realGit}" "$@"`,
    'code=$?',
    `if test "$1" = status && test ! -e "${marker}"; then`,
    `  : > "${marker}"`,
    `  printf changed >> "${join(repo, 'plain.txt')}"`,
    'fi',
    'exit "$code"',
    '',
  ].join('\n'), 0o755);
  const result = capture(repo, baselineDir, 'moving', { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /changed during capture/i);
  await assertNoLabelArtifacts(baselineDir, 'moving');
});

test('accepts ordinary diff exits and rejects an unexpected diff exit', async t => {
  const { baselineDir, repo, root } = await createFixture(t);
  const same = capture(repo, baselineDir, 'same');
  assert.equal(same.status, 0, output(same));
  await writeFile(join(repo, 'plain.txt'), 'different\n');
  const different = capture(repo, baselineDir, 'different');
  assert.equal(different.status, 0, output(different));
  assert.notEqual((await readFile(join(baselineDir, 'different-baseline-to-current.patch'))).length, 0);

  const bin = join(root, 'bad-diff-bin');
  await mkdir(bin);
  await write(join(bin, 'git'), [
    '#!/bin/sh',
    'for argument in "$@"; do',
    '  if test "$argument" = --no-index; then exit 2; fi',
    'done',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'), 0o755);
  const failed = capture(repo, baselineDir, 'bad-diff', { PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(failed.status, 0);
  assert.match(output(failed), /diff.*exit|exit.*2/i);
  await assertNoLabelArtifacts(baselineDir, 'bad-diff');
});

test('repeated captures are deterministic and labels are immutable', async t => {
  const { baselineDir, repo } = await createFixture(t);
  await writeFile(join(repo, 'plain.txt'), 'stable change\n');
  assert.equal(capture(repo, baselineDir, 'repeat-1').status, 0);
  assert.equal(capture(repo, baselineDir, 'repeat-2').status, 0);
  for (const suffix of captureSuffixes.slice(0, -1)) {
    assert.deepEqual(
      await readFile(join(baselineDir, `repeat-1-${suffix}`)),
      await readFile(join(baselineDir, `repeat-2-${suffix}`)),
      suffix,
    );
  }
  const before = await readFile(join(baselineDir, 'repeat-1-hashes.json'));
  const duplicate = capture(repo, baselineDir, 'repeat-1');
  assert.notEqual(duplicate.status, 0);
  assert.match(output(duplicate), /exists|overwrite|label/i);
  assert.deepEqual(await readFile(join(baselineDir, 'repeat-1-hashes.json')), before);
});

test('review seals bind an immutable reviewed capture to an identical candidate', async t => {
  const { baselineDir, repo } = await createFixture(t);
  await writeFile(join(repo, 'plain.txt'), 'approved\n');
  assert.equal(capture(repo, baselineDir, 'reviewed').status, 0);
  const seal = cli(repo, ['seal-reviewed', '--baseline-dir', baselineDir, '--label', 'reviewed']);
  assert.equal(seal.status, 0, output(seal));
  const sealPath = join(baselineDir, 'reviewed-reviewed-seal.json');
  const originalSeal = await readFile(sealPath);
  assert.notEqual(originalSeal.length, 0);
  assert.notEqual(cli(repo, ['seal-reviewed', '--baseline-dir', baselineDir, '--label', 'reviewed']).status, 0);
  assert.deepEqual(await readFile(sealPath), originalSeal);

  assert.equal(capture(repo, baselineDir, 'candidate').status, 0);
  const verified = cli(repo, [
    'verify-reviewed',
    '--baseline-dir', baselineDir,
    '--reviewed-label', 'reviewed',
    '--candidate-label', 'candidate',
  ]);
  assert.equal(verified.status, 0, output(verified));

  await writeFile(join(baselineDir, 'candidate-status.zlist'), 'tampered');
  const mismatch = cli(repo, [
    'verify-reviewed',
    '--baseline-dir', baselineDir,
    '--reviewed-label', 'reviewed',
    '--candidate-label', 'candidate',
  ]);
  assert.notEqual(mismatch.status, 0);
  assert.match(output(mismatch), /hash|mismatch/i);
});
