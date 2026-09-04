export function connectionTokens(value: string | undefined): string[] {
  return value?.split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean) ?? [];
}

export function hasConnectionToken(headers: Record<string, string>, token: string): boolean {
  const expected = token.toLowerCase();
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'connection')
    .some(([, value]) => connectionTokens(value).includes(expected));
}
