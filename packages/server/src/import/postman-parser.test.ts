import { describe, expect, it } from 'vitest';

import { HttpError } from '../services/api-errors';
import { parsePostmanSource } from './postman-parser';

const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function makeCollection(item: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { name: 'Import fixture', schema: POSTMAN_V21_SCHEMA },
    item,
    ...extra,
  };
}

function makeRequestItem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Request',
    request: { method: 'GET', url: 'https://api.example.test/items' },
    ...extra,
  };
}

function expectSourceError(collection: unknown, code: string): void {
  try {
    parsePostmanSource(collection);
    throw new Error('Expected parsePostmanSource to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 422, code });
  }
}

describe('parsePostmanSource', () => {
  it('uses enabled structured query metadata as exact canonical constraints and normalizes default ports', () => {
    const parsed = parsePostmanSource(makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: {
            raw: 'https://api.example.test:443/items?raw=discarded',
            query: [
              { key: 'a', value: '2' },
              { key: 'a', value: '1' },
              { key: 'a', value: '1' },
              { key: 'disabled', value: 'secret', disabled: true },
            ],
          },
        },
      }),
      makeRequestItem({
        request: {
          method: 'GET',
          url: 'http://api.example.test:80/plain?q=one',
        },
      }),
    ]));

    expect(parsed.members[0]).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://api.example.test',
        matcher: {
          method: 'GET',
          path: '/items',
          query: {
            a: [
              { operator: 'equals', value: '2' },
              { operator: 'equals', value: '1' },
              { operator: 'equals', value: '1' },
            ],
          },
        },
      },
      request: {
        query: [
          { name: 'a', value: '2' },
          { name: 'a', value: '1' },
          { name: 'a', value: '1' },
        ],
      },
      errors: [],
    });
    expect(parsed.members[1]).toMatchObject({
      canonicalRequest: {
        baseUrl: 'http://api.example.test',
        matcher: {
          query: { q: [{ operator: 'equals', value: 'one' }] },
        },
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/discarded|disabledSecret/);
  });

  it('reports malformed authored raw query encoding as an item error', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: 'https://api.example.test/items?token=%ZZ',
        },
      }),
    ])).members[0];

    expect(member?.canonicalRequest).toBeUndefined();
    expect(member?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'IMPORT_QUERY_INVALID' }),
    ]));
    expect(JSON.stringify(member)).not.toContain('%ZZ');
  });

  it('traverses v2.1 folders depth-first and resolves safe request previews', () => {
    const collection = makeCollection([
      {
        name: 'Accounts',
        event: [{ listen: 'prerequest', script: { exec: ['collection-secret'] } }],
        item: [
          {
            name: 'Get account',
            event: [{ listen: 'test', script: { exec: ['request-secret'] } }],
            request: {
              method: 'get',
              description: 'Returns one account',
              url: {
                raw: 'https://{{region}}.api.example.test:443/{{resource}}/:id?raw={{ignoredRaw}}',
                query: [
                  { key: 'page', value: '2' },
                  { key: 'disabled', value: '{{disabledQuery}}', disabled: true },
                ],
              },
              header: [
                { key: 'Authorization', value: 'Bearer collection-secret' },
                { key: 'X-Region', value: '{{region}}' },
                { key: 'X-Disabled', value: '{{disabledHeader}}', disabled: true },
              ],
              body: {
                mode: 'raw',
                raw: '{"password":"body-secret"}',
                options: { raw: { language: 'json' } },
              },
            },
          },
          {
            name: 'Nested',
            item: [
              {
                name: 'Tenant request',
                request: {
                  method: 'POST',
                  description: { content: 'Creates a tenant record', type: 'text/plain' },
                  auth: {
                    type: 'bearer',
                    bearer: [{ key: 'token', value: 'request-secret' }],
                  },
                  url: {
                    protocol: 'http',
                    host: ['{{tenant}}', 'example', 'test'],
                    port: '80',
                    path: ['records', ':id'],
                    query: [{ key: 'enabled', value: 'true' }],
                  },
                },
              },
            ],
          },
        ],
      },
    ], {
      variable: [{ key: 'resource', value: 'accounts' }],
      auth: {
        type: 'basic',
        basic: [
          { key: 'username', value: 'reader' },
          { key: 'password', value: 'collection-secret' },
        ],
      },
      event: [{ listen: 'test', script: { exec: ['root-secret'] } }],
    });

    const parsed = parsePostmanSource(collection, { region: 'eu' });

    expect(parsed.members.map(member => member.location)).toEqual([
      { type: 'postman', itemPath: [0, 0] },
      { type: 'postman', itemPath: [0, 1, 0] },
    ]);
    expect(parsed.members[0]).toMatchObject({
      name: 'Get account',
      description: 'Returns one account',
      breadcrumb: ['Accounts'],
      canonicalRequest: {
        baseUrl: 'https://eu.api.example.test',
        matcher: {
          method: 'GET',
          path: '/accounts/*',
          query: { page: [{ operator: 'equals', value: '2' }] },
        },
      },
      unresolvedVariables: [],
      request: {
        scheme: 'https',
        hostname: 'eu.api.example.test',
        port: '443',
        query: [{ name: 'page', value: '2' }],
        headers: [
          { name: 'Authorization', value: '[REDACTED]' },
          { name: 'X-Region', value: 'eu' },
        ],
        auth: {
          type: 'basic',
          fields: [
            { name: 'username', value: '[REDACTED]' },
            { name: 'password', value: '[REDACTED]' },
          ],
        },
        body: {
          mediaType: 'application/json',
          byteCount: Buffer.byteLength('{"password":"body-secret"}'),
          omitted: true,
        },
      },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'IMPORT_SCRIPT_IGNORED' }),
      ]),
    });
    expect(parsed.members[1]).toMatchObject({
      description: 'Creates a tenant record',
      breadcrumb: ['Accounts', 'Nested'],
      canonicalRequest: undefined,
      unresolvedVariables: ['tenant'],
      request: {
        auth: {
          type: 'bearer',
          fields: [{ name: 'token', value: '[REDACTED]' }],
        },
      },
    });
    expect(parsed.warnings.map(warning => warning.code)).toEqual([
      'IMPORT_SCRIPT_IGNORED',
      'IMPORT_SCRIPT_IGNORED',
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(
      /collection-secret|request-secret|body-secret|root-secret|disabledQuery|disabledHeader|ignoredRaw/,
    );
  });

  it('applies collection variables before supplied values and keeps unresolved segments required', () => {
    const collection = makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: 'https://{{host}}/{{segment}}',
        },
      }),
    ], {
      variable: [{ key: 'host', value: 'collection.example.test' }],
    });

    const resolved = parsePostmanSource(collection, {
      host: 'supplied.example.test',
      segment: 'users',
    }).members[0];
    expect(resolved).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://collection.example.test',
        matcher: { method: 'GET', path: '/users' },
      },
      unresolvedVariables: [],
    });

    const unresolved = parsePostmanSource(collection, {
      host: 'supplied.example.test',
    }).members[0];
    expect(unresolved?.canonicalRequest).toBeUndefined();
    expect(unresolved?.unresolvedVariables).toEqual(['segment']);
  });

  it('uses structured query metadata instead of raw query and preserves structured default ports', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: {
            raw: 'http://api.example.test:80/items?secret={{rawSecret}}',
            protocol: 'http',
            host: ['ignored', 'example', 'test'],
            port: '9999',
            path: ['ignored'],
            query: [
              { key: 'filter', value: '{{filter}}' },
              { key: 'disabled', value: '{{disabledSecret}}', disabled: true },
            ],
          },
        },
      }),
      makeRequestItem({
        name: 'Structured',
        request: {
          method: 'GET',
          url: {
            protocol: 'https',
            host: ['structured', 'example', 'test'],
            port: '443',
            path: ['v1', ':resourceId'],
          },
        },
      }),
    ]), { filter: 'active' });

    expect(member.members[0]).toMatchObject({
      canonicalRequest: {
        baseUrl: 'http://api.example.test',
        matcher: {
          method: 'GET',
          path: '/items',
          query: { filter: [{ operator: 'equals', value: 'active' }] },
        },
      },
      unresolvedVariables: [],
      request: {
        port: '80',
        query: [{ name: 'filter', value: 'active' }],
      },
    });
    expect(member.members[1]).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://structured.example.test',
        matcher: { method: 'GET', path: '/v1/*' },
      },
      request: { scheme: 'https', port: '443' },
    });
    expect(JSON.stringify(member)).not.toMatch(/rawSecret|disabledSecret/);
  });

  it('preserves and interpolates raw fragments while replacing structured query metadata', () => {
    const collection = makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: {
            raw: 'https://api.example.test/items?discard={{rawQuery}}#section-{{section}}',
            query: [{ key: 'page', value: '2' }],
          },
        },
      }),
    ]);

    const unresolved = parsePostmanSource(collection).members[0];
    expect(unresolved).toMatchObject({
      canonicalRequest: undefined,
      unresolvedVariables: ['section'],
      request: { query: [{ name: 'page', value: '2' }] },
    });
    expect(JSON.stringify(unresolved)).not.toContain('rawQuery');

    const resolved = parsePostmanSource(collection, { section: 'details' }).members[0];
    expect(resolved).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://api.example.test',
        matcher: {
          method: 'GET',
          path: '/items',
          query: { page: [{ operator: 'equals', value: '2' }] },
        },
      },
      unresolvedVariables: [],
    });
  });

  it('uses raw query only when structured query metadata is absent', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: 'https://api.example.test/items?page={{page}}&token=secret-token',
        },
      }),
    ]), { page: '3' }).members[0];

    expect(member?.request.query).toEqual([
      { name: 'page', value: '3' },
      { name: 'token', value: '[REDACTED]' },
    ]);
    expect(JSON.stringify(member?.request)).not.toContain('secret-token');
  });

  it('previews and redacts raw query fields when host or path variables are unresolved', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({
        request: {
          method: 'GET',
          url: {
            raw: 'https://{{tenant}}.example.test/items/{{recordId}}?page=2&apiKey=raw-secret#details',
          },
        },
      }),
    ])).members[0];

    expect(member).toMatchObject({
      canonicalRequest: undefined,
      unresolvedVariables: ['tenant', 'recordId'],
      request: {
        query: [
          { name: 'page', value: '2' },
          { name: 'apiKey', value: '[REDACTED]' },
        ],
      },
    });
    expect(JSON.stringify(member)).not.toContain('raw-secret');
  });

  it('preserves unsupported normalized methods while marking the member invalid', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({ request: { method: ' options ', url: 'https://api.example.test/items' } }),
    ])).members[0];

    expect(member).toMatchObject({
      supportedMethod: false,
      canonicalRequest: {
        baseUrl: 'https://api.example.test',
        matcher: { method: 'OPTIONS', path: '/items' },
      },
      errors: [expect.objectContaining({ code: 'IMPORT_METHOD_UNSUPPORTED' })],
    });
  });

  it('marks disabled request items without adding a parser error', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({ disabled: true }),
    ])).members[0];

    expect(member).toMatchObject({ disabled: true, errors: [] });
  });

  it('inherits the nearest auth override and preserves field order before redaction', () => {
    const parsed = parsePostmanSource(makeCollection([
      {
        name: 'Folder',
        auth: {
          type: 'bearer',
          bearer: [{ key: 'token', value: 'folder-secret' }],
        },
        item: [
          makeRequestItem({
            auth: {
              type: 'apikey',
              apikey: [
                { key: 'value', value: 'item-secret' },
                { key: 'key', value: 'X-Key' },
              ],
            },
          }),
        ],
      },
    ], {
      auth: {
        type: 'basic',
        basic: [{ key: 'password', value: 'collection-secret' }],
      },
    }));

    expect(parsed.members[0]?.request.auth).toEqual({
      type: 'apikey',
      fields: [
        { name: 'value', value: '[REDACTED]' },
        { name: 'key', value: '[REDACTED]' },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/collection-secret|folder-secret|item-secret/);
  });

  it.each([
    ['collection null', { collection: null }],
    ['collection noauth', { collection: { type: 'noauth' } }],
    ['folder null', { folder: null }],
    ['folder noauth', { folder: { type: 'noauth' } }],
    ['item null', { item: null }],
    ['item noauth', { item: { type: 'noauth' } }],
    ['request null', { request: null }],
    ['request noauth', { request: { type: 'noauth' } }],
  ])('clears inherited auth with %s', (_name, overrides) => {
    const inherited = {
      type: 'basic',
      basic: [{ key: 'password', value: 'inherited-secret' }],
    };
    const request: Record<string, unknown> = {
      method: 'GET',
      url: 'https://api.example.test/items',
    };
    const item = makeRequestItem({ request });
    const folder: Record<string, unknown> = { name: 'Folder', item: [item] };
    const extra: Record<string, unknown> = { auth: inherited };

    if ('collection' in overrides) extra.auth = overrides.collection;
    if ('folder' in overrides) folder.auth = overrides.folder;
    if ('item' in overrides) item.auth = overrides.item;
    if ('request' in overrides) request.auth = overrides.request;

    const parsed = parsePostmanSource(makeCollection([folder], extra));
    expect(parsed.members[0]?.request.auth).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('inherited-secret');
  });

  it('reports collection scripts even when there are no request items', () => {
    const parsed = parsePostmanSource(makeCollection([], {
      event: [{ listen: 'test', script: { exec: ['empty-collection-secret'] } }],
    }));

    expect(parsed.members).toEqual([]);
    expect(parsed.warnings).toEqual([
      {
        code: 'IMPORT_SCRIPT_IGNORED',
        message: 'Postman collection scripts are ignored during import',
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('empty-collection-secret');
  });

  it('reports nested folder scripts with numeric paths and no source context', () => {
    const parsed = parsePostmanSource(makeCollection([
      {
        name: 'outer-folder-secret',
        event: [{ listen: 'test', script: { exec: ['outer-script-secret'] } }],
        item: [{
          name: 'inner-folder-secret',
          event: [{ listen: 'test', script: { exec: ['inner-script-secret'] } }],
          item: [],
        }],
      },
    ], {
      event: [{ listen: 'test', script: { exec: ['collection-script-secret'] } }],
    }));

    expect(parsed.warnings).toEqual([
      {
        code: 'IMPORT_SCRIPT_IGNORED',
        message: 'Postman collection scripts are ignored during import',
      },
      {
        code: 'IMPORT_SCRIPT_IGNORED',
        message: 'Postman folder scripts at itemPath [0] are ignored during import',
      },
      {
        code: 'IMPORT_SCRIPT_IGNORED',
        message: 'Postman folder scripts at itemPath [0,0] are ignored during import',
      },
    ]);
    expect(JSON.stringify(parsed.warnings)).not.toMatch(/folder-secret|script-secret/);
  });

  it('normalizes saved responses without conflating no body and empty bytes', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({
        response: [
          {
            name: '   ',
            code: 201,
            header: [
              { key: 'Content-Type', value: 'application/vnd.example+json; profile=mobile' },
              { key: 'Set-Cookie', value: 'session=one; Path=/' },
              { key: 'set-cookie', value: 'theme=dark; Path=/' },
              { key: 'Connection', value: 'close' },
              { key: 'content-encoding', value: 'gzip' },
              { key: '', value: 'blank-name' },
            ],
            body: '',
          },
          {
            name: ' Bodyless ',
            code: 204,
            header: [{ key: 'Content-Type', value: 'text/plain' }],
          },
        ],
      }),
    ])).members[0];

    expect(member?.responses.map(response => ({
      name: response.name,
      status: response.status,
      headers: response.responseHeaders,
      bodySize: response.body?.length,
    }))).toEqual([
      {
        name: '',
        status: 201,
        headers: {
          'content-type': 'application/vnd.example+json; profile=mobile',
          'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
        },
        bodySize: 0,
      },
      {
        name: 'Bodyless',
        status: 204,
        headers: { 'content-type': 'text/plain' },
        bodySize: undefined,
      },
    ]);
    expect(member?.warnings.filter(warning => warning.code === 'IMPORT_RESPONSE_HEADER_DISCARDED'))
      .toEqual([
        { code: 'IMPORT_RESPONSE_HEADER_DISCARDED', message: 'A transport-managed saved response header was discarded' },
        { code: 'IMPORT_RESPONSE_HEADER_DISCARDED', message: 'A transport-managed saved response header was discarded' },
      ]);
    expect(member?.responses[0]?.identity).not.toBe(member?.responses[1]?.identity);
  });

  it('ignores malformed and invalid disabled saved-response headers before validation', () => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({
        response: [{
          code: 200,
          header: [
            { disabled: true },
            { key: 'Bad Header', value: 'name-secret', disabled: true },
            { key: 'X-Test', value: 'value-secret\nbreak', disabled: true },
            { key: 'X-Visible', value: 'safe', disabled: false },
          ],
        }],
      }),
    ])).members[0];

    expect(member?.responses[0]).toMatchObject({
      responseHeaders: { 'x-visible': 'safe' },
      warnings: [],
      errors: [],
    });
    expect(member?.errors).toEqual([]);
    expect(JSON.stringify(member)).not.toMatch(/name-secret|value-secret/);
  });

  it('assigns equal identities to equivalent normalized response header case and order', () => {
    const responses = parsePostmanSource(makeCollection([
      makeRequestItem({
        response: [
          {
            code: 200,
            header: [
              { key: 'X-Zeta', value: 'last' },
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Connection', value: 'close' },
            ],
            body: '{"ok":true}',
          },
          {
            code: 200,
            header: [
              { key: 'content-type', value: 'application/json' },
              { key: 'x-zeta', value: 'last' },
              { key: 'Transfer-Encoding', value: 'chunked' },
            ],
            body: '{"ok":true}',
          },
        ],
      }),
    ])).members[0]?.responses;

    expect(responses?.[0]?.responseHeaders).toEqual(responses?.[1]?.responseHeaders);
    expect(responses?.[0]?.identity).toBe(responses?.[1]?.identity);
  });

  it.each([
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
    'content-encoding',
  ])('discards the required saved-response header %s', headerName => {
    const response = parsePostmanSource(makeCollection([
      makeRequestItem({
        response: [{
          code: 200,
          header: [{ key: headerName, value: 'transport-value' }],
        }],
      }),
    ])).members[0]?.responses[0];

    expect(response).toMatchObject({
      responseHeaders: {},
      warnings: [expect.objectContaining({ code: 'IMPORT_RESPONSE_HEADER_DISCARDED' })],
      errors: [],
    });
  });

  it.each([
    ['status below 100', { code: 99 }, 'IMPORT_RESPONSE_STATUS_INVALID'],
    ['continue status', { code: 100 }, 'IMPORT_RESPONSE_STATUS_INVALID'],
    ['early hints status', { code: 103 }, 'IMPORT_RESPONSE_STATUS_INVALID'],
    ['informational upper boundary', { code: 199 }, 'IMPORT_RESPONSE_STATUS_INVALID'],
    ['status above 599', { code: 600 }, 'IMPORT_RESPONSE_STATUS_INVALID'],
    [
      'invalid header name',
      { code: 200, header: [{ key: 'Bad Header', value: 'value' }] },
      'IMPORT_RESPONSE_HEADER_INVALID',
    ],
    [
      'invalid header value',
      { code: 200, header: [{ key: 'X-Test', value: 'line\nbreak' }] },
      'IMPORT_RESPONSE_HEADER_INVALID',
    ],
    ['non-textual body', { code: 200, body: { secret: 'raw-secret' } }, 'IMPORT_RESPONSE_BODY_INVALID'],
    [
      'body over 10 MiB',
      { code: 200, body: 'x'.repeat((10 * 1024 * 1024) + 1) },
      'IMPORT_RESPONSE_BODY_TOO_LARGE',
    ],
  ])('keeps %s as a sanitized item error', (_name, response, code) => {
    const member = parsePostmanSource(makeCollection([
      makeRequestItem({ response: [{ name: 'Invalid', ...response }] }),
    ])).members[0];

    expect(member?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code }),
    ]));
    expect(member?.responses[0]?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code }),
    ]));
    expect(JSON.stringify(member?.errors)).not.toContain('raw-secret');
  });

  it.each([200, 599])('accepts final saved-response status %s', status => {
    const response = parsePostmanSource(makeCollection([
      makeRequestItem({ response: [{ name: 'Final', code: status }] }),
    ])).members[0]?.responses[0];

    expect(response).toMatchObject({ status, errors: [] });
  });

  it.each([
    ['primitive item', 'malformed-secret'],
    ['missing request', { name: 'Missing request', value: 'malformed-secret' }],
    ['string request', { name: 'String request', request: 'malformed-secret' }],
    ['missing method', { name: 'Missing method', request: { url: 'https://api.example.test' } }],
    ['missing URL', { name: 'Missing URL', request: { method: 'GET' } }],
  ])('keeps malformed request items enumerable: %s', (_name, item) => {
    const member = parsePostmanSource(makeCollection([item])).members[0];

    expect(member).toMatchObject({
      location: { type: 'postman', itemPath: [0] },
      canonicalRequest: undefined,
      errors: [expect.objectContaining({ code: 'IMPORT_REQUEST_INVALID' })],
    });
    expect(JSON.stringify(member)).not.toContain('malformed-secret');
  });

  it.each([
    ['null root', null],
    ['missing info', { item: [] }],
    ['wrong schema', { info: { schema: 'https://example.test/v2.1' }, item: [] }],
    ['missing items', { info: { schema: POSTMAN_V21_SCHEMA } }],
    ['non-array items', { info: { schema: POSTMAN_V21_SCHEMA }, item: {} }],
  ])('rejects an unenumerable source: %s', (_name, source) => {
    expectSourceError(source, 'IMPORT_SOURCE_INVALID');
  });

  it('counts disabled and malformed request entries toward the 1,000-item limit', () => {
    const items = Array.from({ length: 999 }, (_, index) => makeRequestItem({
      name: `Request ${index}`,
    }));
    items.push({ name: 'Disabled', disabled: true, request: null });
    items.push({ name: 'Malformed' });

    expectSourceError(makeCollection(items), 'IMPORT_LIMIT_EXCEEDED');
  });

  it('counts disabled and malformed saved responses toward the 5,000-response limit', () => {
    const responses = Array.from({ length: 4_999 }, () => ({ code: 200 }));
    responses.push({ code: 200, disabled: true });
    responses.push('malformed-response');

    expectSourceError(makeCollection([
      makeRequestItem({ response: responses }),
    ]), 'IMPORT_LIMIT_EXCEEDED');
  });

  it('rejects over-limit siblings before materializing any child context', () => {
    let indexedReads = 0;
    const items = new Proxy(new Array<unknown>(10_001), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expectSourceError(makeCollection(items), 'IMPORT_LIMIT_EXCEEDED');
    expect(indexedReads).toBe(0);
  });

  it.each([
    ['deep', () => {
      let nested: unknown[] = [];
      for (let depth = 10_000; depth >= 0; depth -= 1) {
        nested = [{ name: `Folder ${depth}`, item: nested }];
      }
      return nested;
    }],
    ['broad', () => Array.from({ length: 10_001 }, (_, index) => ({
      name: `Folder ${index}`,
      item: [],
    }))],
  ])('bounds %s empty-folder traversal with the canonical limit error', (_shape, items) => {
    expectSourceError(makeCollection(items()), 'IMPORT_LIMIT_EXCEEDED');
  });
});
