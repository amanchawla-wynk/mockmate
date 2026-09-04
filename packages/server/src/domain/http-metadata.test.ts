import {
  normalizeContentEncoding,
  normalizeMediaType,
  normalizeResponseHeaders,
  projectContentEncoding,
  projectRequestHeaders,
} from './http-metadata';

it('normalizes media type tokens and sorts parameters by code unit', () => {
  expect(normalizeMediaType('Application/JSON; Charset="UTF-8"; profile=Mobile')).toBe(
    'application/json; charset=UTF-8; profile=Mobile',
  );
  expect(normalizeMediaType('text/plain; note="two words"; Charset=utf-8')).toBe(
    'text/plain; charset=utf-8; note="two words"',
  );
});

it('canonicalizes quoting and escaping while preserving parameter value case', () => {
  expect(normalizeMediaType('text/plain; note="A \\"quote\\" and \\\\ slash"')).toBe(
    'text/plain; note="A \\"quote\\" and \\\\ slash"',
  );
});

it.each([
  'text',
  'text/plain;',
  'text/plain; charset=utf-8; CHARSET=ascii',
  'text/plain; bad="unterminated',
  'text/plain; bad=value with spaces',
  'text/plain; bad="escaped\\\u0001control"',
])('rejects malformed media type %s', source => {
  expect(() => normalizeMediaType(source)).toThrow();
});

it('normalizes content codings, removes identity, and preserves repetition', () => {
  expect(normalizeContentEncoding(' GZip, identity, BR, gzip ')).toBe('gzip, br, gzip');
  expect(normalizeContentEncoding('identity')).toBeUndefined();
  expect(normalizeContentEncoding(undefined)).toBeUndefined();
});

it.each(['gzip,,br', 'gzip;level=1', 'gzip, bad encoding'])(
  'rejects malformed content encoding %s',
  source => expect(() => normalizeContentEncoding(source)).toThrow(),
);

it('projects all repeated Content-Encoding tuples in occurrence and value order', () => {
  expect(projectContentEncoding([
    ['Content-Encoding', 'GZip, identity'],
    ['x-other', 'ignored'],
    ['content-encoding', 'BR'],
  ])).toEqual({ valid: true, value: 'gzip, br' });
  expect(projectContentEncoding([])).toEqual({ valid: true });
});

it('returns only fixed vocabulary for malformed repeated Content-Encoding tuples', () => {
  const unsafe = 'br; key=/Users/alice/private.pem';
  const projected = projectContentEncoding([
    ['content-encoding', 'gzip'],
    ['content-encoding', unsafe],
  ]);
  expect(projected).toEqual({ valid: false, reason: 'invalid_content_encoding' });
  expect(JSON.stringify(projected)).not.toContain(unsafe);
});

it('projects raw request tuples and lowercase grouping in exact occurrence order', () => {
  expect(projectRequestHeaders([
    'X-Repeat', 'first',
    'Host', 'api.example.test',
    'x-repeat', 'second',
    'X-Repeat', 'third',
  ])).toEqual({
    tuples: [
      ['X-Repeat', 'first'],
      ['Host', 'api.example.test'],
      ['x-repeat', 'second'],
      ['X-Repeat', 'third'],
    ],
    grouped: {
      'x-repeat': ['first', 'second', 'third'],
      host: ['api.example.test'],
    },
  });
});

it('groups prototype-bearing normalized field names without inherited lookup', () => {
  const projected = projectRequestHeaders([
    '__proto__', 'first',
    'Constructor', 'built',
    'toString', 'rendered',
    '__PROTO__', 'second',
  ]);

  expect(projected.tuples).toEqual([
    ['__proto__', 'first'],
    ['Constructor', 'built'],
    ['toString', 'rendered'],
    ['__PROTO__', 'second'],
  ]);
  expect(Object.getPrototypeOf(projected.grouped)).toBeNull();
  expect(Object.keys(projected.grouped)).toEqual(['__proto__', 'constructor', 'tostring']);
  expect(projected.grouped.__proto__).toEqual(['first', 'second']);
  expect(projected.grouped.constructor).toEqual(['built']);
  expect(projected.grouped.tostring).toEqual(['rendered']);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

it('normalizes response headers while preserving end-to-end order and repetition', () => {
  expect(normalizeResponseHeaders([
    ['X-Trace', 'one'],
    ['Content-Length', '123'],
    ['Set-Cookie', 'a=1'],
    ['x-trace', 'two'],
    ['Transfer-Encoding', 'chunked'],
    ['CONTENT-ENCODING', 'gzip'],
  ])).toEqual([
    ['x-trace', 'one'],
    ['set-cookie', 'a=1'],
    ['x-trace', 'two'],
  ]);
});

it('rejects invalid response header names', () => {
  expect(() => normalizeResponseHeaders([['bad header', 'value']])).toThrow();
});
