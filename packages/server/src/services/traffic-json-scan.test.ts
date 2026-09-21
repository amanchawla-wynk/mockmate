import { describe, expect, it } from 'vitest';

import { scanJsonForQuery } from './traffic-json-scan';

describe('scanJsonForQuery', () => {
  it('matches object keys and string values case-insensitively', () => {
    const value = { NeedleKey: 'Needle', note: 'has needle inside' };
    const result = scanJsonForQuery(value, 'needle');
    expect(result.matchCount).toBe(3);
    expect(result.matches).toEqual([
      { jsonPointer: '/NeedleKey', kind: 'key', occurrence: 1, snippet: 'NeedleKey' },
      { jsonPointer: '/NeedleKey', kind: 'value', occurrence: 1, snippet: 'Needle' },
      { jsonPointer: '/note', kind: 'value', occurrence: 1, snippet: 'has needle inside' },
    ]);
  });

  it('counts repeated non-overlapping occurrences within one token', () => {
    expect(scanJsonForQuery({ a: 'ababab' }, 'ab').matchCount).toBe(3);
    expect(scanJsonForQuery({ a: 'aaaa' }, 'aa').matchCount).toBe(2);
  });

  it('matches number, boolean, and null canonical text but not punctuation', () => {
    const value = { count: 1000, ok: true, missing: null, nested: [false] };
    expect(scanJsonForQuery(value, '1000').matchCount).toBe(1);
    expect(scanJsonForQuery(value, 'true').matchCount).toBe(1);
    expect(scanJsonForQuery(value, 'null').matchCount).toBe(1);
    expect(scanJsonForQuery(value, 'false').matchCount).toBe(1);
    // Braces, brackets, commas, and quotes are structure, not content.
    expect(scanJsonForQuery(value, '{').matchCount).toBe(0);
    expect(scanJsonForQuery(value, ',').matchCount).toBe(0);
  });

  it('builds JSON pointers for nested arrays and escapes special key characters', () => {
    const value = { 'a/b': { '~x': ['zero', 'needle'] } };
    const result = scanJsonForQuery(value, 'needle');
    expect(result.matchCount).toBe(1);
    expect(result.matches[0]).toEqual({
      jsonPointer: '/a~1b/~0x/1',
      kind: 'value',
      occurrence: 1,
      snippet: 'needle',
    });
  });

  it('caps retained snippets while still counting every occurrence', () => {
    const value = { a: 'x', b: 'x', c: 'x', d: 'x' };
    const result = scanJsonForQuery(value, 'x', { maxMatches: 2 });
    expect(result.matchCount).toBe(4);
    expect(result.matches).toHaveLength(2);
  });

  it('truncates long snippets around the matched scalar', () => {
    const value = { a: `prefix ${'z'.repeat(500)}` };
    const result = scanJsonForQuery(value, 'prefix', { snippetMax: 10 });
    expect(result.matches[0]!.snippet).toBe('prefix zzz…');
  });

  it('returns no matches for an empty result set', () => {
    expect(scanJsonForQuery({ a: 1 }, 'zzz')).toEqual({ matchCount: 0, matches: [] });
  });

  it('numbers occurrences within their own key or scalar', () => {
    const result = scanJsonForQuery({ a: 'xx', b: 'x' }, 'x');
    expect(result.matchCount).toBe(3);
    expect(result.matches.map(match => [match.jsonPointer, match.occurrence])).toEqual([
      ['/a', 1],
      ['/a', 2],
      ['/b', 1],
    ]);
  });

  it('stops descending past the depth bound instead of overflowing the stack', () => {
    let deep: unknown = 'needle';
    for (let level = 0; level < 5_000; level += 1) deep = { nested: deep };

    expect(() => scanJsonForQuery(deep, 'needle')).not.toThrow();
    expect(scanJsonForQuery(deep, 'needle', { maxDepth: 2 }).matchCount).toBe(0);
  });
});
