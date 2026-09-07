import { describe, expect, it } from 'vitest';

import {
  TRAFFIC_CAPTURE_REPRESENTATION,
  TRAFFIC_LIMITS,
  TrafficBodyDescriptorSchema,
  createTrafficPreview,
  type TrafficBodyDescriptor,
  type TrafficSummary,
} from './traffic';

const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('Traffic public contracts', () => {
  it('uses the exact capture representation and budget defaults', () => {
    expect(TRAFFIC_CAPTURE_REPRESENTATION)
      .toBe('http_entity_bytes_after_transfer_framing_before_content_encoding_decoding');
    expect(TRAFFIC_LIMITS).toEqual({
      rowsPerProject: 500,
      previewBytes: 1 * 1024 * 1024,
      bodyBytes: Number.MAX_SAFE_INTEGER - 1,
      sidecarQueueBytes: 256 * 1024 * 1024,
      projectActiveSidecars: 32,
      projectQueuedBytes: 512 * 1024 * 1024,
      processActiveSidecars: 128,
      processQueuedBytes: 1 * 1024 ** 3,
      projectTemporaryBytes: 1 * 1024 ** 3,
      processTemporaryBytes: 2 * 1024 ** 3,
      projectRetainedBytes: 1 * 1024 ** 3,
      processRetainedBytes: 4 * 1024 ** 3,
    });
    expect(Object.isFrozen(TRAFFIC_LIMITS)).toBe(true);
  });

  it('accepts only legal strict body descriptor members', () => {
    expect(TrafficBodyDescriptorSchema.parse({
      side: 'response',
      state: 'available',
      observedSize: 0,
      retainedSize: 0,
      sha256: emptySha256,
    })).toBeTruthy();
    expect(TrafficBodyDescriptorSchema.safeParse({
      side: 'request',
      state: 'unavailable',
      observedSize: 4,
      retainedSize: 4,
      sha256: '0'.repeat(64),
      reason: 'capture_io_failed',
    }).success).toBe(false);
    expect(TrafficBodyDescriptorSchema.parse({
      side: 'response',
      state: 'truncated',
      observedSize: 2,
      reason: 'body_limit_exceeded',
    })).toMatchObject({ state: 'truncated', observedSize: 2 });
    expect(TrafficBodyDescriptorSchema.safeParse({
      side: 'response',
      state: 'truncated',
      observedSize: 0,
      reason: 'body_limit_exceeded',
    }).success).toBe(false);
  });

  it.each([
    ['negative size', { side: 'request', state: 'available', observedSize: -1, retainedSize: -1, sha256: emptySha256 }],
    ['fractional size', { side: 'request', state: 'available', observedSize: 1.5, retainedSize: 1.5, sha256: emptySha256 }],
    ['unsafe size', { side: 'request', state: 'available', observedSize: Number.MAX_SAFE_INTEGER + 1, retainedSize: Number.MAX_SAFE_INTEGER + 1, sha256: emptySha256 }],
    ['unequal retained size', { side: 'request', state: 'available', observedSize: 2, retainedSize: 1, sha256: emptySha256 }],
    ['uppercase digest', { side: 'request', state: 'available', observedSize: 0, retainedSize: 0, sha256: 'A'.repeat(64) }],
    ['unknown key', { side: 'request', state: 'unavailable', observedSize: 0, reason: 'body_unobservable', body: 'unsafe' }],
  ])('rejects a descriptor with %s', (_name, descriptor) => {
    expect(TrafficBodyDescriptorSchema.safeParse(descriptor).success).toBe(false);
  });

  it('requires evicted descriptors to preserve equal observed and retained evidence sizes', () => {
    const descriptor: TrafficBodyDescriptor = {
      side: 'response',
      state: 'evicted',
      observedSize: 12,
      retainedSize: 12,
      sha256: 'a'.repeat(64),
      reason: 'retention_evicted',
    };

    expect(TrafficBodyDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(TrafficBodyDescriptorSchema.safeParse({ ...descriptor, retainedSize: 11 }).success)
      .toBe(false);
  });

  it('keeps summaries free of query values, headers, and previews', () => {
    const summary: TrafficSummary = {
      id: 'traffic_1',
      generation: 'generation_1',
      projectId: 'project_1',
      requestId: 'request_1',
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:00.001Z',
      durationMs: 1,
      transport: 'https_mitm',
      allowlistPattern: '*.example.test',
      origin: 'https://api.example.test',
      method: 'GET',
      path: '/users',
      queryNames: [{ name: 'token', occurrenceCount: 2, sensitive: true }],
      decision: 'no_match_passthrough',
      status: 200,
      responseBytes: 0,
      requestBodyState: 'unavailable',
      responseBodyState: 'available',
    };
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain('queryValue');
    expect(summary).not.toHaveProperty('headers');
    expect(summary).not.toHaveProperty('preview');
    expect(summary.queryNames).toEqual([
      { name: 'token', occurrenceCount: 2, sensitive: true },
    ]);
  });

  it.each(['available', 'truncated', 'unavailable'] as const)(
    'bounds UTF-8 and base64 previews independently for %s descriptors',
    state => {
      const descriptor = state === 'available'
        ? {
          side: 'response' as const,
          state,
          observedSize: TRAFFIC_LIMITS.previewBytes + 1,
          retainedSize: TRAFFIC_LIMITS.previewBytes + 1,
          sha256: 'b'.repeat(64),
        }
        : state === 'truncated'
          ? {
            side: 'response' as const,
            state,
            observedSize: TRAFFIC_LIMITS.bodyBytes + 1,
            reason: 'body_limit_exceeded' as const,
          }
          : {
            side: 'response' as const,
            state,
            observedSize: TRAFFIC_LIMITS.previewBytes + 1,
            reason: 'capture_io_failed' as const,
          };
      const exactText = Buffer.from('x'.repeat(TRAFFIC_LIMITS.previewBytes));
      const longerText = Buffer.concat([exactText, Buffer.from('y')]);
      const exactBinary = Buffer.alloc(TRAFFIC_LIMITS.previewBytes, 0xff);
      const longerBinary = Buffer.alloc(TRAFFIC_LIMITS.previewBytes + 1, 0xff);

      expect(createTrafficPreview(exactText, descriptor, 'text/plain')).toEqual({
        encoding: 'utf8',
        value: 'x'.repeat(TRAFFIC_LIMITS.previewBytes),
        truncated: false,
      });
      expect(createTrafficPreview(longerText, descriptor, 'text/plain')).toMatchObject({
        encoding: 'utf8',
        value: 'x'.repeat(TRAFFIC_LIMITS.previewBytes),
        truncated: true,
      });
      const exactBase64 = createTrafficPreview(exactBinary, descriptor, 'application/octet-stream');
      const longerBase64 = createTrafficPreview(longerBinary, descriptor, 'application/octet-stream');
      expect(exactBase64).toMatchObject({ encoding: 'base64', truncated: false });
      expect(Buffer.from(exactBase64.value, 'base64')).toHaveLength(TRAFFIC_LIMITS.previewBytes);
      expect(longerBase64).toMatchObject({ encoding: 'base64', truncated: true });
      expect(Buffer.from(longerBase64.value, 'base64')).toHaveLength(TRAFFIC_LIMITS.previewBytes);
    },
  );

  it('does not split a UTF-8 code point at the preview boundary', () => {
    const descriptor: TrafficBodyDescriptor = {
      side: 'request',
      state: 'unavailable',
      observedSize: TRAFFIC_LIMITS.previewBytes + 3,
      reason: 'raw_capture_disabled',
    };
    const bytes = Buffer.from(`${'x'.repeat(TRAFFIC_LIMITS.previewBytes - 1)}😀`);
    const preview = createTrafficPreview(bytes, descriptor, 'text/plain');

    expect(preview.encoding).toBe('utf8');
    expect(Buffer.byteLength(preview.value, 'utf8')).toBe(TRAFFIC_LIMITS.previewBytes - 1);
    expect(preview.value).not.toContain('�');
    expect(preview.truncated).toBe(true);
  });

  it('falls back to bounded base64 when text media contains invalid UTF-8', () => {
    const descriptor: TrafficBodyDescriptor = {
      side: 'response',
      state: 'available',
      mediaType: 'text/plain',
      observedSize: TRAFFIC_LIMITS.previewBytes,
      retainedSize: TRAFFIC_LIMITS.previewBytes,
      sha256: 'c'.repeat(64),
    };
    const exact = createTrafficPreview(
      Buffer.alloc(TRAFFIC_LIMITS.previewBytes, 0xff),
      descriptor,
    );
    const longer = createTrafficPreview(
      Buffer.alloc(TRAFFIC_LIMITS.previewBytes + 1, 0xff),
      descriptor,
    );

    expect(exact.encoding).toBe('base64');
    expect(Buffer.from(exact.value, 'base64')).toHaveLength(TRAFFIC_LIMITS.previewBytes);
    expect(exact.truncated).toBe(false);
    expect(longer.encoding).toBe('base64');
    expect(Buffer.from(longer.value, 'base64')).toHaveLength(TRAFFIC_LIMITS.previewBytes);
    expect(longer.truncated).toBe(true);
  });

  it('falls back to base64 for an exact-boundary body ending in incomplete UTF-8', () => {
    const descriptor: TrafficBodyDescriptor = {
      side: 'response',
      state: 'available',
      mediaType: 'text/plain',
      observedSize: TRAFFIC_LIMITS.previewBytes,
      retainedSize: TRAFFIC_LIMITS.previewBytes,
      sha256: 'd'.repeat(64),
    };
    const bytes = Buffer.concat([
      Buffer.alloc(TRAFFIC_LIMITS.previewBytes - 1, 'x'),
      Buffer.from([0xc2]),
    ]);

    const preview = createTrafficPreview(bytes, descriptor);

    expect(preview.encoding).toBe('base64');
    expect(Buffer.from(preview.value, 'base64')).toEqual(bytes);
    expect(preview.truncated).toBe(false);
  });
});
