/**
 * Host interception helpers for MockMate proxy.
 *
 * The proxy only MITMs/intercepts requests to an allowlist of hosts.
 * This is both safer (don't break unrelated traffic) and closer to how
 * teams typically use Charles/Proxyman with a host allowlist.
 */

import type { Project } from '../types';
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
  const h = hostname.trim().toLowerCase();
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

export function getInterceptHostPatterns(project: Project): string[] {
  const patterns = (project.interceptHosts ?? []).map(s => (s ?? '').trim()).filter(Boolean);
  if (patterns.length > 0) {
    return patterns;
  }

  // Backward compatibility: if interceptHosts isn't set, fall back to baseUrl hostname.
  if (project.baseUrl) {
    try {
      const host = new URL(project.baseUrl).hostname;
      if (host) return [host];
    } catch {
      // ignore
    }
  }

  return [];
}

export function isHostIntercepted(project: Project, hostname: string): boolean {
  const h = (hostname ?? '').trim().toLowerCase();

  // Never intercept traffic to the MockMate host itself.
  // This avoids confusing behavior when a device is configured to proxy ALL traffic
  // and then tries to load the dashboard or admin APIs through the proxy.
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    return false;
  }
  const localIPs = getLocalIPAddresses().map(ip => ip.toLowerCase());
  if (localIPs.includes(h)) {
    return false;
  }

  const patterns = getInterceptHostPatterns(project);
  return patterns.some(p => hostMatchesPattern(p, hostname));
}
