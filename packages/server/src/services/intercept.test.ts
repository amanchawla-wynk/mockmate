import {
  hostMatchesPattern,
  normalizeInterceptionPattern,
  normalizeInterceptionPatterns,
} from './intercept';

it('normalizes exact, wildcard, and IDNA interception patterns', () => {
  expect(normalizeInterceptionPattern('*.EXAMPLE.test.', new Set())).toBe('*.example.test');
  expect(normalizeInterceptionPattern('Bücher.Example', new Set())).toBe('xn--bcher-kva.example');
  expect(normalizeInterceptionPattern('api.*.EXAMPLE', new Set())).toBe('api.*.example');
  expect(normalizeInterceptionPattern('2001:0db8:0:0:0:0:0:1', new Set())).toBe('2001:db8::1');
});

it('matches wildcard subdomains without matching the apex', () => {
  expect(hostMatchesPattern('*.example.test', 'a.b.example.test')).toBe(true);
  expect(hostMatchesPattern('*.example.test', 'example.test')).toBe(false);
  expect(hostMatchesPattern('api.*.example', 'API.mobile.EXAMPLE.')).toBe(true);
});

it.each([
  'http://api.test',
  '-api.example.test',
  'api_.example.test',
  'api..example.test',
  'api?.example.test',
  'api.example.test..',
])('rejects malformed interception pattern %s', pattern => {
  expect(() => normalizeInterceptionPattern(pattern, new Set())).toThrow();
});

it('rejects local-control hosts', () => {
  expect(() => normalizeInterceptionPattern('localhost', new Set(['localhost']))).toThrow();
  expect(() => normalizeInterceptionPattern('LOCAL.test.', new Set(['local.test']))).toThrow();
  expect(() => normalizeInterceptionPattern(
    '0:0:0:0:0:0:0:1',
    new Set(['::1']),
  )).toThrow();
});

it('allows catch-all normalization while runtime matching remains responsible for local exclusion', () => {
  expect(normalizeInterceptionPattern('*', new Set(['localhost', '127.0.0.1']))).toBe('*');
});

it.each(['bad_host.example', '-bad.example', 'bad..example'])(
  'does not match malformed candidate hostname %s',
  hostname => expect(hostMatchesPattern('*', hostname)).toBe(false),
);

it('rejects duplicate normalized patterns', () => {
  expect(() => normalizeInterceptionPatterns(
    ['API.example.test', 'api.example.test.'],
    new Set(),
  )).toThrow();
});
