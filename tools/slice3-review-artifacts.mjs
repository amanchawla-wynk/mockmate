import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
const artifactSuffixes = [
  'current.tar',
  'existing-paths.zlist',
  'deleted-paths.zlist',
  'status.zlist',
  'members.zlist',
  'baseline-to-current.patch',
  'whitespace-check.txt',
];
const comparedSuffixes = [...artifactSuffixes];
const snapshotNames = [
  'head.txt',
  'status.zlist',
  'worktree.patch',
  'index.patch',
  'deleted-paths.zlist',
  'existing-paths.zlist',
  'current.tar',
];
const maxBuffer = 1024 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function resultText(result) {
  return Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString();
}

function run(command, args, { cwd, input, stdoutPath } = {}) {
  let descriptor;
  try {
    const stdio = ['pipe', 'pipe', 'pipe'];
    if (stdoutPath) {
      descriptor = openSync(stdoutPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      stdio[1] = descriptor;
    }
    const result = spawnSync(command, args, { cwd, input, maxBuffer, stdio });
    if (result.error) throw result.error;
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function runExpected(command, args, options = {}, accepted = [0]) {
  const result = run(command, args, options);
  if (!accepted.includes(result.status)) {
    fail(`${command} ${args.join(' ')} exited ${result.status}\n${resultText(result)}`.trimEnd());
  }
  return result;
}

function runGit(args, options = {}, accepted = [0]) {
  return runExpected('git', args, options, accepted);
}

function writeGitOutput(path, repo, args) {
  runGit(args, { cwd: repo, stdoutPath: path });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`Invalid arguments near ${key ?? '<end>'}`);
    }
    const name = key.slice(2);
    if (options[name] !== undefined) fail(`Duplicate option ${key}`);
    options[name] = value;
  }
  return { command, options };
}

function requireOptions(options, required) {
  const allowed = new Set(required);
  for (const name of required) {
    if (!options[name]) fail(`Missing required option --${name}`);
  }
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`Unknown option --${name}`);
  }
}

function validateLabel(label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    fail(`Invalid immutable artifact label: ${JSON.stringify(label)}`);
  }
}

function isContained(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function establishContext(baselineOption) {
  if (!isAbsolute(baselineOption)) fail('--baseline-dir must be an absolute external path');
  const baselineDir = realpathSync(baselineOption);
  if (!statSync(baselineDir).isDirectory()) fail('--baseline-dir must name a directory');
  const repoResult = runGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
  const repo = realpathSync(repoResult.stdout.toString().trim());
  if (isContained(repo, baselineDir)) {
    fail('Artifact directory must be outside and not contained by the repository');
  }
  return { baselineDir, repo };
}

function parseChecksumLine(line) {
  const match = /^([0-9a-f]{64}) ([ *])(.+)$/.exec(line);
  if (!match) fail(`Invalid SHA256SUMS line: ${JSON.stringify(line)}`);
  return { expected: match[1], path: match[3] };
}

function verifyBaseline({ baselineDir }) {
  const checksumPath = join(baselineDir, 'SHA256SUMS');
  const checksumContents = readFileSync(checksumPath);
  const lines = checksumContents.toString().split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const entry = parseChecksumLine(line);
    const path = isAbsolute(entry.path) ? resolve(entry.path) : resolve(baselineDir, entry.path);
    const realPath = realpathSync(path);
    if (dirname(realPath) !== baselineDir || !baselineNames.includes(basename(path))) {
      fail(`SHA256SUMS contains an unexpected or external path: ${entry.path}`);
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`Baseline artifact is not a regular file: ${path}`);
    const actual = sha256File(path);
    if (actual !== entry.expected) fail(`SHA256SUMS hash mismatch for ${path}`);
    if (seen.has(basename(path))) fail(`SHA256SUMS repeats ${basename(path)}`);
    seen.add(basename(path));
  }
  if (seen.size !== baselineNames.length || baselineNames.some(name => !seen.has(name))) {
    fail('SHA256SUMS does not contain the exact immutable Task 0 baseline inventory');
  }
  const recordedLocation = readFileSync(join(baselineDir, 'LOCATION.txt'), 'utf8').trimEnd();
  if (!isAbsolute(recordedLocation) || realpathSync(recordedLocation) !== baselineDir) {
    fail('LOCATION.txt does not identify the external baseline directory');
  }
  runExpected('tar', ['-tf', join(baselineDir, 'head.tar')]);
  runExpected('tar', ['-tf', join(baselineDir, 'worktree-existing.tar')]);
  return sha256(checksumContents);
}

function splitNul(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) values.push(buffer.subarray(start, index).toString());
      start = index + 1;
    }
  }
  if (start !== buffer.length) fail('Git path inventory was not NUL terminated');
  return values;
}

function existingInventory(repo) {
  const result = runGit(['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: repo });
  const existing = splitNul(result.stdout).filter(path => {
    try {
      lstatSync(join(repo, path));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
  return Buffer.from(existing.length === 0 ? '' : `${existing.join('\0')}\0`);
}

function captureSnapshot(repo, directory) {
  mkdirSync(directory);
  writeGitOutput(join(directory, 'head.txt'), repo, ['rev-parse', 'HEAD']);
  writeGitOutput(join(directory, 'status.zlist'), repo, ['status', '--porcelain=v1', '-z']);
  writeGitOutput(join(directory, 'worktree.patch'), repo, ['diff', '--binary']);
  writeGitOutput(join(directory, 'index.patch'), repo, ['diff', '--cached', '--binary']);
  writeGitOutput(join(directory, 'deleted-paths.zlist'), repo, [
    'diff', '--name-only', '--diff-filter=D', '-z',
  ]);
  const inventory = existingInventory(repo);
  const inventoryPath = join(directory, 'existing-paths.zlist');
  writeFileSync(inventoryPath, inventory, { flag: 'wx' });
  runExpected('tar', ['--null', '-T', inventoryPath, '-cf', join(directory, 'current.tar')], { cwd: repo });
  runExpected('tar', ['-tf', join(directory, 'current.tar')]);
}

function assertSnapshotsEqual(first, second) {
  for (const name of snapshotNames) {
    const firstContents = readFileSync(join(first, name));
    const secondContents = readFileSync(join(second, name));
    if (!firstContents.equals(secondContents)) fail(`Repository changed during capture (${name})`);
  }
}

function compareTrees({ baselineArchive, currentArchive, directory, patchPath, whitespacePath }) {
  const compareDir = join(directory, 'comparison');
  const baselineTree = join(compareDir, 'baseline');
  const currentTree = join(compareDir, 'current');
  mkdirSync(baselineTree, { recursive: true });
  mkdirSync(currentTree);
  runExpected('tar', ['-xf', baselineArchive, '-C', baselineTree]);
  runExpected('tar', ['-xf', currentArchive, '-C', currentTree]);

  const patch = run('git', ['diff', '--no-index', '--binary', '--', 'baseline', 'current'], {
    cwd: compareDir,
    stdoutPath: patchPath,
  });
  if (![0, 1].includes(patch.status)) {
    fail(`git diff --no-index patch exited ${patch.status}\n${resultText(patch)}`.trimEnd());
  }

  const check = run('git', ['diff', '--no-index', '--binary', '--check', '--', 'baseline', 'current'], {
    cwd: compareDir,
  });
  const diagnostics = resultText(check);
  if (diagnostics.length > 0) fail(`Exact-tree whitespace check failed\n${diagnostics}`.trimEnd());
  if (![0, 1].includes(check.status)) {
    fail(`git diff --no-index --check exited ${check.status}`);
  }
  writeFileSync(whitespacePath, 'PASS\n', { flag: 'wx' });
  return currentTree;
}

function validateExtractedMembership(currentTree, inventory) {
  const actual = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else actual.push(relative(currentTree, path));
    }
  };
  visit(currentTree);
  const expected = splitNul(inventory);
  if (actual.length !== expected.length || actual.some(path => !expected.includes(path))) {
    fail('Extracted current archive membership does not match the NUL-safe path inventory');
  }
}

function artifactPath(baselineDir, label, suffix) {
  return join(baselineDir, `${label}-${suffix}`);
}

function assertUnusedCaptureLabel(baselineDir, label) {
  const names = [...artifactSuffixes, 'hashes.json', 'reviewed-seal.json'];
  for (const suffix of names) {
    if (existsSync(artifactPath(baselineDir, label, suffix))) {
      fail(`Immutable label ${label} already exists; refusing to overwrite it`);
    }
  }
}

function publishExclusively(entries) {
  const published = [];
  try {
    for (const [source, destination] of entries) {
      const result = runExpected('ln', [source, destination]);
      if (result.status === 0) published.push(destination);
    }
  } catch (error) {
    for (const path of published.reverse()) unlinkSync(path);
    throw error;
  }
}

function captureDiff(context, label) {
  validateLabel(label);
  assertUnusedCaptureLabel(context.baselineDir, label);
  const baselineSha256Sums = verifyBaseline(context);
  const workDir = mkdtempSync(join(context.baselineDir, `.${label}.capture-`));
  try {
    const first = join(workDir, 'first');
    const second = join(workDir, 'second');
    const final = join(workDir, 'final');
    captureSnapshot(context.repo, first);
    captureSnapshot(context.repo, second);
    assertSnapshotsEqual(first, second);

    const inventory = readFileSync(join(first, 'existing-paths.zlist'));
    const membersPath = join(workDir, 'members.zlist');
    const patchPath = join(workDir, 'baseline-to-current.patch');
    const whitespacePath = join(workDir, 'whitespace-check.txt');
    const currentTree = compareTrees({
      baselineArchive: join(context.baselineDir, 'worktree-existing.tar'),
      currentArchive: join(first, 'current.tar'),
      directory: workDir,
      patchPath,
      whitespacePath,
    });
    validateExtractedMembership(currentTree, inventory);
    writeFileSync(membersPath, inventory, { flag: 'wx' });
    captureSnapshot(context.repo, final);
    assertSnapshotsEqual(first, final);

    const sources = {
      'current.tar': join(first, 'current.tar'),
      'existing-paths.zlist': join(first, 'existing-paths.zlist'),
      'deleted-paths.zlist': join(first, 'deleted-paths.zlist'),
      'status.zlist': join(first, 'status.zlist'),
      'members.zlist': membersPath,
      'baseline-to-current.patch': patchPath,
      'whitespace-check.txt': whitespacePath,
    };
    const hashes = {};
    for (const suffix of artifactSuffixes) hashes[suffix] = sha256File(sources[suffix]);
    const hashesPath = join(workDir, 'hashes.json');
    writeFileSync(hashesPath, `${JSON.stringify({
      formatVersion: 1,
      label,
      baselineSha256Sums,
      changedDuringCapture: false,
      whitespaceCheck: 'PASS',
      artifacts: hashes,
    }, null, 2)}\n`, { flag: 'wx' });

    publishExclusively([
      ...artifactSuffixes.map(suffix => [sources[suffix], artifactPath(context.baselineDir, label, suffix)]),
      [hashesPath, artifactPath(context.baselineDir, label, 'hashes.json')],
    ]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function readCapture(context, label) {
  validateLabel(label);
  const baselineSha256Sums = verifyBaseline(context);
  const hashesPath = artifactPath(context.baselineDir, label, 'hashes.json');
  const hashesContents = readFileSync(hashesPath);
  let record;
  try {
    record = JSON.parse(hashesContents);
  } catch {
    fail(`Unreadable hashes record for ${label}`);
  }
  if (record.formatVersion !== 1 || record.label !== label) fail(`Invalid hashes record for ${label}`);
  if (record.baselineSha256Sums !== baselineSha256Sums) fail(`Baseline hash mismatch for capture ${label}`);
  if (record.changedDuringCapture !== false) fail(`Capture ${label} has a changed-during-capture signal`);
  if (record.whitespaceCheck !== 'PASS') fail(`Capture ${label} did not pass whitespace checks`);
  if (!record.artifacts || Object.keys(record.artifacts).length !== artifactSuffixes.length) {
    fail(`Invalid artifact hash inventory for ${label}`);
  }
  for (const suffix of artifactSuffixes) {
    const expected = record.artifacts[suffix];
    const path = artifactPath(context.baselineDir, label, suffix);
    if (!/^[0-9a-f]{64}$/.test(expected ?? '') || sha256File(path) !== expected) {
      fail(`Artifact hash mismatch for ${label}-${suffix}`);
    }
  }
  if (readFileSync(artifactPath(context.baselineDir, label, 'whitespace-check.txt'), 'utf8') !== 'PASS\n') {
    fail(`Whitespace PASS artifact mismatch for ${label}`);
  }
  const paths = readFileSync(artifactPath(context.baselineDir, label, 'existing-paths.zlist'));
  const members = readFileSync(artifactPath(context.baselineDir, label, 'members.zlist'));
  if (!paths.equals(members)) fail(`Path and member manifests mismatch for ${label}`);
  splitNul(paths);

  const verifyDir = mkdtempSync(join(context.baselineDir, `.${label}.verify-`));
  try {
    const patchPath = join(verifyDir, 'baseline-to-current.patch');
    const whitespacePath = join(verifyDir, 'whitespace-check.txt');
    const currentTree = compareTrees({
      baselineArchive: join(context.baselineDir, 'worktree-existing.tar'),
      currentArchive: artifactPath(context.baselineDir, label, 'current.tar'),
      directory: verifyDir,
      patchPath,
      whitespacePath,
    });
    validateExtractedMembership(currentTree, paths);
    if (!readFileSync(patchPath).equals(readFileSync(artifactPath(
      context.baselineDir,
      label,
      'baseline-to-current.patch',
    )))) fail(`Deterministic patch mismatch for ${label}`);
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
  return { hashesContents, record };
}

function sealReviewed(context, label) {
  const capture = readCapture(context, label);
  const sealPath = artifactPath(context.baselineDir, label, 'reviewed-seal.json');
  if (existsSync(sealPath)) fail(`Reviewed seal for immutable label ${label} already exists`);
  const workDir = mkdtempSync(join(context.baselineDir, `.${label}.seal-`));
  try {
    const temporary = join(workDir, 'reviewed-seal.json');
    writeFileSync(temporary, `${JSON.stringify({
      formatVersion: 1,
      reviewedLabel: label,
      hashesSha256: sha256(capture.hashesContents),
      artifacts: capture.record.artifacts,
    }, null, 2)}\n`, { flag: 'wx' });
    publishExclusively([[temporary, sealPath]]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function verifyReviewed(context, reviewedLabel, candidateLabel) {
  validateLabel(reviewedLabel);
  validateLabel(candidateLabel);
  if (reviewedLabel === candidateLabel) fail('Reviewed and candidate labels must be unique');
  const reviewed = readCapture(context, reviewedLabel);
  const candidate = readCapture(context, candidateLabel);
  const sealPath = artifactPath(context.baselineDir, reviewedLabel, 'reviewed-seal.json');
  let seal;
  try {
    seal = JSON.parse(readFileSync(sealPath, 'utf8'));
  } catch {
    fail(`Unreadable reviewed seal for ${reviewedLabel}`);
  }
  if (seal.formatVersion !== 1 || seal.reviewedLabel !== reviewedLabel) {
    fail(`Invalid reviewed seal for ${reviewedLabel}`);
  }
  if (seal.hashesSha256 !== sha256(reviewed.hashesContents)) {
    fail(`Reviewed hashes mismatch for ${reviewedLabel}`);
  }
  for (const suffix of comparedSuffixes) {
    if (seal.artifacts?.[suffix] !== reviewed.record.artifacts[suffix]) {
      fail(`Reviewed seal artifact mismatch for ${suffix}`);
    }
    if (reviewed.record.artifacts[suffix] !== candidate.record.artifacts[suffix]) {
      fail(`Reviewed/candidate hash mismatch for ${suffix}`);
    }
  }
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'capture-diff') {
    requireOptions(options, ['baseline-dir', 'label']);
    const context = establishContext(options['baseline-dir']);
    captureDiff(context, options.label);
    process.stdout.write(`Captured immutable review artifacts for ${options.label}\n`);
    return;
  }
  if (command === 'verify-capture') {
    requireOptions(options, ['baseline-dir', 'label']);
    const context = establishContext(options['baseline-dir']);
    readCapture(context, options.label);
    process.stdout.write(`Verified review capture ${options.label}\n`);
    return;
  }
  if (command === 'seal-reviewed') {
    requireOptions(options, ['baseline-dir', 'label']);
    const context = establishContext(options['baseline-dir']);
    sealReviewed(context, options.label);
    process.stdout.write(`Sealed reviewed capture ${options.label}\n`);
    return;
  }
  if (command === 'verify-reviewed') {
    requireOptions(options, ['baseline-dir', 'reviewed-label', 'candidate-label']);
    const context = establishContext(options['baseline-dir']);
    verifyReviewed(context, options['reviewed-label'], options['candidate-label']);
    process.stdout.write(
      `Verified candidate ${options['candidate-label']} against reviewed capture ${options['reviewed-label']}\n`,
    );
    return;
  }
  fail('Usage: slice3-review-artifacts.mjs <capture-diff|verify-capture|seal-reviewed|verify-reviewed> ...');
}

try {
  main();
} catch (error) {
  process.stderr.write(`slice3-review-artifacts: ${error.message}\n`);
  process.exitCode = 1;
}
