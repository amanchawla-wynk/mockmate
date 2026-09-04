import { normalizeAuthority, normalizeHttpOrigin } from './http-origin';

it.each([
  ['HTTPS://API.Example.test.:443', 'https://api.example.test'],
  ['http://api.example.test:80/', 'http://api.example.test'],
  ['https://api.example.test:8443', 'https://api.example.test:8443'],
])('normalizes %s', (source, expected) => {
  expect(normalizeHttpOrigin(source).origin).toBe(expected);
});

it('returns normalized origin components and effective ports', () => {
  expect(normalizeAuthority('https', 'Bücher.Example.:443')).toEqual({
    origin: 'https://xn--bcher-kva.example',
    scheme: 'https',
    hostname: 'xn--bcher-kva.example',
    effectivePort: 443,
  });
  expect(normalizeAuthority('http', 'api.example.test:8080')).toEqual({
    origin: 'http://api.example.test:8080',
    scheme: 'http',
    hostname: 'api.example.test',
    port: 8080,
    effectivePort: 8080,
  });
});

it('canonicalizes equivalent IPv6 authority spellings', () => {
  expect(normalizeAuthority('https', '[2001:0db8:0:0:0:0:0:1]:443')).toEqual({
    origin: 'https://[2001:db8::1]',
    scheme: 'https',
    hostname: '2001:db8::1',
    effectivePort: 443,
  });
});

it.each([
  'ftp://api.example.test',
  'https://user:pass@api.example.test',
  'https://api.example.test/path',
  'https://api.example.test?x=1',
  'https://api.example.test#x',
  'https://api.example.test:00080',
])('rejects non-origin source %s', source => {
  expect(() => normalizeHttpOrigin(source)).toThrow();
});

it.each([
  'api.example.test:0',
  'api.example.test:080',
  'api.example.test:65536',
  'api.example.test:',
  '-api.example.test',
  'api_.example.test',
  'api..example.test',
])('rejects malformed authority %s', authority => {
  expect(() => normalizeAuthority('https', authority)).toThrow();
});
