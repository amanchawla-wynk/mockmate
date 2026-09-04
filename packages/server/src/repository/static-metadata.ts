import { createHash } from 'node:crypto';

import type { StaticFileSummary } from '../domain/model';
import { isStablePathSegment } from '../services/storage';

export const STATIC_METADATA_FILE = '.mockmate-static.json';
export const STATIC_TRANSACTION_POINTER = '.mockmate-static-transaction.json';
export const STATIC_TRANSACTION_DIRECTORY = '.mockmate-static-transactions';
export const STATIC_TRANSACTION_JOURNAL = 'transaction.json';

export interface StaticTransactionJournal {
  transactionId: string;
  operation: 'put' | 'delete';
  path: string;
  before: Map<string, StaticFileSummary>;
  after: Map<string, StaticFileSummary>;
}

export interface StaticTransactionPointer {
  transactionId: string;
  operation: 'put' | 'delete';
  path: string;
  journalSha256: string;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export function isNormalizedStaticPath(value: string): boolean {
  if (value.length === 0
    || value === STATIC_METADATA_FILE
    || value === STATIC_TRANSACTION_POINTER
    || value === STATIC_TRANSACTION_DIRECTORY
    || value.startsWith(`${STATIC_TRANSACTION_DIRECTORY}/`)
    || value.includes('\\')
    || value.includes('\0')) {
    return false;
  }
  const segments = value.split('/');
  return !value.startsWith('/')
    && !/^[A-Za-z]:\//.test(value)
    && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function parseStaticMetadata(input: unknown): Map<string, StaticFileSummary> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const manifest = input as Record<string, unknown>;
  if (!hasExactKeys(manifest, ['schemaVersion', 'files'])
    || manifest.schemaVersion !== 4
    || !Array.isArray(manifest.files)) return undefined;

  const files = new Map<string, StaticFileSummary>();
  let previousPath: string | undefined;
  for (const inputFile of manifest.files) {
    if (typeof inputFile !== 'object' || inputFile === null || Array.isArray(inputFile)) return undefined;
    const file = inputFile as Record<string, unknown>;
    if (!hasExactKeys(file, ['path', 'size', 'mediaType'])
      || typeof file.path !== 'string'
      || !isNormalizedStaticPath(file.path)
      || !Number.isSafeInteger(file.size)
      || (file.size as number) < 0
      || typeof file.mediaType !== 'string'
      || file.mediaType.length === 0
      || (previousPath !== undefined && previousPath.localeCompare(file.path) >= 0)) return undefined;
    const summary: StaticFileSummary = {
      path: file.path,
      size: file.size as number,
      mediaType: file.mediaType,
    };
    files.set(summary.path, summary);
    previousPath = summary.path;
  }
  return files;
}

export function serializeStaticMetadata(files: ReadonlyMap<string, StaticFileSummary>): unknown {
  return {
    schemaVersion: 4,
    files: [...files.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(file => ({ path: file.path, size: file.size, mediaType: file.mediaType })),
  };
}

function sameEntry(left: StaticFileSummary | undefined, right: StaticFileSummary | undefined): boolean {
  return left?.path === right?.path
    && left?.size === right?.size
    && left?.mediaType === right?.mediaType;
}

function isValidTransition(journal: StaticTransactionJournal): boolean {
  const paths = new Set([...journal.before.keys(), ...journal.after.keys()]);
  for (const filePath of paths) {
    if (filePath !== journal.path && !sameEntry(journal.before.get(filePath), journal.after.get(filePath))) {
      return false;
    }
  }
  return journal.operation === 'put'
    ? journal.after.has(journal.path)
    : journal.before.has(journal.path) && !journal.after.has(journal.path);
}

export function parseStaticTransaction(input: unknown): StaticTransactionJournal | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!hasExactKeys(record, ['schemaVersion', 'transactionId', 'operation', 'path', 'before', 'after'])
    || record.schemaVersion !== 4
    || typeof record.transactionId !== 'string'
    || !isStablePathSegment(record.transactionId)
    || (record.operation !== 'put' && record.operation !== 'delete')
    || typeof record.path !== 'string'
    || !isNormalizedStaticPath(record.path)) return undefined;
  const before = parseStaticMetadata(record.before);
  const after = parseStaticMetadata(record.after);
  if (!before || !after) return undefined;
  const journal: StaticTransactionJournal = {
    transactionId: record.transactionId,
    operation: record.operation,
    path: record.path,
    before,
    after,
  };
  return isValidTransition(journal) ? journal : undefined;
}

export function serializeStaticTransaction(journal: StaticTransactionJournal): unknown {
  return {
    schemaVersion: 4,
    transactionId: journal.transactionId,
    operation: journal.operation,
    path: journal.path,
    before: serializeStaticMetadata(journal.before),
    after: serializeStaticMetadata(journal.after),
  };
}

export function staticTransactionDigest(journal: StaticTransactionJournal): string {
  return createHash('sha256')
    .update(JSON.stringify(serializeStaticTransaction(journal)))
    .digest('hex');
}

export function parseStaticTransactionPointer(input: unknown): StaticTransactionPointer | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!hasExactKeys(record, ['schemaVersion', 'transactionId', 'operation', 'path', 'journalSha256'])
    || record.schemaVersion !== 4
    || typeof record.transactionId !== 'string'
    || !isStablePathSegment(record.transactionId)
    || (record.operation !== 'put' && record.operation !== 'delete')
    || typeof record.path !== 'string'
    || !isNormalizedStaticPath(record.path)
    || typeof record.journalSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.journalSha256)) return undefined;
  return {
    transactionId: record.transactionId,
    operation: record.operation,
    path: record.path,
    journalSha256: record.journalSha256,
  };
}

export function serializeStaticTransactionPointer(pointer: StaticTransactionPointer): unknown {
  return {
    schemaVersion: 4,
    transactionId: pointer.transactionId,
    operation: pointer.operation,
    path: pointer.path,
    journalSha256: pointer.journalSha256,
  };
}
