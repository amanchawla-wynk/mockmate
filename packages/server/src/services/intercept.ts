/**
 * Host interception helpers for MockMate proxy.
 *
 * The proxy only MITMs/intercepts requests to an allowlist of hosts.
 * This is both safer (don't break unrelated traffic) and closer to how
 * teams typically use Charles/Proxyman with a host allowlist.
 */

import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import type { ProjectRuntimeSettings } from '../domain/model';
import { getLocalIPAddresses } from './network';

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a hostname against a simple pattern.
 * Supported:
 *  - exact: api.airtel.tv
 *  - wildcard: *.wynk.in, api.*.com, * (match all)
 */
export function hostMatchesPattern(pattern: string, hostname: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = normalizeHostnameForMatch(hostname);
  if (h === undefined) return false;
  if (!p) return false;
  if (p === '*') return true;

  // Fast path for exact match
  if (!p.includes('*')) {
    return p === h;
  }

  // Convert wildcard to regex.
  const re = new RegExp(`^${escapeRegexLiteral(p).replace(/\\\*/g, '.*')}$`);
  return re.test(h);
}

function normalizeIpLiteral(input: string): string | undefined {
  const version = isIP(input);
  if (version === 4) return input;
  if (version === 6) return new URL(`http://[${input}]`).hostname.slice(1, -1);
  return undefined;
}

function normalizeHostnameForMatch(input: string): string | undefined {
  const trimmed = input.trim();
  const withoutRootDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!withoutRootDot || withoutRootDot.endsWith('.')) return undefined;
  const ip = normalizeIpLiteral(withoutRootDot);
  if (ip !== undefined) return ip;
  for (const label of withoutRootDot.split('.')) {
    if (!label) return undefined;
    for (const character of label) {
      if (character.charCodeAt(0) < 128 && !/[a-z0-9-]/i.test(character)) return undefined;
    }
  }
  const hostname = domainToASCII(withoutRootDot).toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label => (
    !label
    || label.length > 63
    || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith('-')
    || label.endsWith('-')
  ))) return undefined;
  return hostname;
}

function normalizePatternLabel(source: string): string {
  if (!source || source.length > 63 || source.startsWith('-') || source.endsWith('-')) {
    throw new Error('Invalid interception pattern label');
  }
  if (source.includes('*')) {
    if (!/^[a-z0-9*-]+$/i.test(source)) throw new Error('Invalid interception wildcard label');
    return source.toLowerCase();
  }
  for (const character of source) {
    if (character.charCodeAt(0) < 128 && !/[a-z0-9-]/i.test(character)) {
      throw new Error('Invalid interception pattern label');
    }
  }
  const label = domainToASCII(source).toLowerCase();
  if (!label || label.length > 63 || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith('-') || label.endsWith('-')) {
    throw new Error('Invalid interception pattern label');
  }
  return label;
}

export function normalizeInterceptionPattern(
  input: string,
  localHosts: ReadonlySet<string>,
): string {
  const trimmed = input.trim();
  const withoutRootDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!withoutRootDot || withoutRootDot.endsWith('.')) throw new Error('Invalid interception pattern');

  let pattern: string;
  const ip = normalizeIpLiteral(withoutRootDot);
  if (ip !== undefined) {
    pattern = ip;
  } else {
    const labels = withoutRootDot.split('.').map(normalizePatternLabel);
    pattern = labels.join('.');
    if (pattern.length > 253) throw new Error('Invalid interception pattern');
  }

  if (pattern !== '*') {
    for (const localHost of localHosts) {
      const normalizedLocalHost = normalizeHostnameForMatch(localHost);
      if (normalizedLocalHost !== undefined && hostMatchesPattern(pattern, normalizedLocalHost)) {
        throw new Error('Interception pattern targets a local-control host');
      }
    }
  }
  return pattern;
}

export function normalizeInterceptionPatterns(
  inputs: readonly string[],
  localHosts: ReadonlySet<string>,
): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const pattern = normalizeInterceptionPattern(input, localHosts);
    if (seen.has(pattern)) throw new Error('Duplicate normalized interception pattern');
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

export function getLocalControlHosts(): Set<string> {
  return new Set(['localhost', '127.0.0.1', '::1', ...getLocalIPAddresses()]);
}

export function getInterceptHostPatterns(settings: ProjectRuntimeSettings): string[] {
  return normalizeInterceptionPatterns(settings.interceptHosts, getLocalControlHosts());
}

export function isHostIntercepted(settings: ProjectRuntimeSettings, hostname: string): boolean {
  const h = normalizeHostnameForMatch(hostname ?? '');
  if (h === undefined) return false;

  // Never intercept traffic to the MockMate host itself.
  // This avoids confusing behavior when a device is configured to proxy ALL traffic
  // and then tries to load the dashboard or admin APIs through the proxy.
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    return false;
  }
  const localHosts = getLocalControlHosts();
  if (localHosts.has(h)) {
    return false;
  }

  const patterns = getInterceptHostPatterns(settings);
  return patterns.some(p => hostMatchesPattern(p, h));
}
