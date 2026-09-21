import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  ContentEncodingBudgetError,
  decodeEntityStream,
} from '../domain/content-encoding-decode';
import type { TrafficSummary } from '../domain/traffic';
import { HttpError } from './api-errors';
import { scanJsonForQuery, type JsonScanMatch } from './traffic-json-scan';
import type { TrafficService } from './traffic-service';

export interface TrafficJsonSearchResult {
  traffic: TrafficSummary;
  side: 'request' | 'response';
  matchCount: number;
  matches: JsonScanMatch[];
}

export interface TrafficJsonSearchSkipped {
  unavailable: number;
  truncated: number;
  evicted: number;
  unsupportedEncoding: number;
  invalidUtf8: number;
  notJson: number;
  changedDuringSearch: number;
  searchBudgetExceeded: number;
}

export interface TrafficJsonSearchPage {
  searchSessionId: string;
  query: string;
  results: TrafficJsonSearchResult[];
  nextCursor?: string;
  skipped: TrafficJsonSearchSkipped;
}

export interface TrafficSearchInput {
  query: string;
  limit: number;
  cursor?: string;
}

export interface TrafficSearchService {
  search(
    projectId: string,
    input: TrafficSearchInput,
    signal?: AbortSignal,
  ): Promise<TrafficJsonSearchPage>;
  deleteSession(projectId: string, sessionId: string): void;
  clearProject(projectId: string): void;
  dispose(): void;
}

export interface TrafficSearchOptions {
  maxResultsPerPage?: number;
  sessionTtlMs?: number;
  maxSessionsPerProject?: number;
  maxSessionsProcess?: number;
  maxConcurrentScans?: number;
  maxDecodedBytes?: number;
  /** Aggregate decoded bytes one page may inspect before it stops scanning. */
  maxPageDecodedBytes?: number;
  snapshotLimit?: number;
  now?: () => number;
  id?: () => string;
}

interface Candidate {
  trafficId: string;
  generation: string;
  side: 'request' | 'response';
}

interface SearchSession {
  id: string;
  projectId: string;
  query: string;
  candidates: Candidate[];
  summaries: Map<string, TrafficSummary>;
  lastAccess: number;
}

const DEFAULTS = {
  maxResultsPerPage: 100,
  sessionTtlMs: 5 * 60_000,
  maxSessionsPerProject: 4,
  maxSessionsProcess: 16,
  maxConcurrentScans: 2,
  /** Per-body ceiling; a larger retained body stays readable through the body route. */
  maxDecodedBytes: 32 * 1024 * 1024,
  /** Per-page ceiling so one request cannot inflate every retained body at once. */
  maxPageDecodedBytes: 256 * 1024 * 1024,
  snapshotLimit: Number.MAX_SAFE_INTEGER,
} as const;

const CANDIDATE_SIDES = ['request', 'response'] as const;

function zeroSkipped(): TrafficJsonSearchSkipped {
  return {
    unavailable: 0,
    truncated: 0,
    evicted: 0,
    unsupportedEncoding: 0,
    invalidUtf8: 0,
    notJson: 0,
    changedDuringSearch: 0,
    searchBudgetExceeded: 0,
  };
}

function queryRequired(): HttpError {
  return new HttpError(400, 'TRAFFIC_SEARCH_QUERY_REQUIRED', 'Search query is required');
}

function cursorInvalid(): HttpError {
  return new HttpError(400, 'TRAFFIC_SEARCH_CURSOR_INVALID', 'Search cursor is invalid');
}

function sessionExpired(): HttpError {
  return new HttpError(410, 'TRAFFIC_SEARCH_EXPIRED', 'Search session has expired');
}

function searchBusy(): HttpError {
  return new HttpError(429, 'TRAFFIC_SEARCH_BUSY', 'Traffic search is busy; retry shortly');
}

function abortError(): Error {
  return Object.assign(new Error('Traffic search aborted'), { name: 'AbortError' });
}

function encodeCursor(sessionId: string, index: number): string {
  return Buffer.from(`${sessionId}\u0000${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { sessionId: string; index: number } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw cursorInvalid();
  }
  const separator = decoded.indexOf('\u0000');
  if (separator <= 0) throw cursorInvalid();
  const sessionId = decoded.slice(0, separator);
  const index = Number(decoded.slice(separator + 1));
  if (!Number.isInteger(index) || index < 0) throw cursorInvalid();
  return { sessionId, index };
}

function isBudgetError(error: unknown): boolean {
  return error instanceof ContentEncodingBudgetError;
}

export function createTrafficSearchService(input: {
  traffic: TrafficService;
  options?: TrafficSearchOptions;
}): TrafficSearchService {
  const options = { ...DEFAULTS, ...input.options };
  const now = input.options?.now ?? Date.now;
  const id = input.options?.id ?? randomUUID;
  const sessions = new Map<string, SearchSession>();
  let activeScans = 0;

  const purgeExpired = (): void => {
    const cutoff = now() - options.sessionTtlMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastAccess < cutoff) sessions.delete(sessionId);
    }
  };

  const evictOne = (predicate: (session: SearchSession) => boolean): boolean => {
    let oldest: SearchSession | undefined;
    for (const session of sessions.values()) {
      if (!predicate(session)) continue;
      if (oldest === undefined || session.lastAccess < oldest.lastAccess) oldest = session;
    }
    if (oldest === undefined) return false;
    sessions.delete(oldest.id);
    return true;
  };

  const createSession = (projectId: string, query: string): SearchSession => {
    const projectCount = [...sessions.values()].filter(s => s.projectId === projectId).length;
    if (projectCount >= options.maxSessionsPerProject
      && !evictOne(session => session.projectId === projectId)) {
      throw searchBusy();
    }
    if (sessions.size >= options.maxSessionsProcess && !evictOne(() => true)) {
      throw searchBusy();
    }

    const page = input.traffic.list(projectId, { limit: options.snapshotLimit });
    const ordered = [...page.entries].sort((left, right) =>
      right.completedAt.localeCompare(left.completedAt) || right.id.localeCompare(left.id));
    const summaries = new Map<string, TrafficSummary>();
    const candidates: Candidate[] = [];
    for (const summary of ordered) {
      summaries.set(summary.id, summary);
      for (const side of CANDIDATE_SIDES) {
        const state = side === 'request' ? summary.requestBodyState : summary.responseBodyState;
        if (state === 'available' || state === 'truncated' || state === 'evicted') {
          candidates.push({ trafficId: summary.id, generation: summary.generation, side });
        }
      }
    }
    const session: SearchSession = {
      id: id(),
      projectId,
      query,
      candidates,
      summaries,
      lastAccess: now(),
    };
    sessions.set(session.id, session);
    return session;
  };

  const processCandidate = async (
    projectId: string,
    candidate: Candidate,
    query: string,
    session: SearchSession,
    skipped: TrafficJsonSearchSkipped,
    budget: { remainingBytes: number },
  ): Promise<TrafficJsonSearchResult | undefined> => {
    const detail = input.traffic.get(projectId, candidate.trafficId);
    if (detail === undefined || detail.generation !== candidate.generation) {
      skipped.changedDuringSearch += 1;
      return undefined;
    }
    const descriptor = detail[candidate.side].body;
    if (descriptor.state !== 'available') {
      if (descriptor.state === 'truncated') skipped.truncated += 1;
      else if (descriptor.state === 'evicted') skipped.evicted += 1;
      else skipped.unavailable += 1;
      return undefined;
    }

    let opened: Awaited<ReturnType<TrafficService['openBody']>>;
    try {
      opened = await input.traffic.openBody(projectId, candidate.trafficId, candidate.side);
    } catch {
      // Concurrent eviction or clear removed the retained body after the snapshot.
      skipped.changedDuringSearch += 1;
      return undefined;
    }

    try {
      let decoded: { bytes: Buffer };
      try {
        decoded = await decodeEntityStream(
          opened.lease.openStream() as Readable,
          opened.descriptor.contentEncoding,
          Math.min(options.maxDecodedBytes, budget.remainingBytes),
        );
      } catch (error) {
        if (isBudgetError(error)) skipped.searchBudgetExceeded += 1;
        else skipped.unsupportedEncoding += 1;
        return undefined;
      }
      budget.remainingBytes -= decoded.bytes.byteLength;
      // A bodyless request (for example a GET) retains an empty available body.
      // That is ordinary, not evidence of a problem, so it is not reported.
      if (decoded.bytes.byteLength === 0) return undefined;

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(decoded.bytes);
      } catch {
        skipped.invalidUtf8 += 1;
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        skipped.notJson += 1;
        return undefined;
      }

      let scan: ReturnType<typeof scanJsonForQuery>;
      try {
        scan = scanJsonForQuery(parsed, query);
      } catch {
        // A pathological document must not fail the whole page.
        skipped.searchBudgetExceeded += 1;
        return undefined;
      }
      if (scan.matchCount === 0) return undefined;
      const summary = session.summaries.get(candidate.trafficId);
      if (summary === undefined) return undefined;
      return {
        traffic: summary,
        side: candidate.side,
        matchCount: scan.matchCount,
        matches: scan.matches,
      };
    } finally {
      await opened.lease.release().catch(() => undefined);
    }
  };

  return {
    async search(projectId, searchInput, signal) {
      const query = searchInput.query.trim();
      if (query.length === 0) throw queryRequired();
      const limit = Math.max(1, Math.min(options.maxResultsPerPage, Math.floor(searchInput.limit)));

      purgeExpired();
      if (activeScans >= options.maxConcurrentScans) throw searchBusy();

      let session: SearchSession;
      let startIndex: number;
      if (searchInput.cursor !== undefined) {
        const parsed = decodeCursor(searchInput.cursor);
        const existing = sessions.get(parsed.sessionId);
        if (existing === undefined || existing.projectId !== projectId) throw sessionExpired();
        if (existing.query !== query) throw cursorInvalid();
        session = existing;
        startIndex = parsed.index;
      } else {
        session = createSession(projectId, query);
        startIndex = 0;
      }
      session.lastAccess = now();

      activeScans += 1;
      try {
        const results: TrafficJsonSearchResult[] = [];
        const skipped = zeroSkipped();
        const budget = { remainingBytes: options.maxPageDecodedBytes };
        let index = startIndex;
        for (; index < session.candidates.length && results.length < limit; index += 1) {
          if (signal?.aborted) throw abortError();
          // Stop this page once its aggregate decode budget is spent; the cursor
          // lets the client continue deliberately.
          if (budget.remainingBytes <= 0) break;
          const result = await processCandidate(
            projectId,
            session.candidates[index]!,
            query,
            session,
            skipped,
            budget,
          );
          if (result !== undefined) results.push(result);
        }
        session.lastAccess = now();
        return {
          searchSessionId: session.id,
          query,
          results,
          ...(index < session.candidates.length ? { nextCursor: encodeCursor(session.id, index) } : {}),
          skipped,
        };
      } finally {
        activeScans -= 1;
      }
    },
    deleteSession(projectId, sessionId) {
      const session = sessions.get(sessionId);
      if (session !== undefined && session.projectId === projectId) sessions.delete(sessionId);
    },
    clearProject(projectId) {
      for (const [sessionId, session] of sessions) {
        if (session.projectId === projectId) sessions.delete(sessionId);
      }
    },
    dispose() {
      sessions.clear();
    },
  };
}
