import { describe, expect, it } from 'vitest';

import { compileWildcardPattern } from './match-expression';

describe('compileWildcardPattern', () => {
  it('compiles escaped exact and wildcard expressions with explicit case behavior', () => {
    expect(compileWildcardPattern('/files/*.json')('/files/a.json')).toBe(true);
    expect(compileWildcardPattern('/files/*.json')('/files/aXjson')).toBe(false);
    expect(compileWildcardPattern('Paid*')('paid-plan')).toBe(false);
    expect(compileWildcardPattern('Paid*', true)('paid-plan')).toBe(true);
  });
});
