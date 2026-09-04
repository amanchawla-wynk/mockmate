import { validateHeaderName } from 'node:http';

const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

export type RequestHeaderTuple = readonly [name: string, value: string];

export function projectRequestHeaders(rawHeaders: readonly string[]): {
  tuples: RequestHeaderTuple[];
  grouped: Record<string, string[]>;
} {
  const tuples: RequestHeaderTuple[] = [];
  const grouped = Object.create(null) as Record<string, string[]>;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const tuple: RequestHeaderTuple = [rawHeaders[index], rawHeaders[index + 1]];
    tuples.push(tuple);
    (grouped[tuple[0].toLowerCase()] ??= []).push(tuple[1]);
  }
  return { tuples, grouped };
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function splitMediaType(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === ';') {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new Error('Invalid quoted media type parameter');
  parts.push(source.slice(start));
  return parts;
}

function parseParameterValue(source: string): string {
  if (!source.startsWith('"')) {
    if (!tokenPattern.test(source)) throw new Error('Invalid media type parameter value');
    return source;
  }
  if (source.length < 2 || !source.endsWith('"')) {
    throw new Error('Invalid quoted media type parameter');
  }

  let value = '';
  for (let index = 1; index < source.length - 1; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      if (index >= source.length - 1) throw new Error('Invalid quoted media type parameter');
      const escapedCharacter = source[index];
      const escapedCode = escapedCharacter.charCodeAt(0);
      if (escapedCode === 0x7f || (escapedCode < 0x20 && escapedCharacter !== '\t')) {
        throw new Error('Invalid quoted media type parameter');
      }
      value += escapedCharacter;
      continue;
    }
    const code = character.charCodeAt(0);
    if (character === '"' || code === 0x7f || (code < 0x20 && character !== '\t')) {
      throw new Error('Invalid quoted media type parameter');
    }
    value += character;
  }
  return value;
}

function formatParameterValue(value: string): string {
  return tokenPattern.test(value)
    ? value
    : `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

export function normalizeMediaType(input: string): string {
  const parts = splitMediaType(input.trim());
  const mediaType = parts.shift()?.trim() ?? '';
  const slash = mediaType.indexOf('/');
  if (slash <= 0 || slash !== mediaType.lastIndexOf('/')) throw new Error('Invalid media type');
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);
  if (!tokenPattern.test(type) || !tokenPattern.test(subtype)) throw new Error('Invalid media type');

  const parameters = new Map<string, string>();
  for (const rawParameter of parts) {
    const parameter = rawParameter.trim();
    const equals = parameter.indexOf('=');
    if (equals <= 0) throw new Error('Invalid media type parameter');
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const rawValue = parameter.slice(equals + 1).trim();
    if (!tokenPattern.test(name) || !rawValue) throw new Error('Invalid media type parameter');
    if (parameters.has(name)) throw new Error('Duplicate media type parameter');
    parameters.set(name, parseParameterValue(rawValue));
  }

  const suffix = [...parameters]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, value]) => `; ${name}=${formatParameterValue(value)}`)
    .join('');
  return `${type.toLowerCase()}/${subtype.toLowerCase()}${suffix}`;
}

export function normalizeContentEncoding(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const codings = input.split(',').map(source => {
    const coding = source.trim();
    if (!tokenPattern.test(coding)) throw new Error('Invalid content encoding');
    return coding.toLowerCase();
  }).filter(coding => coding !== 'identity');
  return codings.length === 0 ? undefined : codings.join(', ');
}

export type ContentEncodingProjection =
  | { valid: true; value?: string }
  | { valid: false; reason: 'invalid_content_encoding' };

export function projectContentEncoding(
  headers: readonly (readonly [string, string])[],
): ContentEncodingProjection {
  const values = headers
    .filter(([name]) => name.toLowerCase() === 'content-encoding')
    .map(([, value]) => value);
  try {
    const value = normalizeContentEncoding(values.length === 0 ? undefined : values.join(','));
    return value === undefined ? { valid: true } : { valid: true, value };
  } catch {
    return { valid: false, reason: 'invalid_content_encoding' };
  }
}

export function normalizeResponseHeaders(
  headers: readonly (readonly [string, string])[],
): Array<[string, string]> {
  const normalized: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    validateHeaderName(name);
    const normalizedName = name.toLowerCase();
    if (normalizedName === 'content-length'
      || normalizedName === 'transfer-encoding'
      || normalizedName === 'content-encoding') continue;
    normalized.push([normalizedName, value]);
  }
  return normalized;
}
