import * as http from 'node:http';
import * as net from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  deriveConnectAuthority,
  deriveDirectAuthority,
  derivePlainProxyAuthority,
} from './request-authority';

describe('request authority', () => {
  it('uses the absolute-form request target as plain proxy authority', () => {
    const authority = derivePlainProxyAuthority({
      requestTarget: 'http://api.example.test:8080/x?a=1',
      hostHeaders: ['api.example.test:8080'],
      listenerScheme: 'http',
    });

    expect(authority).toEqual({
      origin: {
        origin: 'http://api.example.test:8080',
        scheme: 'http',
        hostname: 'api.example.test',
        port: 8080,
        effectivePort: 8080,
      },
      rawAuthority: 'api.example.test:8080',
    });
  });

  it('accepts equivalent default ports during absolute-form Host agreement', () => {
    expect(derivePlainProxyAuthority({
      requestTarget: 'http://api.example.test/x',
      hostHeaders: ['API.EXAMPLE.TEST.:80'],
      listenerScheme: 'http',
    }).origin.origin).toBe('http://api.example.test');
  });

  it('uses Host for an origin-form plain proxy target', () => {
    expect(derivePlainProxyAuthority({
      requestTarget: '/x?ordered=2&ordered=1',
      hostHeaders: ['api.example.test:8080'],
      listenerScheme: 'http',
    })).toMatchObject({
      rawAuthority: 'api.example.test:8080',
      origin: { origin: 'http://api.example.test:8080' },
    });
  });

  it('rejects absolute-form and Host disagreement', () => {
    expect(() => derivePlainProxyAuthority({
      requestTarget: 'http://api.example.test/x',
      hostHeaders: ['other.example.test'],
      listenerScheme: 'http',
    })).toThrow(expect.objectContaining({ code: 'PROXY_HOST_AUTHORITY_MISMATCH' }));
  });

  it('rejects CONNECT and inner Host disagreement', () => {
    expect(() => deriveConnectAuthority({
      connectAuthority: 'api.example.test:443',
      innerHostHeaders: ['other.example.test'],
    })).toThrow(expect.objectContaining({ code: 'PROXY_CONNECT_AUTHORITY_MISMATCH' }));
  });

  it('accepts equivalent CONNECT and inner Host default ports', () => {
    expect(deriveConnectAuthority({
      connectAuthority: 'API.EXAMPLE.TEST.:443',
      innerHostHeaders: ['api.example.test'],
    })).toMatchObject({
      rawAuthority: 'API.EXAMPLE.TEST.:443',
      origin: { origin: 'https://api.example.test', effectivePort: 443 },
    });
  });

  it.each([
    ['duplicate Host', {
      requestTarget: '/x', hostHeaders: ['api.example.test', 'api.example.test'], listenerScheme: 'http' as const,
    }],
    ['missing origin-form Host', {
      requestTarget: '/x', hostHeaders: [], listenerScheme: 'http' as const,
    }],
    ['credential-bearing absolute target', {
      requestTarget: 'http://user:pass@api.example.test/x', hostHeaders: ['api.example.test'], listenerScheme: 'http' as const,
    }],
    ['malformed absolute target', {
      requestTarget: 'http://api.example.test:0/x', hostHeaders: ['api.example.test'], listenerScheme: 'http' as const,
    }],
    ['HTTPS absolute target on HTTP listener', {
      requestTarget: 'https://api.example.test/x', hostHeaders: ['api.example.test'], listenerScheme: 'http' as const,
    }],
  ])('maps malformed proxy authority for %s to PROXY_AUTHORITY_INVALID', (_name, input) => {
    expect(() => derivePlainProxyAuthority(input)).toThrow(expect.objectContaining({
      code: 'PROXY_AUTHORITY_INVALID',
    }));
  });

  it.each([
    ['duplicate inner Host', 'api.example.test:443', ['api.example.test', 'api.example.test']],
    ['credential-bearing CONNECT', 'user@api.example.test:443', []],
    ['malformed CONNECT port', 'api.example.test:0', []],
  ])('rejects malformed CONNECT authority for %s', (_name, connectAuthority, innerHostHeaders) => {
    expect(() => deriveConnectAuthority({ connectAuthority, innerHostHeaders })).toThrow(
      expect.objectContaining({ code: 'PROXY_AUTHORITY_INVALID' }),
    );
  });

  it('derives direct authority only from its listener and Host', () => {
    expect(deriveDirectAuthority({
      listenerScheme: 'https',
      hostHeaders: ['API.EXAMPLE.TEST.:443'],
    })).toMatchObject({
      rawAuthority: 'API.EXAMPLE.TEST.:443',
      origin: { origin: 'https://api.example.test' },
    });
  });

  it.each([
    ['missing Host', { listenerScheme: 'https' as const, hostHeaders: [] }],
    ['duplicate Host', {
      listenerScheme: 'http' as const, hostHeaders: ['api.example.test', 'api.example.test'],
    }],
    ['malformed Host', { listenerScheme: 'http' as const, hostHeaders: ['user@api.example.test'] }],
    ['reserved override', {
      listenerScheme: 'https' as const,
      hostHeaders: ['api.example.test'],
      reservedOriginHeaders: ['https://other.example.test'],
    }],
  ])('rejects invalid direct origin for %s', (_name, input) => {
    expect(() => deriveDirectAuthority(input)).toThrow(expect.objectContaining({
      code: 'DIRECT_ORIGIN_INVALID',
    }));
  });
});

describe('Node HTTP parser request envelope', () => {
  it('retains the exact raw target and ordered duplicate raw headers separately', async () => {
    let seen!: (value: { url: string; rawHeaders: string[] }) => void;
    const received = new Promise<{ url: string; rawHeaders: string[] }>(resolve => { seen = resolve; });
    const server = http.createServer((request, response) => {
      seen({ url: request.url!, rawHeaders: [...request.rawHeaders] });
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP parser test server did not bind');
    const socket = net.createConnection({ host: '127.0.0.1', port: address.port });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.end([
        'GET /raw/%2f?q=%2B&z=last&q=first HTTP/1.1',
        'Host: api.example.test',
        'X-Duplicate: first',
        'x-duplicate: second',
        'Connection: close',
        '',
        '',
      ].join('\r\n'));

      await expect(received).resolves.toEqual({
        url: '/raw/%2f?q=%2B&z=last&q=first',
        rawHeaders: [
          'Host', 'api.example.test',
          'X-Duplicate', 'first',
          'x-duplicate', 'second',
          'Connection', 'close',
        ],
      });
    } finally {
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
