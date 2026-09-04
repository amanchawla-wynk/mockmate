import type { ResponseHeaders } from '../domain/model';
import type { ResolvedMock } from '../repository/compile-project';

export interface DebugHeaderOptions {
  enabled: boolean;
  passthrough?: boolean;
  projectId?: string;
  requestId?: string;
}

const safeIdentifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const reservedDebugHeaders = new Set([
  'x-mockmate-project',
  'x-mockmate-endpoint',
  'x-mockmate-variant',
  'x-mockmate-state',
  'x-mockmate-resolution-source',
  'x-mockmate-fallback-reason',
  'x-mockmate-request-id',
]);

export function withoutReservedDebugHeaders(headers: ResponseHeaders): ResponseHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => (
    !reservedDebugHeaders.has(name.toLowerCase())
  )));
}

export function debugHeaders(
  resolved: ResolvedMock | undefined,
  options: DebugHeaderOptions,
): Record<string, string> {
  if (!options.enabled || options.passthrough || resolved === undefined) return {};
  const required = [
    resolved.endpointId,
    resolved.variantId,
    resolved.resolutionSource,
    ...(options.projectId === undefined ? [] : [options.projectId]),
    ...(options.requestId === undefined ? [] : [options.requestId]),
    ...resolved.fallbackReasons,
  ];
  if (required.some(value => !safeIdentifier(value))
    || (resolved.selectedStateId !== undefined && !safeIdentifier(resolved.selectedStateId))) return {};

  return {
    ...(options.projectId === undefined ? {} : { 'X-MockMate-Project': options.projectId }),
    'X-MockMate-Endpoint': resolved.endpointId,
    'X-MockMate-Variant': resolved.variantId,
    ...(resolved.selectedStateId === undefined ? {} : { 'X-MockMate-State': resolved.selectedStateId }),
    'X-MockMate-Resolution-Source': resolved.resolutionSource,
    ...(resolved.fallbackReasons.length === 0
      ? {}
      : { 'X-MockMate-Fallback-Reason': resolved.fallbackReasons.join(', ') }),
    ...(options.requestId === undefined ? {} : { 'X-MockMate-Request-Id': options.requestId }),
  };
}
