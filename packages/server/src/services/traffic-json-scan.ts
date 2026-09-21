export interface JsonScanMatch {
  jsonPointer: string;
  kind: 'key' | 'value';
  occurrence: number;
  snippet: string;
}

export interface JsonScanResult {
  matchCount: number;
  matches: JsonScanMatch[];
}

export interface JsonScanOptions {
  /** Maximum representative snippets retained; total occurrences are always counted. */
  maxMatches?: number;
  /** Maximum displayed snippet length before truncation. */
  snippetMax?: number;
  /** Maximum nesting depth walked before the scan stops descending. */
  maxDepth?: number;
}

const DEFAULT_MAX_MATCHES = 3;
const DEFAULT_SNIPPET_MAX = 160;
/** Bounds recursion so adversarial nesting cannot overflow the stack. */
const DEFAULT_MAX_DEPTH = 256;

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function scalarText(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return value;
}

function boundedSnippet(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function countOccurrences(loweredText: string, loweredQuery: string): number {
  if (loweredQuery.length === 0) return 0;
  let count = 0;
  let index = loweredText.indexOf(loweredQuery);
  while (index !== -1) {
    count += 1;
    index = loweredText.indexOf(loweredQuery, index + loweredQuery.length);
  }
  return count;
}

/**
 * Case-insensitive plain-text scan across a parsed JSON value. Object property
 * names and scalar values match; container punctuation and whitespace do not.
 * Every occurrence contributes to `matchCount`; up to `maxMatches` representative
 * snippets are retained in document order.
 */
export function scanJsonForQuery(
  value: unknown,
  query: string,
  options: JsonScanOptions = {},
): JsonScanResult {
  const loweredQuery = query.toLowerCase();
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const snippetMax = options.snippetMax ?? DEFAULT_SNIPPET_MAX;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const matches: JsonScanMatch[] = [];
  let matchCount = 0;

  const record = (token: string, kind: 'key' | 'value', pointer: string): void => {
    const occurrences = countOccurrences(token.toLowerCase(), loweredQuery);
    for (let occurrence = 1; occurrence <= occurrences; occurrence += 1) {
      matchCount += 1;
      if (matches.length < maxMatches) {
        matches.push({
          jsonPointer: pointer,
          kind,
          // Occurrence is the index within this key/scalar, so pointer plus
          // occurrence identifies one semantic match.
          occurrence,
          snippet: boundedSnippet(token, snippetMax),
        });
      }
    }
  };

  const walk = (node: unknown, pointer: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], `${pointer}/${index}`, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const childPointer = `${pointer}/${escapePointerSegment(key)}`;
        record(key, 'key', childPointer);
        walk(child, childPointer, depth + 1);
      }
      return;
    }
    record(scalarText(node as string | number | boolean | null), 'value', pointer);
  };

  walk(value, '', 0);
  return { matchCount, matches };
}
