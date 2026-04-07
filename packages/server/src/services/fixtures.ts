/**
 * Fixture storage service.
 * Stores and reads raw HTTP response fixtures on disk.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getProjectDirectory } from './storage';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeRelPath(relPath: string): string {
  // Force posix-style separators for stored paths.
  const p = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..')) {
    throw new Error('Invalid fixture path');
  }
  return p;
}

export function getFixturesRoot(projectSlug: string): string {
  return path.join(getProjectDirectory(projectSlug), 'fixtures');
}

// ============================================================================
// Static file helpers (per-project media files served at /static_files/...)
// ============================================================================

export interface StaticFileEntry {
  path: string;   // relative posix path, e.g. "videos/10_min_hls/master.m3u8"
  size: number;   // bytes
  mtime: string;  // ISO-8601
}

export function getStaticFilesRoot(projectSlug: string): string {
  return path.join(getProjectDirectory(projectSlug), 'static_files');
}

export function resolveStaticFilePath(projectSlug: string, relPath: string): string {
  const root = getStaticFilesRoot(projectSlug);
  const normalized = normalizeRelPath(relPath);
  const abs = path.join(root, normalized);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid static file path');
  }
  return abs;
}

function walkDir(dir: string, root: string, out: StaticFileEntry[]): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      walkDir(abs, root, out);
    } else {
      out.push({
        path: path.relative(root, abs).replace(/\\/g, '/'),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
}

export function listStaticFiles(projectSlug: string): StaticFileEntry[] {
  const root = getStaticFilesRoot(projectSlug);
  const out: StaticFileEntry[] = [];
  walkDir(root, root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function writeStaticFile(
  projectSlug: string,
  relPath: string,
  data: Buffer,
): StaticFileEntry {
  const abs = resolveStaticFilePath(projectSlug, relPath);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, data);
  const stat = fs.statSync(abs);
  return {
    path: normalizeRelPath(relPath),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export function deleteStaticFile(projectSlug: string, relPath: string): void {
  const abs = resolveStaticFilePath(projectSlug, relPath);
  if (!fs.existsSync(abs)) throw new Error('File not found');
  fs.unlinkSync(abs);
  // Remove empty parent directories up to static_files root.
  const root = getStaticFilesRoot(projectSlug);
  let dir = path.dirname(abs);
  while (dir !== root && dir.startsWith(root)) {
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } else {
      break;
    }
  }
}

export function resolveFixturePath(projectSlug: string, relPath: string): string {
  const root = getProjectDirectory(projectSlug);
  const normalized = normalizeRelPath(relPath);
  const abs = path.join(root, normalized);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid fixture path');
  }
  return abs;
}

export function writeHttpResponseFixture(
  projectSlug: string,
  relPath: string,
  statusCode: number,
  headers: Record<string, string>,
  body: Buffer,
): { relPath: string; size: number; truncated: boolean; contentType?: string } {
  const normalized = normalizeRelPath(relPath);
  const abs = resolveFixturePath(projectSlug, normalized);
  ensureDir(path.dirname(abs));

  // Size guard to avoid accidental giant fixtures.
  const MAX_BYTES = (() => {
    const raw = process.env.MOCKMATE_RAW_CAPTURE_LIMIT_BYTES;
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
    return 50 * 1024 * 1024; // 50MB
  })();

  const truncated = body.length > MAX_BYTES;
  const bodySlice = truncated ? body.subarray(0, MAX_BYTES) : body;

  const lines: string[] = [];
  lines.push(`HTTP/1.1 ${statusCode}`);
  for (const [k, v] of Object.entries(headers ?? {})) {
    // Preserve keys as-is if caller wants; normalize CRLF.
    const key = String(k).replace(/[\r\n]+/g, ' ').trim();
    const val = String(v).replace(/[\r\n]+/g, ' ').trim();
    if (!key) continue;
    lines.push(`${key}: ${val}`);
  }
  const headerBlock = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf-8');
  const buf = Buffer.concat([headerBlock, bodySlice]);

  fs.writeFileSync(abs, buf);

  const contentType = headers['content-type'] ?? headers['Content-Type'];
  return { relPath: normalized, size: buf.length, truncated, contentType };
}

export function readHttpResponseFixture(
  projectSlug: string,
  relPath: string,
): { statusCode: number; headers: Record<string, string>; body: Buffer } {
  const abs = resolveFixturePath(projectSlug, relPath);
  const buf = fs.readFileSync(abs);

  // Find header/body delimiter.
  let idx = buf.indexOf(Buffer.from('\r\n\r\n'));
  let delimLen = 4;
  if (idx === -1) {
    idx = buf.indexOf(Buffer.from('\n\n'));
    delimLen = 2;
  }
  if (idx === -1) {
    throw new Error('Invalid HTTP fixture: missing header delimiter');
  }

  const headerText = buf.subarray(0, idx).toString('utf-8');
  const body = buf.subarray(idx + delimLen);
  const headerLines = headerText.split(/\r?\n/);
  const statusLine = headerLines.shift() ?? '';
  const m = statusLine.match(/HTTP\/\d\.\d\s+(\d{3})/i) ?? statusLine.match(/^(\d{3})\b/);
  const statusCode = m ? parseInt(m[1], 10) : 200;

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (!key) continue;
    headers[key.toLowerCase()] = val;
  }

  return { statusCode, headers, body };
}
