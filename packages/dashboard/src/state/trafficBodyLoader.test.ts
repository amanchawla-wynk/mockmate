import { describe, expect, it, vi } from 'vitest';
import type { TrafficBodyDescriptor } from '../api/types';
import {
  classifyTrafficBody,
  formatTrafficPreviewText,
  loadTrafficTextBody,
} from './trafficBodyLoader';

const digest = 'a'.repeat(64);

function available(
  patch: Partial<Extract<TrafficBodyDescriptor, { state: 'available' }>> = {},
): Extract<TrafficBodyDescriptor, { state: 'available' }> {
  return {
    side: 'response',
    state: 'available',
    mediaType: 'application/json; charset=utf-8',
    observedSize: 4,
    retainedSize: 4,
    sha256: digest,
    ...patch,
  };
}

function streamedResponse(chunks: Uint8Array[], headers: HeadersInit): Response {
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  }), { headers });
}

describe('Traffic body classification', () => {
  it.each([
    ['text/plain', 'text'],
    ['application/json; charset=utf-8', 'text'],
    ['application/problem+json', 'text'],
    ['application/xml', 'text'],
    ['application/soap+xml', 'text'],
    ['application/javascript', 'text'],
    ['application/x-www-form-urlencoded', 'text'],
    ['image/png', 'binary'],
  ] as const)('classifies %s as %s', (mediaType, kind) => {
    expect(classifyTrafficBody({ descriptor: available({ mediaType }) }).kind).toBe(kind);
  });

  it('treats content-encoded text as decoded text and binary encodings as download-only', () => {
    expect(classifyTrafficBody({
      descriptor: available({ contentEncoding: 'gzip' }),
    })).toEqual({
      kind: 'text',
      mediaType: 'application/json; charset=utf-8',
      decoded: true,
    });
    expect(classifyTrafficBody({
      descriptor: available({ mediaType: 'image/png', contentEncoding: 'gzip' }),
    })).toEqual({ kind: 'binary', reason: 'content_encoded' });
    expect(classifyTrafficBody({
      descriptor: available({ mediaType: 'text/plain' }),
    })).toEqual({ kind: 'text', mediaType: 'text/plain', decoded: false });
  });

  it('blocks truncated, evicted, or unavailable bodies', () => {
    expect(classifyTrafficBody({
      descriptor: {
        side: 'request', state: 'truncated', observedSize: 50 * 1024 * 1024 + 1,
        reason: 'body_limit_exceeded',
      },
    })).toEqual({ kind: 'blocked', reason: 'truncated' });
    expect(classifyTrafficBody({
      descriptor: { ...available(), state: 'evicted', reason: 'retention_evicted' },
    } as { descriptor: TrafficBodyDescriptor })).toEqual({ kind: 'blocked', reason: 'evicted' });
    expect(classifyTrafficBody({
      descriptor: { side: 'request', state: 'unavailable', observedSize: 0, reason: 'body_unobservable' },
    })).toEqual({ kind: 'blocked', reason: 'unavailable' });
  });
});

describe('loadTrafficTextBody', () => {
  it('fatally decodes split UTF-8 and reports incremental byte progress without whole-response helpers', async () => {
    const bytes = new TextEncoder().encode('one\nhéllo');
    const response = streamedResponse([
      bytes.slice(0, 6),
      bytes.slice(6, 7),
      bytes.slice(7),
    ], {
      'Content-Type': 'text/plain',
      'Content-Length': String(bytes.byteLength),
      'X-MockMate-Sha256': digest,
    });
    const text = vi.spyOn(response, 'text');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const progress = vi.fn();

    const result = await loadTrafficTextBody({
      response,
      expected: { sha256: digest, byteCount: bytes.byteLength, mediaType: 'text/plain' },
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(result.text.toString()).toBe('one\nhéllo');
    expect(result.byteCount).toBe(bytes.byteLength);
    expect(progress.mock.calls).toEqual([
      [6, bytes.byteLength],
      [7, bytes.byteLength],
      [bytes.byteLength, bytes.byteLength],
    ]);
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects descriptor/header/observed-length disagreement before publication', async () => {
    const make = (headers: HeadersInit, bytes = new Uint8Array([1])) => streamedResponse([bytes], headers);
    const expected = { sha256: digest, byteCount: 1, mediaType: 'text/plain' };
    const signal = new AbortController().signal;
    const onProgress = vi.fn();

    await expect(loadTrafficTextBody({
      response: make({ 'Content-Type': 'text/plain', 'Content-Length': '2', 'X-MockMate-Sha256': digest }),
      expected, signal, onProgress,
    })).rejects.toThrow(/Content-Length/);
    await expect(loadTrafficTextBody({
      response: make({ 'Content-Type': 'text/plain', 'Content-Length': '1', 'X-MockMate-Sha256': 'b'.repeat(64) }),
      expected, signal, onProgress,
    })).rejects.toThrow(/SHA-256/);
    await expect(loadTrafficTextBody({
      response: make({ 'Content-Type': 'application/json', 'Content-Length': '1', 'X-MockMate-Sha256': digest }),
      expected, signal, onProgress,
    })).rejects.toThrow(/Content-Type/);
  });

  it('fatally rejects malformed UTF-8 and cancels the reader', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([0xc3, 0x28])); },
      cancel() { cancelled = true; },
    }), { headers: {
      'Content-Type': 'text/plain', 'Content-Length': '2', 'X-MockMate-Sha256': digest,
    } });

    await expect(loadTrafficTextBody({
      response,
      expected: { sha256: digest, byteCount: 2, mediaType: 'text/plain' },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it('cancels a pending reader when the fetch owner aborts', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { headers: {
      'Content-Type': 'text/plain', 'Content-Length': '1', 'X-MockMate-Sha256': digest,
    } });
    const controller = new AbortController();
    const loading = loadTrafficTextBody({
      response,
      expected: { sha256: digest, byteCount: 1, mediaType: 'text/plain' },
      signal: controller.signal,
      onProgress: vi.fn(),
    });

    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });

  it('validates decoded view headers and digest', async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
    const decodedDigest = [...new Uint8Array(digestBytes)]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const response = streamedResponse([bytes], {
      'Content-Type': 'application/json',
      'Content-Length': String(bytes.byteLength),
      'X-MockMate-View': 'decoded',
      'X-MockMate-Decoded-Sha256': decodedDigest,
    });

    const result = await loadTrafficTextBody({
      response,
      expected: { view: 'decoded', mediaType: 'application/json' },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });
    expect(result.text.toString()).toBe('{\n  "ok": true\n}');
  });

  it('pretty-prints minified JSON bodies while preserving the raw byte count', async () => {
    const bytes = new TextEncoder().encode('{"a":1,"b":[2,3]}');
    const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
    const jsonDigest = [...new Uint8Array(digestBytes)]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const response = streamedResponse([bytes], {
      'Content-Type': 'application/json',
      'Content-Length': String(bytes.byteLength),
      'X-MockMate-Sha256': jsonDigest,
    });

    const result = await loadTrafficTextBody({
      response,
      expected: { sha256: jsonDigest, byteCount: bytes.byteLength, mediaType: 'application/json' },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(result.text.toString()).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(result.byteCount).toBe(bytes.byteLength);
  });

  it('leaves invalid JSON bodies untouched', async () => {
    const bytes = new TextEncoder().encode('{"a":1');
    const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
    const jsonDigest = [...new Uint8Array(digestBytes)]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const response = streamedResponse([bytes], {
      'Content-Type': 'application/json',
      'Content-Length': String(bytes.byteLength),
      'X-MockMate-Sha256': jsonDigest,
    });

    const result = await loadTrafficTextBody({
      response,
      expected: { sha256: jsonDigest, byteCount: bytes.byteLength, mediaType: 'application/json' },
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    });

    expect(result.text.toString()).toBe('{"a":1');
  });
});

describe('formatTrafficPreviewText', () => {
  it('pretty-prints utf8 JSON and leaves invalid JSON or base64 alone', () => {
    expect(formatTrafficPreviewText(
      { encoding: 'utf8', value: '{"a":1}' },
      'application/json',
    )).toBe('{\n  "a": 1\n}');
    expect(formatTrafficPreviewText(
      { encoding: 'utf8', value: '{not-json' },
      'application/json',
    )).toBe('{not-json');
    expect(formatTrafficPreviewText(
      { encoding: 'base64', value: 'YQ==' },
      'application/json',
    )).toBe('Base64 preview:\nYQ==');
  });
});
