import {
  canonicalizeQueryConstraints,
  parseRawQuery,
  queryConstraintsMatch,
} from './query-matcher';

it('splits before decoding and preserves repeated/empty fields', () => {
  expect(parseRawQuery('?a&a=&=x&&a=%26%3D&plus=a+b')).toEqual({
    ok: true,
    entries: [
      { name: 'a', value: '' },
      { name: 'a', value: '' },
      { name: '', value: 'x' },
      { name: 'a', value: '&=' },
      { name: 'plus', value: 'a b' },
    ],
  });
});

it.each(['?bad=%', '?bad=%GG', '?bad=%C3%28', '?raw=é'])(
  'rejects malformed query %s',
  raw => {
    expect(parseRawQuery(raw)).toEqual({
      ok: false,
      reason: 'query_parse_invalid',
    });
  },
);

it('normalizes absent and empty constraints away', () => {
  expect(canonicalizeQueryConstraints(undefined)).toBeUndefined();
  expect(canonicalizeQueryConstraints({})).toBeUndefined();
});

it('sorts keys and operator/value pairs by code unit without mutating input', () => {
  const source = {
    z: [
      { operator: 'glob', value: 'z*' },
      { operator: 'equals', value: 'fixed' },
      { operator: 'glob', value: 'A*' },
    ],
    A: [{ operator: 'equals', value: 'first' }],
  } as const;

  expect(canonicalizeQueryConstraints(source)).toEqual({
    A: [{ operator: 'equals', value: 'first' }],
    z: [
      { operator: 'equals', value: 'fixed' },
      { operator: 'glob', value: 'A*' },
      { operator: 'glob', value: 'z*' },
    ],
  });
  expect(source.z[0]).toEqual({ operator: 'glob', value: 'z*' });
});

it('rejects empty expression arrays', () => {
  expect(() => canonicalizeQueryConstraints({ empty: [] })).toThrow();
});

it('uses an injective assignment instead of greedy source order', () => {
  const constraints = {
    q: [
      { operator: 'glob', value: '*' },
      { operator: 'equals', value: 'fixed' },
    ],
  } as const;
  expect(queryConstraintsMatch(constraints, [
    { name: 'q', value: 'fixed' },
    { name: 'q', value: 'other' },
  ])).toBe(true);
  expect(queryConstraintsMatch({ q: [constraints.q[1], constraints.q[1]] }, [
    { name: 'q', value: 'fixed' },
  ])).toBe(false);
});

it('matches each constrained name independently and treats no constraints as a match', () => {
  expect(queryConstraintsMatch(undefined, [])).toBe(true);
  expect(queryConstraintsMatch({}, [{ name: 'extra', value: 'value' }])).toBe(true);
  expect(queryConstraintsMatch({
    literal: [{ operator: 'glob', value: 'a.*' }],
    repeated: [{ operator: 'equals', value: '' }],
  }, [
    { name: 'literal', value: 'a.value' },
    { name: 'repeated', value: '' },
  ])).toBe(true);
  expect(queryConstraintsMatch({
    literal: [{ operator: 'glob', value: 'a.*' }],
  }, [{ name: 'literal', value: 'abvalue' }])).toBe(false);
});
