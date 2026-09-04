import { normalizeHttpOrigin } from '../domain/http-origin';
import { parseRawQuery, type QueryEntry } from '../domain/query-matcher';
import { normalizeMethod, normalizePath } from '../repository/compile-project';
import { HttpError } from '../services/api-errors';
import type {
  ImportMessage,
  ImportRequestField,
  NormalizedImportMember,
  ParsedImportSource,
} from './contracts';
import { redactRequestSummary, sha256Identity } from './security';

const MAX_COMMANDS = 1_000;
const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const REJECTED_OPTION_ARITY = new Map<string, number>([
  ['--cacert', 1],
  ['--cert', 1],
  ['--connect-timeout', 1],
  ['--cookie', 1],
  ['--key', 1],
  ['--max-time', 1],
  ['--output', 1],
  ['--proxy', 1],
  ['--referer', 1],
  ['--resolve', 1],
  ['--user', 1],
  ['--user-agent', 1],
  ['-A', 1],
  ['-b', 1],
  ['-e', 1],
  ['-o', 1],
  ['-u', 1],
  ['-x', 1],
]);

type Quote = 'single' | 'double' | undefined;

interface CurlToken {
  value: string;
  quoted: boolean;
}

interface TokenizedCommand {
  commandIndex: number;
  tokens: CurlToken[];
  errors: ImportMessage[];
}

interface DataToken {
  value: string;
  raw: boolean;
}

function message(code: string, text: string): ImportMessage {
  return { code, message: text };
}

function sourceError(code: string, text: string): HttpError {
  return new HttpError(422, code, text);
}

function addError(errors: ImportMessage[], error: ImportMessage): void {
  if (!errors.some(existing => existing.code === error.code)) errors.push(error);
}

function tokenizeCommands(text: string): TokenizedCommand[] {
  const commands: TokenizedCommand[] = [];
  let tokens: CurlToken[] = [];
  let errors: ImportMessage[] = [];
  let value = '';
  let quote: Quote;
  let escaped = false;
  let tokenQuoted = false;
  let groupHasContent = false;

  const flushToken = (): void => {
    if (value.length > 0 || tokenQuoted) tokens.push({ value, quoted: tokenQuoted });
    value = '';
    tokenQuoted = false;
  };
  const addShellError = (code: string, textValue: string): void => {
    addError(errors, message(code, textValue));
    groupHasContent = true;
  };
  const flushCommand = (): void => {
    flushToken();
    if (!groupHasContent && tokens.length === 0 && errors.length === 0) return;
    commands.push({ commandIndex: commands.length, tokens, errors });
    if (commands.length > MAX_COMMANDS) {
      throw sourceError(
        'IMPORT_LIMIT_EXCEEDED',
        'The import source contains more than 1,000 command groups',
      );
    }
    tokens = [];
    errors = [];
    groupHasContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '`' || (character === '$' && next === '(')) {
      addShellError(
        'CURL_COMMAND_SUBSTITUTION_UNSUPPORTED',
        'Shell command substitution is not supported in cURL imports',
      );
    }

    if (quote === 'single') {
      groupHasContent = true;
      tokenQuoted = true;
      if (character === "'") quote = undefined;
      else value += character;
      continue;
    }

    if (quote === 'double') {
      groupHasContent = true;
      tokenQuoted = true;
      if (escaped) {
        value += character;
        escaped = false;
      } else if (character === '\\') {
        if (next === '\n') index += 1;
        else if (next === '\r' && text[index + 2] === '\n') index += 2;
        else escaped = true;
      } else if (character === '"') {
        quote = undefined;
      } else {
        value += character;
      }
      continue;
    }

    if (escaped) {
      value += character;
      groupHasContent = true;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      if (next === '\n') index += 1;
      else if (next === '\r' && text[index + 2] === '\n') index += 2;
      else {
        groupHasContent = true;
        escaped = true;
      }
      continue;
    }
    if (character === "'") {
      quote = 'single';
      tokenQuoted = true;
      groupHasContent = true;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      tokenQuoted = true;
      groupHasContent = true;
      continue;
    }
    if (character === '\n' || character === ';') {
      flushCommand();
      continue;
    }
    if (character === '&' && next === '&') {
      flushCommand();
      index += 1;
      continue;
    }
    if (character === '|') {
      flushToken();
      addShellError(
        'CURL_SHELL_SYNTAX_UNSUPPORTED',
        'Shell pipelines and redirection are not supported in cURL imports',
      );
      if (next === '|') index += 1;
      continue;
    }
    if (character === '<' || character === '>' || character === '&') {
      flushToken();
      addShellError(
        'CURL_SHELL_SYNTAX_UNSUPPORTED',
        'Shell pipelines and redirection are not supported in cURL imports',
      );
      continue;
    }
    if (/\s/.test(character)) {
      flushToken();
      continue;
    }

    value += character;
    groupHasContent = true;
  }

  if (quote !== undefined) {
    throw sourceError('IMPORT_SOURCE_INVALID', 'The cURL import source has unmatched quotes');
  }
  if (escaped) value += '\\';
  flushCommand();
  return commands;
}

function optionValue(
  tokens: CurlToken[],
  index: number,
  inlineValue: string | undefined,
  errors: ImportMessage[],
): { value?: CurlToken; consumed: number } {
  if (inlineValue !== undefined) {
    if (inlineValue.length > 0) return { value: { value: inlineValue, quoted: false }, consumed: 0 };
    addError(
      errors,
      message('CURL_OPTION_VALUE_MISSING', 'A supported cURL option is missing its value'),
    );
    return { consumed: 0 };
  }
  const valueToken = tokens[index + 1];
  if (valueToken !== undefined) return { value: valueToken, consumed: 1 };
  addError(
    errors,
    message('CURL_OPTION_VALUE_MISSING', 'A supported cURL option is missing its value'),
  );
  return { consumed: 0 };
}

function parseHeader(value: string): ImportRequestField {
  const colonIndex = value.indexOf(':');
  if (colonIndex < 0) return { name: value.trim(), value: '' };
  return {
    name: value.slice(0, colonIndex).trim(),
    value: value.slice(colonIndex + 1).trim(),
  };
}

function extractExplicitSourcePort(value: string): string | undefined {
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.exec(value);
  if (!scheme) return undefined;
  const authorityStart = scheme[0].length;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndOffset < 0
    ? value.length
    : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);

  if (hostAndPort.startsWith('[')) {
    const closeBracket = hostAndPort.indexOf(']');
    if (closeBracket < 0) return undefined;
    const port = hostAndPort.slice(closeBracket + 1);
    return /^:\d+$/.test(port) ? port.slice(1) : undefined;
  }

  const colonIndex = hostAndPort.lastIndexOf(':');
  if (colonIndex < 0) return undefined;
  const port = hostAndPort.slice(colonIndex + 1);
  return /^\d+$/.test(port) ? port : undefined;
}

function authoredRawQuery(value: string): string {
  const fragmentIndex = value.indexOf('#');
  const beforeFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf('?');
  return queryIndex < 0 ? '' : beforeFragment.slice(queryIndex + 1);
}

function exactQueryConstraints(entries: QueryEntry[]) {
  const query: NonNullable<NormalizedImportMember['canonicalRequest']>['matcher']['query'] = {};
  for (const { name, value } of entries) {
    (query[name] ??= []).push({ operator: 'equals', value });
  }
  return Object.keys(query).length === 0 ? undefined : query;
}

function baseMember(commandIndex: number, errors: ImportMessage[]): NormalizedImportMember {
  const location = { type: 'curl' as const, commandIndex };
  return {
    provisionalId: sha256Identity('import-member-v1', {
      sourceType: 'curl',
      location,
    }),
    location,
    breadcrumb: [],
    name: `cURL command ${commandIndex + 1}`,
    disabled: false,
    supportedMethod: false,
    request: { query: [], headers: [] },
    responses: [],
    unresolvedVariables: [],
    warnings: [],
    errors,
  };
}

function parseCommand(command: TokenizedCommand): NormalizedImportMember {
  const errors = [...command.errors];
  const member = baseMember(command.commandIndex, errors);
  const [commandToken, ...tokens] = command.tokens;
  if (commandToken?.value.toLowerCase() !== 'curl') {
    addError(
      errors,
      message('CURL_COMMAND_UNSUPPORTED', 'Only cURL command groups can be imported'),
    );
    return member;
  }
  if (command.errors.length > 0) return member;

  let explicitMethod: string | undefined;
  let explicitUrlToken: CurlToken | undefined;
  let positionalUrlToken: CurlToken | undefined;
  let allowPositionalInference = true;
  const headers: ImportRequestField[] = [];
  const dataTokens: DataToken[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equalsIndex = token.value.startsWith('--') ? token.value.indexOf('=') : -1;
    const option = equalsIndex >= 0 ? token.value.slice(0, equalsIndex) : token.value;
    const inlineValue = equalsIndex >= 0 ? token.value.slice(equalsIndex + 1) : undefined;

    if (option === '-X' || option === '--request' || option.startsWith('-X')) {
      const attached = option.startsWith('-X') && option !== '-X' ? option.slice(2) : inlineValue;
      const parsed = optionValue(tokens, index, attached, errors);
      if (parsed.value) explicitMethod = parsed.value.value;
      index += parsed.consumed;
      continue;
    }
    if (option === '-H' || option === '--header' || option.startsWith('-H')) {
      const attached = option.startsWith('-H') && option !== '-H' ? option.slice(2) : inlineValue;
      const parsed = optionValue(tokens, index, attached, errors);
      if (parsed.value?.value.startsWith('@')) {
        addError(
          errors,
          message('CURL_FILE_BODY_UNSUPPORTED', 'File-backed cURL request headers are not supported'),
        );
      } else if (parsed.value) {
        headers.push(parseHeader(parsed.value.value));
      }
      index += parsed.consumed;
      continue;
    }
    if (
      option === '-d'
      || option === '--data'
      || option === '--data-raw'
      || option === '--data-binary'
      || (option.startsWith('-d') && option !== '-d')
    ) {
      const attached = option.startsWith('-d') && option !== '-d' ? option.slice(2) : inlineValue;
      const parsed = optionValue(tokens, index, attached, errors);
      if (parsed.value) {
        const raw = option === '--data-raw';
        dataTokens.push({ value: parsed.value.value, raw });
        if (parsed.value.value.startsWith('@') && !raw) {
          addError(
            errors,
            message('CURL_FILE_BODY_UNSUPPORTED', 'File-backed cURL request bodies are not supported'),
          );
        }
      }
      index += parsed.consumed;
      continue;
    }
    if (option === '--url') {
      const parsed = optionValue(tokens, index, inlineValue, errors);
      if (parsed.value && explicitUrlToken === undefined) explicitUrlToken = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (
      option === '-F'
      || option === '--form'
      || (option.startsWith('-F') && option !== '-F')
    ) {
      addError(errors, message('CURL_FORM_UNSUPPORTED', 'cURL form syntax is not supported'));
      const attached = option.startsWith('-F') && option !== '-F' ? option.slice(2) : inlineValue;
      if (attached === undefined && tokens[index + 1] !== undefined) index += 1;
      continue;
    }
    if (
      option === '-T'
      || option === '--upload-file'
      || (option.startsWith('-T') && option !== '-T')
    ) {
      addError(
        errors,
        message('CURL_FILE_BODY_UNSUPPORTED', 'File-backed cURL request bodies are not supported'),
      );
      const attached = option.startsWith('-T') && option !== '-T' ? option.slice(2) : inlineValue;
      if (attached === undefined && tokens[index + 1] !== undefined) index += 1;
      continue;
    }
    if (token.value.startsWith('-')) {
      addError(errors, message('CURL_OPTION_UNSUPPORTED', 'A cURL option is not supported'));
      const arity = REJECTED_OPTION_ARITY.get(option);
      if (inlineValue === undefined && arity === 1 && tokens[index + 1] !== undefined) index += 1;
      if (arity === undefined) allowPositionalInference = false;
      continue;
    }
    if (allowPositionalInference && positionalUrlToken === undefined) positionalUrlToken = token;
  }

  const method = normalizeMethod(explicitMethod ?? (dataTokens.length > 0 ? 'POST' : 'GET'));
  member.supportedMethod = SUPPORTED_METHODS.has(method);
  if (!member.supportedMethod) {
    addError(
      errors,
      message('IMPORT_METHOD_UNSUPPORTED', 'The cURL request method is not supported'),
    );
  }

  const hasFileBody = errors.some(error => error.code === 'CURL_FILE_BODY_UNSUPPORTED');
  const bodyBytes = dataTokens.length > 0 && !hasFileBody
    ? Buffer.from(dataTokens.map(data => data.value).join('&'))
    : undefined;
  const requestBase = {
    query: [],
    headers,
    ...(bodyBytes === undefined ? {} : {
      body: {
        mediaType: headers.find(field => field.name.toLowerCase() === 'content-type')?.value,
        byteCount: bodyBytes.length,
        omitted: true as const,
      },
    }),
  };
  const urlToken = explicitUrlToken ?? positionalUrlToken;
  if (!urlToken) {
    addError(errors, message('CURL_URL_MISSING', 'The cURL command does not contain a request URL'));
    member.request = redactRequestSummary(requestBase);
    return member;
  }
  if (/\$(?!\()/.test(urlToken.value)) {
    addError(
      errors,
      message('CURL_DYNAMIC_URL_UNSUPPORTED', 'Dynamic cURL request URLs are not supported'),
    );
    member.request = redactRequestSummary(requestBase);
    return member;
  }

  const sourcePort = extractExplicitSourcePort(urlToken.value);
  let url: URL;
  try {
    url = new URL(urlToken.value);
  } catch {
    addError(errors, message('CURL_URL_INVALID', 'The cURL request URL is invalid'));
    member.request = redactRequestSummary(requestBase);
    return member;
  }

  const origin = normalizeHttpOrigin(`${url.protocol}//${url.host}`);
  const parsedQuery = parseRawQuery(authoredRawQuery(urlToken.value));
  if (!parsedQuery.ok) {
    addError(errors, message(
      'IMPORT_QUERY_INVALID',
      'The cURL request query contains invalid encoding',
    ));
  } else {
    const query = exactQueryConstraints(parsedQuery.entries);
    member.canonicalRequest = {
      baseUrl: origin.origin,
      matcher: {
        method,
        path: normalizePath(url.pathname),
        ...(query === undefined ? {} : { query }),
      },
    };
  }
  member.request = redactRequestSummary({
    scheme: url.protocol.slice(0, -1),
    hostname: origin.hostname,
    ...(sourcePort ? { port: sourcePort } : {}),
    ...(url.username || url.password ? { userInfo: '[PRESENT]' } : {}),
    query: parsedQuery.ok ? parsedQuery.entries : [],
    headers,
    ...(bodyBytes === undefined ? {} : {
      body: {
        mediaType: headers.find(field => field.name.toLowerCase() === 'content-type')?.value,
        byteCount: bodyBytes.length,
        omitted: true,
      },
    }),
  });
  return member;
}

export function parseCurlSource(text: string): ParsedImportSource {
  const commands = tokenizeCommands(text);
  if (!commands.some(command => command.tokens[0]?.value.toLowerCase() === 'curl')) {
    throw sourceError('IMPORT_SOURCE_INVALID', 'The import source does not contain a cURL command');
  }
  return {
    sourceType: 'curl',
    members: commands.map(parseCommand),
    warnings: [],
  };
}
