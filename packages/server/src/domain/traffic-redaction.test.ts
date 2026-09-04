import {
  isSensitiveQueryName,
  redactTrafficHeaders,
  redactTrafficQuery,
} from './traffic-redaction';

const sensitiveQueryFamilies = [
  { family: 'credential', name: 'clientCredentialId' },
  { family: 'session', name: 'userSessionId' },
  { family: 'auth', name: 'authContext' },
] as const;

it('lowercases header names and masks credential-bearing values', () => {
  expect(redactTrafficHeaders([
    ['Authorization', 'Bearer secret'],
    ['Set-Cookie', 'sid=secret'],
    ['Accept', 'text/plain'],
  ])).toEqual([
    ['authorization', '[REDACTED]'],
    ['set-cookie', '[REDACTED]'],
    ['accept', 'text/plain'],
  ]);
});

it.each(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])(
  'masks sensitive header %s case-insensitively',
  name => expect(redactTrafficHeaders([[name.toUpperCase(), 'private']])).toEqual([
    [name, '[REDACTED]'],
  ]),
);

it('masks password, token, key, and secret-like query names without changing names or order', () => {
  expect(redactTrafficQuery([
    { name: 'page', value: '2' },
    { name: 'apiToken', value: 'secret' },
    { name: 'password', value: 'private' },
    { name: 'api_key', value: 'private' },
    { name: 'apikey', value: 'private' },
    { name: 'client-secret', value: 'private' },
  ])).toEqual([
    { name: 'page', value: '2' },
    { name: 'apiToken', value: '[REDACTED]' },
    { name: 'password', value: '[REDACTED]' },
    { name: 'api_key', value: '[REDACTED]' },
    { name: 'apikey', value: '[REDACTED]' },
    { name: 'client-secret', value: '[REDACTED]' },
  ]);
});

it.each(sensitiveQueryFamilies)(
  'masks query names containing $family through the shared classifier',
  ({ family, name }) => {
    const exactValue = `${family}-unit-exact`;

    expect(isSensitiveQueryName(name)).toBe(true);
    expect(redactTrafficQuery([{ name, value: exactValue }])).toEqual([
      { name, value: '[REDACTED]' },
    ]);
  },
);

it('does not mutate source traffic metadata', () => {
  const headers = [['Authorization', 'private']] as const;
  const query = [{ name: 'token', value: 'private' }] as const;
  redactTrafficHeaders(headers);
  redactTrafficQuery(query);
  expect(headers[0][1]).toBe('private');
  expect(query[0].value).toBe('private');
});
