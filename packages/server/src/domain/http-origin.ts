import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export interface NormalizedOrigin {
  origin: string;
  scheme: 'http' | 'https';
  hostname: string;
  port?: number;
  effectivePort: number;
}

function normalizeHostname(source: string): string {
  if (!source || source.trim() !== source) throw new Error('Invalid origin hostname');

  const withoutRootDot = source.endsWith('.') ? source.slice(0, -1) : source;
  if (!withoutRootDot || withoutRootDot.endsWith('.')) throw new Error('Invalid origin hostname');

  if (isIP(withoutRootDot) === 6) {
    return new URL(`http://[${withoutRootDot}]`).hostname.slice(1, -1);
  }

  for (const label of withoutRootDot.split('.')) {
    for (const character of label) {
      if (character.charCodeAt(0) < 128 && !/[a-z0-9-]/i.test(character)) {
        throw new Error('Invalid origin hostname');
      }
    }
  }

  const hostname = domainToASCII(withoutRootDot).toLowerCase();
  if (!hostname || hostname.length > 253) throw new Error('Invalid origin hostname');
  const labels = hostname.split('.');
  if (labels.some(label => (
    !label
    || label.length > 63
    || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith('-')
    || label.endsWith('-')
  ))) {
    throw new Error('Invalid origin hostname');
  }
  return hostname;
}

function parsePort(source: string | undefined): number | undefined {
  if (source === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(source)) throw new Error('Invalid origin port');
  const port = Number(source);
  if (port > 65_535) throw new Error('Invalid origin port');
  return port;
}

export function normalizeAuthority(
  scheme: 'http' | 'https',
  authority: string,
): NormalizedOrigin {
  if (!authority || authority.trim() !== authority || authority.includes('@')) {
    throw new Error('Invalid origin authority');
  }

  let hostnameSource: string;
  let portSource: string | undefined;
  let ipv6 = false;
  if (authority.startsWith('[')) {
    const closeBracket = authority.indexOf(']');
    if (closeBracket < 0) throw new Error('Invalid origin authority');
    hostnameSource = authority.slice(1, closeBracket);
    const remainder = authority.slice(closeBracket + 1);
    if (remainder && !remainder.startsWith(':')) throw new Error('Invalid origin authority');
    portSource = remainder ? remainder.slice(1) : undefined;
    ipv6 = isIP(hostnameSource) === 6;
    if (!ipv6) throw new Error('Invalid origin hostname');
  } else {
    const firstColon = authority.indexOf(':');
    const lastColon = authority.lastIndexOf(':');
    if (firstColon !== lastColon) throw new Error('IPv6 origin authorities must use brackets');
    hostnameSource = firstColon < 0 ? authority : authority.slice(0, firstColon);
    portSource = firstColon < 0 ? undefined : authority.slice(firstColon + 1);
  }

  const hostname = normalizeHostname(hostnameSource);
  const parsedPort = parsePort(portSource);
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = parsedPort === defaultPort ? undefined : parsedPort;
  const hostForOrigin = ipv6 ? `[${hostname}]` : hostname;

  return {
    origin: `${scheme}://${hostForOrigin}${port === undefined ? '' : `:${port}`}`,
    scheme,
    hostname,
    ...(port === undefined ? {} : { port }),
    effectivePort: port ?? defaultPort,
  };
}

export function normalizeOriginParts(
  scheme: 'http' | 'https',
  hostname: string,
  port?: number,
): NormalizedOrigin {
  const hostForAuthority = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return normalizeAuthority(
    scheme,
    `${hostForAuthority}${port === undefined ? '' : `:${port}`}`,
  );
}

export function normalizeHttpOrigin(input: string): NormalizedOrigin {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(input);
  if (!match || (match[1].toLowerCase() !== 'http' && match[1].toLowerCase() !== 'https')) {
    throw new Error('Origin must use HTTP or HTTPS');
  }

  const scheme = match[1].toLowerCase() as 'http' | 'https';
  const remainder = match[2];
  if (remainder.includes('?') || remainder.includes('#')) throw new Error('Origin cannot include search or hash');
  const slash = remainder.indexOf('/');
  if (slash >= 0 && remainder.slice(slash) !== '/') throw new Error('Origin cannot include a path');
  const authority = slash < 0 ? remainder : remainder.slice(0, slash);
  return normalizeAuthority(scheme, authority);
}
