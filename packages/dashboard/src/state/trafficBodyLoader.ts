import { Text } from '@codemirror/state';
import type { TrafficBodyDescriptor } from '../api/types';

export type TrafficBodyPresentation =
  | { kind: 'text'; mediaType: string; decoded: boolean }
  | { kind: 'binary'; reason: 'binary_media_type' | 'content_encoded' }
  | { kind: 'blocked'; reason: 'unavailable' | 'truncated' | 'evicted' };

export interface TrafficBodyLoadResult {
  text: Text;
  byteCount: number;
  mediaType: string;
}

export function isTextMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return essence.startsWith('text/')
    || essence === 'application/json'
    || essence.endsWith('+json')
    || essence === 'application/xml'
    || essence.endsWith('+xml')
    || essence === 'application/javascript'
    || essence === 'application/ecmascript'
    || essence === 'application/x-javascript'
    || essence === 'application/x-www-form-urlencoded';
}

export function isJsonMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return essence === 'application/json' || essence.endsWith('+json');
}

export function classifyTrafficBody(input: {
  descriptor: TrafficBodyDescriptor;
}): TrafficBodyPresentation {
  const { descriptor } = input;
  if (descriptor.state !== 'available') {
    return {
      kind: 'blocked',
      reason: descriptor.state,
    };
  }
  if (descriptor.mediaType === undefined || !isTextMediaType(descriptor.mediaType)) {
    if (descriptor.contentEncoding !== undefined) {
      return { kind: 'binary', reason: 'content_encoded' };
    }
    return { kind: 'binary', reason: 'binary_media_type' };
  }
  return {
    kind: 'text',
    mediaType: descriptor.mediaType,
    decoded: descriptor.contentEncoding !== undefined,
  };
}

function abortError(): DOMException {
  return new DOMException('Traffic body load aborted', 'AbortError');
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`Traffic body ${name} header is required`);
  return value;
}

async function hashSha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function loadTrafficTextBody(input: {
  response: Response;
  expected:
    | { view?: 'identity'; sha256: string; byteCount: number; mediaType: string }
    | { view: 'decoded'; mediaType: string };
  signal: AbortSignal;
  onProgress(loadedBytes: number, totalBytes: number): void;
}): Promise<TrafficBodyLoadResult> {
  const contentLengthHeader = requiredHeader(input.response, 'Content-Length');
  if (!/^\d+$/.test(contentLengthHeader)) {
    throw new Error('Traffic body Content-Length is invalid');
  }
  const contentLength = Number(contentLengthHeader);
  const identityExpected = 'sha256' in input.expected ? input.expected : undefined;
  const decodedView = identityExpected === undefined;

  if (decodedView) {
    if (requiredHeader(input.response, 'X-MockMate-View') !== 'decoded') {
      throw new Error('Traffic body decoded view header is required');
    }
    if (requiredHeader(input.response, 'Content-Type') !== input.expected.mediaType) {
      throw new Error('Traffic body Content-Type does not match its descriptor');
    }
  } else {
    if (contentLength !== identityExpected.byteCount) {
      throw new Error('Traffic body Content-Length does not match its descriptor');
    }
    if (requiredHeader(input.response, 'X-MockMate-Sha256') !== identityExpected.sha256) {
      throw new Error('Traffic body SHA-256 does not match its descriptor');
    }
    if (requiredHeader(input.response, 'Content-Type') !== input.expected.mediaType) {
      throw new Error('Traffic body Content-Type does not match its descriptor');
    }
  }

  const expectedSha256 = decodedView
    ? requiredHeader(input.response, 'X-MockMate-Decoded-Sha256')
    : identityExpected.sha256;
  if (decodedView && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Traffic body decoded SHA-256 header is invalid');
  }

  if (input.response.body === null) throw new Error('Traffic body response has no readable stream');
  if (input.signal.aborted) throw abortError();

  const reader = input.response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let lineParts: string[] = [];
  let skipLeadingLf = false;
  let loadedBytes = 0;
  const rawChunks: Uint8Array[] = [];

  const appendDecoded = (value: string) => {
    let start = 0;
    if (skipLeadingLf) {
      if (value.startsWith('\n')) start = 1;
      skipLeadingLf = false;
    }
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (character !== '\n' && character !== '\r') continue;
      lineParts.push(value.slice(start, index));
      lines.push(lineParts.join(''));
      lineParts = [];
      if (character === '\r') {
        if (value[index + 1] === '\n') index += 1;
        else if (index === value.length - 1) skipLeadingLf = true;
      }
      start = index + 1;
    }
    if (start < value.length) lineParts.push(value.slice(start));
  };

  const cancelForAbort = () => {
    void reader.cancel(abortError()).catch(() => undefined);
  };
  input.signal.addEventListener('abort', cancelForAbort, { once: true });

  try {
    while (true) {
      const next = await reader.read();
      if (input.signal.aborted) throw abortError();
      if (next.done) break;
      loadedBytes += next.value.byteLength;
      if (loadedBytes > contentLength) {
        throw new Error('Traffic body stream exceeded its descriptor byte count');
      }
      if (decodedView) rawChunks.push(next.value);
      appendDecoded(decoder.decode(next.value, { stream: true }));
      input.onProgress(loadedBytes, contentLength);
    }
    appendDecoded(decoder.decode());
    if (loadedBytes !== contentLength) {
      throw new Error('Traffic body stream byte count does not match its descriptor');
    }
    if (decodedView) {
      const joined = new Uint8Array(loadedBytes);
      let offset = 0;
      for (const chunk of rawChunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const actual = await hashSha256Hex(joined);
      if (actual !== expectedSha256) {
        throw new Error('Traffic body decoded SHA-256 does not match its header');
      }
    }
    lines.push(lineParts.join(''));
    return {
      text: Text.of(lines),
      byteCount: loadedBytes,
      mediaType: input.expected.mediaType,
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    input.signal.removeEventListener('abort', cancelForAbort);
    reader.releaseLock();
  }
}

export function formatTrafficPreviewText(
  preview: { encoding: 'utf8' | 'base64'; value: string },
  mediaType: string | undefined,
): string {
  if (preview.encoding === 'base64') return `Base64 preview:\n${preview.value}`;
  if (!isJsonMediaType(mediaType)) return preview.value;
  try {
    return JSON.stringify(JSON.parse(preview.value), null, 2);
  } catch {
    return preview.value;
  }
}
