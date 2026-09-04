import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  ContentEncodingDecodeError,
  createPreviewContentDecoder,
  decodeEntityBuffer,
  decodeEntityStream,
} from './content-encoding-decode';

describe('decodeEntityBuffer', () => {
  it('returns identity bytes when encoding is absent', () => {
    const bytes = Buffer.from('{"ok":true}');
    expect(decodeEntityBuffer(bytes, undefined)).toEqual(bytes);
  });

  it('decodes gzip', () => {
    const plain = Buffer.from('{"hello":"world"}');
    expect(decodeEntityBuffer(gzipSync(plain), 'gzip')).toEqual(plain);
  });

  it('decodes deflate and br', () => {
    const plain = Buffer.from('<xml/>');
    expect(decodeEntityBuffer(deflateSync(plain), 'deflate')).toEqual(plain);
    expect(decodeEntityBuffer(brotliCompressSync(plain), 'br')).toEqual(plain);
  });

  it('decodes multi-coding chains in reverse wire order', () => {
    const plain = Buffer.from('{"n":1}');
    const gzipped = gzipSync(plain);
    const chain = brotliCompressSync(gzipped);
    expect(decodeEntityBuffer(chain, 'gzip, br')).toEqual(plain);
  });

  it('rejects unsupported and corrupt encodings', () => {
    expect(() => decodeEntityBuffer(Buffer.from('x'), 'compress')).toThrow(ContentEncodingDecodeError);
    expect(() => decodeEntityBuffer(Buffer.from('not-gzip'), 'gzip')).toThrow(ContentEncodingDecodeError);
  });
});

describe('createPreviewContentDecoder', () => {
  it('passthrough without encoding', async () => {
    const decoder = createPreviewContentDecoder(undefined, 16 * 1024);
    decoder.write(Buffer.from('ab'));
    decoder.write(Buffer.from('cd'));
    const result = await decoder.finish();
    expect(result).toMatchObject({ ok: true, decoded: Buffer.from('abcd') });
  });

  it('stream-decodes gzip across chunks into utf8 preview bytes', async () => {
    const plain = Buffer.from('{"stream":true,"pad":"' + 'x'.repeat(200) + '"}');
    const encoded = gzipSync(plain);
    const decoder = createPreviewContentDecoder('gzip', 16 * 1024);
    const mid = Math.floor(encoded.byteLength / 2);
    decoder.write(encoded.subarray(0, mid));
    decoder.write(encoded.subarray(mid));
    const result = await decoder.finish();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decoded).toEqual(plain);
  });

  it('decodes multi-coding chains', async () => {
    const plain = Buffer.from('{"chain":true}');
    const encoded = brotliCompressSync(gzipSync(plain));
    const decoder = createPreviewContentDecoder('gzip, br', 1024);
    decoder.write(encoded);
    const result = await decoder.finish();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decoded).toEqual(plain);
  });

  it('caps decoded preview bytes and marks truncated', async () => {
    const plain = Buffer.from('x'.repeat(1000));
    const encoded = gzipSync(plain);
    const decoder = createPreviewContentDecoder('gzip', 100);
    decoder.write(encoded);
    const result = await decoder.finish();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decoded.byteLength).toBe(100);
      expect(result.truncated).toBe(true);
    }
  });

  it('falls back with encoded prefix when gzip is corrupt', async () => {
    const decoder = createPreviewContentDecoder('gzip', 1024);
    decoder.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    decoder.write(Buffer.from('corrupt-tail-not-valid-gzip-payload'));
    const result = await decoder.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ContentEncodingDecodeError);
      expect(result.encodedFallback.byteLength).toBeGreaterThan(0);
    }
  });
});

describe('decodeEntityStream', () => {
  it('decodes a gzip readable and hashes plaintext', async () => {
    const plain = Buffer.from('{"exact":true}');
    const encoded = gzipSync(plain);
    const result = await decodeEntityStream(Readable.from([encoded]), 'gzip', 1024);
    expect(result.bytes).toEqual(plain);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects decoded output over the byte cap', async () => {
    const plain = Buffer.alloc(100, 0x61);
    const encoded = gzipSync(plain);
    await expect(decodeEntityStream(Readable.from([encoded]), 'gzip', 50))
      .rejects.toBeInstanceOf(ContentEncodingDecodeError);
  });
});
