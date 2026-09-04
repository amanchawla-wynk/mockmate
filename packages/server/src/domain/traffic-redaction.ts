import type { QueryEntry } from './query-matcher';

const redacted = '[REDACTED]';
const sensitiveHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

export function isSensitiveHeaderName(name: string): boolean {
  return sensitiveHeaders.has(name.toLowerCase());
}

export function redactTrafficHeaders(
  headers: readonly (readonly [string, string])[],
): Array<[string, string]> {
  return headers.map(([name, value]) => {
    const normalizedName = name.toLowerCase();
    return [normalizedName, isSensitiveHeaderName(normalizedName) ? redacted : value];
  });
}

export function isSensitiveQueryName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join('');
  return compact.includes('password')
    || compact.includes('passwd')
    || compact.includes('token')
    || compact.includes('secret')
    || compact.includes('credential')
    || compact.includes('session')
    || compact.includes('auth')
    || ['apikey', 'accesskey', 'privatekey'].includes(compact)
    || words.some(word => word === 'pwd' || word === 'key');
}

export function redactTrafficQuery(entries: readonly QueryEntry[]): QueryEntry[] {
  return entries.map(entry => ({
    name: entry.name,
    value: isSensitiveQueryName(entry.name) ? redacted : entry.value,
  }));
}
