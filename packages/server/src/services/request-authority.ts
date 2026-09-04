import { normalizeAuthority, type NormalizedOrigin } from '../domain/http-origin';
import { HttpError } from './api-errors';

export interface RequestAuthority {
  origin: NormalizedOrigin;
  rawAuthority: string;
}

function invalidProxyAuthority(): HttpError {
  return new HttpError(400, 'PROXY_AUTHORITY_INVALID', 'Proxy request authority is invalid');
}

function normalizedProxyAuthority(
  scheme: 'http' | 'https',
  rawAuthority: string,
): RequestAuthority {
  try {
    return { origin: normalizeAuthority(scheme, rawAuthority), rawAuthority };
  } catch {
    throw invalidProxyAuthority();
  }
}

function singleProxyHost(hostHeaders: readonly string[]): RequestAuthority | undefined {
  if (hostHeaders.length > 1) throw invalidProxyAuthority();
  return hostHeaders[0] === undefined
    ? undefined
    : normalizedProxyAuthority('http', hostHeaders[0]);
}

export function deriveConnectAuthority(input: {
  connectAuthority: string;
  innerHostHeaders: readonly string[];
}): RequestAuthority {
  const authority = normalizedProxyAuthority('https', input.connectAuthority);
  if (input.innerHostHeaders.length > 1) throw invalidProxyAuthority();
  if (input.innerHostHeaders[0] !== undefined) {
    const inner = normalizedProxyAuthority('https', input.innerHostHeaders[0]);
    if (inner.origin.origin !== authority.origin.origin) {
      throw new HttpError(
        400,
        'PROXY_CONNECT_AUTHORITY_MISMATCH',
        'CONNECT authority does not match the tunneled Host authority',
      );
    }
  }
  return authority;
}

export function derivePlainProxyAuthority(input: {
  requestTarget: string;
  hostHeaders: readonly string[];
  listenerScheme: 'http';
}): RequestAuthority {
  const absolute = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(input.requestTarget);
  if (absolute) {
    if (absolute[1].toLowerCase() !== input.listenerScheme || input.requestTarget.includes('#')) {
      throw invalidProxyAuthority();
    }
    const authority = normalizedProxyAuthority(input.listenerScheme, absolute[2]);
    const host = singleProxyHost(input.hostHeaders);
    if (host !== undefined && host.origin.origin !== authority.origin.origin) {
      throw new HttpError(
        400,
        'PROXY_HOST_AUTHORITY_MISMATCH',
        'Absolute request target authority does not match the Host authority',
      );
    }
    return authority;
  }

  if (!(input.requestTarget.startsWith('/') || input.requestTarget === '*')) {
    throw invalidProxyAuthority();
  }
  const host = singleProxyHost(input.hostHeaders);
  if (host === undefined) throw invalidProxyAuthority();
  return host;
}

export function deriveDirectAuthority(input: {
  listenerScheme: 'http' | 'https';
  hostHeaders: readonly string[];
  reservedOriginHeaders?: readonly string[];
}): RequestAuthority {
  if (input.hostHeaders.length !== 1 || (input.reservedOriginHeaders?.length ?? 0) > 0) {
    throw new HttpError(400, 'DIRECT_ORIGIN_INVALID', 'Direct request origin is invalid');
  }
  try {
    const rawAuthority = input.hostHeaders[0];
    return {
      origin: normalizeAuthority(input.listenerScheme, rawAuthority),
      rawAuthority,
    };
  } catch {
    throw new HttpError(400, 'DIRECT_ORIGIN_INVALID', 'Direct request origin is invalid');
  }
}
