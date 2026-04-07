/**
 * Request logging service
 * Maintains in-memory log of requests for real-time monitoring
 */

import type { RequestLogEntry, HttpMethod } from '../types';
import { generateId } from '../utils/slugify';

/**
 * Maximum number of log entries to keep in memory
 */
const MAX_LOG_ENTRIES = (() => {
  const raw = process.env.MOCKMATE_LOG_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return 500;
})();

/**
 * In-memory log storage
 */
let logEntries: RequestLogEntry[] = [];

/**
 * Add a new log entry
 * Automatically removes oldest entries if limit exceeded
 */
export function addLogEntry(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
  const logEntry: RequestLogEntry = {
    id: generateId('log'),
    ...entry,
  };

  // Add to the beginning of the array (newest first)
  logEntries.unshift(logEntry);

  // Trim to max size
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries = logEntries.slice(0, MAX_LOG_ENTRIES);
  }

  return logEntry;
}

/**
 * Get all log entries (newest first)
 */
export function getLogEntries(): RequestLogEntry[] {
  return [...logEntries];
}

/**
 * Clear all log entries
 */
export function clearLogEntries(): void {
  logEntries = [];
}

/**
 * Get the most recent N log entries
 */
export function getRecentLogEntries(count: number): RequestLogEntry[] {
  return logEntries.slice(0, count);
}

/**
 * Log a successful request
 */
export function logRequest(
  method: HttpMethod,
  path: string,
  statusCode: number,
  duration: number,
  resourceId?: string,
  scenario?: string,
  scenarioFromHeader?: boolean,
  proxied?: boolean,
  details?: {
    scenarioSource?: RequestLogEntry['scenarioSource'];
    proxiedReason?: RequestLogEntry['proxiedReason'];
    responseFixture?: RequestLogEntry['responseFixture'];
    host?: string;
    requestHeaders?: Record<string, string>;
    requestQuery?: Record<string, string>;
    requestBody?: any;

    responseHeaders?: Record<string, string>;
    responseBody?: any;
    responseBodyTruncated?: boolean;
    responseSize?: number;
  }
): RequestLogEntry {
  return addLogEntry({
    timestamp: new Date().toISOString(),
    method,
    path,
    statusCode,
    duration,
    resourceId,
    scenario,
    scenarioFromHeader,
    proxied,
    ...(details ?? {}),
  });
}
