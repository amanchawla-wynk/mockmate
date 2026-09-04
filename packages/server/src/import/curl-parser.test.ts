import { describe, expect, it } from 'vitest';

import { HttpError } from '../services/api-errors';
import { parseCurlSource } from './curl-parser';

function expectSourceError(source: string, code: string): void {
  try {
    parseCurlSource(source);
    throw new Error('Expected parseCurlSource to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 422, code });
  }
}

describe('parseCurlSource', () => {
  it('preserves the normalized origin and every enabled query occurrence in canonical input', () => {
    const member = parseCurlSource(
      "curl 'https://api.example.test:8443/items?a=1&a=1&a=2' -H 'X-Trace: evidence-only'",
    ).members[0];

    expect(member).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://api.example.test:8443',
        matcher: {
          method: 'GET',
          path: '/items',
          query: {
            a: [
              { operator: 'equals', value: '1' },
              { operator: 'equals', value: '1' },
              { operator: 'equals', value: '2' },
            ],
          },
        },
      },
      request: {
        query: [
          { name: 'a', value: '1' },
          { name: 'a', value: '1' },
          { name: 'a', value: '2' },
        ],
        headers: [{ name: 'X-Trace', value: 'evidence-only' }],
      },
      errors: [],
    });
    expect(member?.canonicalRequest?.matcher).not.toHaveProperty('headers');
  });

  it('enumerates shell-aware commands without executing shell syntax', () => {
    const parsed = parseCurlSource(String.raw`curl --url https://api.one.test/users?token=secret \
      -H 'Authorization: Bearer hidden' ;
      curl "https://api.two.test/note;still-one" -H "X-Label: curl && safe" &&
      curl https://api.three.test/items --data-raw '{"name":"Ada"}'`);

    expect(parsed.members.map(member => member.location)).toEqual([
      { type: 'curl', commandIndex: 0 },
      { type: 'curl', commandIndex: 1 },
      { type: 'curl', commandIndex: 2 },
    ]);
    expect(parsed.members.map(member => member.canonicalRequest)).toEqual([
      { baseUrl: 'https://api.one.test', matcher: { method: 'GET', path: '/users', query: { token: [{ operator: 'equals', value: 'secret' }] } } },
      { baseUrl: 'https://api.two.test', matcher: { method: 'GET', path: '/note;still-one' } },
      { baseUrl: 'https://api.three.test', matcher: { method: 'POST', path: '/items' } },
    ]);
    expect(JSON.stringify(parsed.members.map(member => member.request))).not.toMatch(/secret|Bearer hidden/);
    expect(parsed.members[2]?.request.body).toEqual({
      mediaType: undefined,
      byteCount: Buffer.byteLength('{"name":"Ada"}'),
      omitted: true,
    });
  });

  it.each([
    ['-X', "curl -X PATCH 'https://api.example.test/items/1'", 'PATCH'],
    ['--request', "curl --request DELETE 'https://api.example.test/items/1'", 'DELETE'],
    ['literal --data-binary', "curl 'https://api.example.test/items' --data-binary 'plain bytes'", 'POST'],
  ])('supports %s', (_name, source, method) => {
    const member = parseCurlSource(source).members[0];
    expect(member?.errors).toEqual([]);
    expect(member?.canonicalRequest?.matcher.method).toBe(method);
  });

  it('supports quoted --url values and CRLF continuations', () => {
    const member = parseCurlSource(
      "CuRL --url \\\r\n 'https://API.Example.Test/path/'",
    ).members[0];

    expect(member).toMatchObject({
      location: { type: 'curl', commandIndex: 0 },
      canonicalRequest: {
        baseUrl: 'https://api.example.test',
        matcher: { method: 'GET', path: '/path' },
      },
      errors: [],
    });
  });

  it.each([
    ['backticks', "curl 'https://api.test/`whoami`'", 'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED'],
    ['$()', "curl 'https://api.test/$(whoami)'", 'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED'],
    ['dynamic URL', 'curl https://$HOST/items', 'CURL_DYNAMIC_URL_UNSUPPORTED'],
    ['short file body', "curl https://api.test/items -d '@payload.bin'", 'CURL_FILE_BODY_UNSUPPORTED'],
    ['long file body', "curl https://api.test/items --data '@payload.bin'", 'CURL_FILE_BODY_UNSUPPORTED'],
    ['binary file body', "curl https://api.test/items --data-binary '@payload.bin'", 'CURL_FILE_BODY_UNSUPPORTED'],
    ['short form upload', "curl https://api.test/items -F 'file=@payload.bin'", 'CURL_FORM_UNSUPPORTED'],
    ['long form upload', "curl https://api.test/items --form 'file=@payload.bin'", 'CURL_FORM_UNSUPPORTED'],
    ['short upload file', 'curl https://api.test/items -T payload.bin', 'CURL_FILE_BODY_UNSUPPORTED'],
    ['long upload file', 'curl https://api.test/items --upload-file payload.bin', 'CURL_FILE_BODY_UNSUPPORTED'],
    ['unsupported option operand', 'curl --proxy http://proxy.test https://api.test/items', 'CURL_OPTION_UNSUPPORTED'],
    ['pipe', 'curl https://api.test/items | jq .', 'CURL_SHELL_SYNTAX_UNSUPPORTED'],
  ])('reports %s as an item error', (_name, source, code) => {
    const member = parseCurlSource(source).members[0];
    expect(member).toMatchObject({
      location: { type: 'curl', commandIndex: 0 },
      errors: [expect.objectContaining({ code })],
    });
  });

  it.each([
    ['double pipe', 'curl https://api.test/items || jq .'],
    ['input redirection', 'curl https://api.test/items < request.txt'],
    ['output redirection', 'curl https://api.test/items > response.txt'],
  ])('rejects unsupported shell syntax: %s', (_name, source) => {
    expect(parseCurlSource(source).members[0]?.errors.map(error => error.code))
      .toContain('CURL_SHELL_SYNTAX_UNSUPPORTED');
  });

  it.each([
    [
      'URL path substitution',
      "curl -X PATCH 'https://api.test/$(url-path-secret)' -H 'X-Trace: header-secret'",
      'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED',
      /api\.test|url-path-secret|PATCH|header-secret/,
    ],
    [
      'method substitution',
      "curl -X 'PA`method-secret`TCH' https://api.test/items",
      'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED',
      /api\.test|method-secret|items/,
    ],
    [
      'non-sensitive header substitution',
      "curl https://api.test/items -H 'X-Trace: $(header-secret)'",
      'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED',
      /api\.test|items|X-Trace|header-secret/,
    ],
    [
      'pipeline',
      "curl -X PATCH https://api.test/path-secret -H 'X-Trace: header-secret' | sink-secret",
      'CURL_SHELL_SYNTAX_UNSUPPORTED',
      /api\.test|path-secret|PATCH|X-Trace|header-secret|sink-secret/,
    ],
    [
      'redirection',
      "curl -X PATCH https://api.test/path-secret -H 'X-Trace: header-secret' > output-secret",
      'CURL_SHELL_SYNTAX_UNSUPPORTED',
      /api\.test|path-secret|PATCH|X-Trace|header-secret|output-secret/,
    ],
  ])('returns an error-only member for tokenizer-level %s', (
    _name,
    source,
    code,
    exposedOperand,
  ) => {
    const member = parseCurlSource(source).members[0];

    expect(member).toMatchObject({
      supportedMethod: false,
      request: { query: [], headers: [] },
      warnings: [],
      errors: [expect.objectContaining({ code })],
    });
    expect(member?.canonicalRequest).toBeUndefined();
    expect(member?.request.body).toBeUndefined();
    expect(JSON.stringify(member)).not.toMatch(exposedOperand);
  });

  it('keeps a leading @ literal for --data-raw', () => {
    const member = parseCurlSource(
      "curl https://api.test/items --data-raw '@literal'",
    ).members[0];

    expect(member?.errors).toEqual([]);
    expect(member?.request.body?.byteCount).toBe(Buffer.byteLength('@literal'));
  });

  it.each([
    ['short separate', 'curl https://api.test/items -H @headers-short.txt', 'headers-short.txt'],
    ['long separate', 'curl https://api.test/items --header @headers-long.txt', 'headers-long.txt'],
    ['short attached', 'curl https://api.test/items -H@headers-attached.txt', 'headers-attached.txt'],
    ['long equals', 'curl https://api.test/items --header=@headers-equals.txt', 'headers-equals.txt'],
  ])('rejects file-backed headers in %s form', (_name, source, filename) => {
    const member = parseCurlSource(source).members[0];

    expect(member).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://api.test',
        matcher: { method: 'GET', path: '/items' },
      },
      request: { headers: [] },
      errors: [expect.objectContaining({ code: 'CURL_FILE_BODY_UNSUPPORTED' })],
    });
    expect(JSON.stringify(member)).not.toContain(filename);
  });

  it('retains data-implied POST while rejecting a file-backed body', () => {
    const member = parseCurlSource(
      "curl https://api.test/items --data '@payload.bin'",
    ).members[0];

    expect(member?.canonicalRequest?.matcher.method).toBe('POST');
    expect(member?.request.body).toBeUndefined();
    expect(member?.errors.map(error => error.code)).toContain('CURL_FILE_BODY_UNSUPPORTED');
  });

  it('keeps non-curl groups visible when at least one curl group is enumerable', () => {
    const parsed = parseCurlSource('echo unsafe; curl https://api.test/items');
    expect(parsed.members[0]).toMatchObject({
      location: { type: 'curl', commandIndex: 0 },
      errors: [expect.objectContaining({ code: 'CURL_COMMAND_UNSUPPORTED' })],
    });
    expect(parsed.members[1]).toMatchObject({
      location: { type: 'curl', commandIndex: 1 },
      canonicalRequest: {
        baseUrl: 'https://api.test',
        matcher: { method: 'GET', path: '/items' },
      },
    });
  });

  it('keeps unsupported methods visible and uncommittable', () => {
    const member = parseCurlSource(
      "curl -X OPTIONS 'https://api.example.test/items'",
    ).members[0];
    expect(member).toMatchObject({
      supportedMethod: false,
      canonicalRequest: {
        baseUrl: 'https://api.example.test',
        matcher: { method: 'OPTIONS', path: '/items' },
      },
      errors: [expect.objectContaining({ code: 'IMPORT_METHOD_UNSUPPORTED' })],
    });
  });

  it.each([
    ['single quote', "curl 'https://api.test/items"],
    ['double quote', 'curl "https://api.test/items'],
    ['no curl command', 'echo https://api.test/items'],
    ['empty input', ' ; \n && \n'],
  ])('rejects structurally unenumerable input: %s', (_name, source) => {
    expectSourceError(source, 'IMPORT_SOURCE_INVALID');
  });

  it('keeps malformed and missing URLs as enumerable member errors', () => {
    const parsed = parseCurlSource('curl not-a-url; curl -X GET');

    expect(parsed.members).toHaveLength(2);
    expect(parsed.members[0]).toMatchObject({
      location: { type: 'curl', commandIndex: 0 },
      errors: [expect.objectContaining({ code: 'CURL_URL_INVALID' })],
    });
    expect(parsed.members[1]).toMatchObject({
      location: { type: 'curl', commandIndex: 1 },
      errors: [expect.objectContaining({ code: 'CURL_URL_MISSING' })],
    });
  });

  it('enforces the group limit before classifying or collapsing commands', () => {
    const groups = Array.from({ length: 999 }, (_, index) => (
      `curl https://api${index}.test/items`
    ));
    groups.splice(41, 0, 'curl not-a-url');
    groups.splice(700, 0, 'echo still-counts');

    expectSourceError(groups.join(';'), 'IMPORT_LIMIT_EXCEEDED');
  });

  it('does not count empty command groups toward the limit', () => {
    const source = Array.from(
      { length: 1_000 },
      (_, index) => `curl https://api${index}.test/items; ;`,
    ).join('\n');

    expect(parseCurlSource(source).members).toHaveLength(1_000);
  });

  it('treats outside-quote continuation-only groups as empty', () => {
    const parsed = parseCurlSource(
      '\\\n;\n\\\r\n&&curl https://api.test/items',
    );

    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]).toMatchObject({
      location: { type: 'curl', commandIndex: 0 },
      canonicalRequest: {
        baseUrl: 'https://api.test',
        matcher: { method: 'GET', path: '/items' },
      },
    });
  });

  it('does not count a continuation-only group as command 1,001', () => {
    const commands = Array.from(
      { length: 1_000 },
      (_, index) => `curl https://api${index}.test/items`,
    );
    const parsed = parseCurlSource(['\\\n', ...commands].join(';'));

    expect(parsed.members).toHaveLength(1_000);
    expect(parsed.members[999]?.location).toEqual({ type: 'curl', commandIndex: 999 });
  });

  it('consumes rejected option operands and stops URL inference after unknown arity', () => {
    const parsed = parseCurlSource([
      'curl --proxy http://proxy.test https://api.test/real',
      'curl --unknown-option https://must-not-be-inferred.test/path',
    ].join(';'));

    expect(parsed.members[0]).toMatchObject({
      canonicalRequest: {
        baseUrl: 'https://api.test',
        matcher: { method: 'GET', path: '/real' },
      },
      errors: [expect.objectContaining({ code: 'CURL_OPTION_UNSUPPORTED' })],
    });
    expect(parsed.members[1]?.matcher).toBeUndefined();
    expect(parsed.members[1]?.errors.map(error => error.code)).toEqual([
      'CURL_OPTION_UNSUPPORTED',
      'CURL_URL_MISSING',
    ]);
  });

  it('preserves explicit default ports and bracketed IPv6 source ports', () => {
    const parsed = parseCurlSource([
      'curl https://api.test:443/secure',
      'curl http://api.test:80/plain',
      'curl http://[2001:db8::1]:8080/items',
    ].join(';'));

    expect(parsed.members.map(member => ({
      baseUrl: member.canonicalRequest?.baseUrl,
      port: member.request.port,
    }))).toEqual([
      { baseUrl: 'https://api.test', port: '443' },
      { baseUrl: 'http://api.test', port: '80' },
      { baseUrl: 'http://[2001:db8::1]:8080', port: '8080' },
    ]);
  });

  it('marks user information present without decoding malformed percent escapes', () => {
    const parsed = parseCurlSource(
      'curl https://user%ZZ:password-secret@api.test/items',
    );
    const member = parsed.members[0];

    expect(member?.errors).toEqual([]);
    expect(member?.request.userInfo).toBe('[REDACTED]');
    expect(JSON.stringify(parsed)).not.toMatch(/user%ZZ|password-secret/);
  });

  it('concatenates data fields for body size and uses the first content type', () => {
    const member = parseCurlSource([
      'curl https://api.test/items',
      "-H 'Content-Type: application/json'",
      "-H 'content-type: ignored/type'",
      "-H 'X-Trace: first'",
      "-H 'X-Trace: second'",
      "-d 'alpha=1' --data 'beta=2'",
    ].join(' ')).members[0];

    expect(member?.request.body).toEqual({
      mediaType: 'application/json',
      byteCount: Buffer.byteLength('alpha=1&beta=2'),
      omitted: true,
    });
    expect(member?.request.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'content-type', value: 'ignored/type' },
      { name: 'X-Trace', value: 'first' },
      { name: 'X-Trace', value: 'second' },
    ]);
    expect(member?.responses).toEqual([]);
  });

  it('uses deterministic locations and identities across repeated parses', () => {
    const source = '\n; curl https://one.test; ;\ncurl https://two.test';
    const first = parseCurlSource(source);
    const second = parseCurlSource(source);

    expect(first.members.map(member => member.location)).toEqual([
      { type: 'curl', commandIndex: 0 },
      { type: 'curl', commandIndex: 1 },
    ]);
    expect(first.members.map(member => member.provisionalId))
      .toEqual(second.members.map(member => member.provisionalId));
  });

  it('sanitizes member errors and never returns URL or body source values', () => {
    const parsed = parseCurlSource([
      'curl http://[invalid.test/items?token=url-secret',
      "curl https://api.test/items -F 'payload=body-secret'",
    ].join(';'));
    const serializedErrors = JSON.stringify(
      parsed.members.flatMap(member => member.errors),
    );

    expect(serializedErrors).not.toMatch(/url-secret|body-secret|invalid\.test/);
    expect(parsed.members[0]?.errors.map(error => error.code)).toContain('CURL_URL_INVALID');
    expect(parsed.members[1]?.errors.map(error => error.code)).toContain('CURL_FORM_UNSUPPORTED');
  });

  it('does not warn that canonical origin data was discarded', () => {
    const members = parseCurlSource(
      'curl http://one.test; curl https://two.test',
    ).members;

    expect(members.map(member => member.warnings)).toEqual([[], []]);
  });
});
