export function compileWildcardPattern(
  pattern: string,
  caseInsensitive = false,
): (actual: string | undefined) => boolean {
  const normalizedPattern = caseInsensitive ? pattern.toLowerCase() : pattern;
  const source = normalizedPattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');
  const expression = new RegExp(`^${source}$`);
  return actual => actual !== undefined
    && expression.test(caseInsensitive ? actual.toLowerCase() : actual);
}
