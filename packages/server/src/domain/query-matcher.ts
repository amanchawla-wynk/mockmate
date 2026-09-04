import type { MatchExpression } from './model';

export interface QueryEntry {
  name: string;
  value: string;
}

export type QueryParseResult =
  | { ok: true; entries: QueryEntry[] }
  | { ok: false; reason: 'query_parse_invalid' };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeQueryComponent(source: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code > 0x7f) throw new Error('Raw query must be ASCII');
    if (source[index] === '+') {
      bytes.push(0x20);
      continue;
    }
    if (source[index] === '%') {
      const pair = source.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(pair)) throw new Error('Invalid query escape');
      bytes.push(Number.parseInt(pair, 16));
      index += 2;
      continue;
    }
    bytes.push(code);
  }
  return utf8Decoder.decode(Uint8Array.from(bytes));
}

export function parseRawQuery(rawQuery: string): QueryParseResult {
  try {
    const source = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
    const entries: QueryEntry[] = [];
    for (const field of source.split('&')) {
      if (!field) continue;
      const equals = field.indexOf('=');
      const rawName = equals < 0 ? field : field.slice(0, equals);
      const rawValue = equals < 0 ? '' : field.slice(equals + 1);
      entries.push({
        name: decodeQueryComponent(rawName),
        value: decodeQueryComponent(rawValue),
      });
    }
    return { ok: true, entries };
  } catch {
    return { ok: false, reason: 'query_parse_invalid' };
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareExpressions(left: MatchExpression, right: MatchExpression): number {
  const operatorOrder = compareCodeUnits(left.operator, right.operator);
  return operatorOrder || compareCodeUnits(left.value, right.value);
}

export function canonicalizeQueryConstraints(
  source: Readonly<Record<string, readonly MatchExpression[]>> | undefined,
): Record<string, MatchExpression[]> | undefined {
  if (source === undefined) return undefined;
  const entries = Object.entries(source).sort(([left], [right]) => compareCodeUnits(left, right));
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([name, expressions]) => {
    if (expressions.length === 0) throw new Error('Query constraint arrays cannot be empty');
    return [name, expressions
      .map(expression => ({ ...expression }))
      .sort(compareExpressions)];
  }));
}

function expressionMatches(expression: MatchExpression, value: string): boolean {
  if (expression.operator === 'equals') return value === expression.value;
  const source = expression.value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');
  return new RegExp(`^${source}$`).test(value);
}

function expressionsMatchValues(
  expressions: readonly MatchExpression[],
  values: readonly string[],
): boolean {
  if (expressions.length === 0) throw new Error('Query constraint arrays cannot be empty');
  if (expressions.length > values.length) return false;

  const expressionByValue = new Array<number>(values.length).fill(-1);
  const assign = (expressionIndex: number, visitedValues: Set<number>): boolean => {
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      if (visitedValues.has(valueIndex)
        || !expressionMatches(expressions[expressionIndex], values[valueIndex])) continue;
      visitedValues.add(valueIndex);
      const previousExpression = expressionByValue[valueIndex];
      if (previousExpression < 0 || assign(previousExpression, visitedValues)) {
        expressionByValue[valueIndex] = expressionIndex;
        return true;
      }
    }
    return false;
  };

  return expressions.every((_, index) => assign(index, new Set()));
}

export function queryConstraintsMatch(
  constraints: Readonly<Record<string, readonly MatchExpression[]>> | undefined,
  entries: readonly QueryEntry[],
): boolean {
  if (constraints === undefined) return true;
  const valuesByName = new Map<string, string[]>();
  for (const entry of entries) {
    const values = valuesByName.get(entry.name);
    if (values === undefined) valuesByName.set(entry.name, [entry.value]);
    else values.push(entry.value);
  }

  return Object.entries(constraints)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .every(([name, expressions]) => expressionsMatchValues(
      expressions,
      valuesByName.get(name) ?? [],
    ));
}
