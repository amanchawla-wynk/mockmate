import { createHash } from 'node:crypto';
import { PassThrough, Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
} from 'node:zlib';

export class ContentEncodingDecodeError extends Error {
  readonly code = 'CONTENT_ENCODING_DECODE_FAILED' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContentEncodingDecodeError';
  }
}

type SupportedCoding = 'gzip' | 'deflate' | 'br';
type ZlibDecoder = Gunzip | Inflate | BrotliDecompress;

function parseCodings(encoding: string | undefined): SupportedCoding[] {
  if (encoding === undefined || encoding.trim() === '') return [];
  const parts = encoding.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  const codings: SupportedCoding[] = [];
  for (const part of parts) {
    if (part === 'identity') continue;
    if (part === 'gzip' || part === 'x-gzip') {
      codings.push('gzip');
      continue;
    }
    if (part === 'deflate') {
      codings.push('deflate');
      continue;
    }
    if (part === 'br') {
      codings.push('br');
      continue;
    }
    throw new ContentEncodingDecodeError(`Unsupported content encoding: ${part}`);
  }
  return codings;
}

function decodeOneSync(coding: SupportedCoding, bytes: Buffer): Buffer {
  try {
    switch (coding) {
      case 'gzip':
        return Buffer.from(gunzipSync(bytes));
      case 'deflate':
        return Buffer.from(inflateSync(bytes));
      case 'br':
        return Buffer.from(brotliDecompressSync(bytes));
    }
  } catch (error) {
    throw new ContentEncodingDecodeError(`Failed to decode ${coding} content`, { cause: error });
  }
}

/** Decode full entity bytes. Wire codings apply in list order; inflate in reverse. */
export function decodeEntityBuffer(
  bytes: Uint8Array,
  encoding: string | undefined,
): Buffer {
  const codings = parseCodings(encoding);
  if (codings.length === 0) return Buffer.from(bytes);
  let current: Buffer = Buffer.from(bytes);
  for (const coding of [...codings].reverse()) {
    current = decodeOneSync(coding, current);
  }
  return current;
}

type PipelineStream = NodeJS.ReadableStream | NodeJS.WritableStream | NodeJS.ReadWriteStream;

function pipelineStreams(streams: PipelineStream[]): Promise<void> {
  return pipeline(streams as [
    NodeJS.ReadableStream,
    ...NodeJS.ReadWriteStream[],
    NodeJS.WritableStream,
  ]);
}

function createCodingStream(coding: SupportedCoding): ZlibDecoder {
  switch (coding) {
    case 'gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
  }
}

export interface PreviewContentDecoder {
  /** Feed encoded entity chunk (also retains a bounded encoded fallback prefix). */
  write(chunk: Uint8Array): void;
  /**
   * Finish the encoded stream and resolve bounded decoded preview bytes.
   * On failure, `ok` is false and `encodedFallback` holds the encoded prefix for base64 preview.
   */
  finish(): Promise<
    | { ok: true; decoded: Buffer; truncated: boolean }
    | { ok: false; encodedFallback: Buffer; error: ContentEncodingDecodeError }
  >;
}

/**
 * Observes encoded entity chunks and produces up to `previewBytes` of decoded output.
 * Encoded bytes are always fully fed into the inflater so gzip/br streams can complete;
 * only the decoded preview buffer is capped.
 */
export function createPreviewContentDecoder(
  encoding: string | undefined,
  previewBytes: number,
): PreviewContentDecoder {
  let codings: SupportedCoding[];
  try {
    codings = parseCodings(encoding);
  } catch (error) {
    const decodeError = error instanceof ContentEncodingDecodeError
      ? error
      : new ContentEncodingDecodeError('Invalid content encoding', { cause: error });
    const encodedFallback: Buffer[] = [];
    let encodedBytes = 0;
    return {
      write(chunk) {
        if (encodedBytes >= previewBytes) return;
        const copy = Buffer.from(chunk).subarray(0, previewBytes - encodedBytes);
        encodedFallback.push(copy);
        encodedBytes += copy.byteLength;
      },
      async finish() {
        return {
          ok: false,
          encodedFallback: Buffer.concat(encodedFallback, encodedBytes),
          error: decodeError,
        };
      },
    };
  }

  const encodedFallback: Buffer[] = [];
  let encodedFallbackBytes = 0;
  const retainFallback = (chunk: Uint8Array) => {
    if (encodedFallbackBytes >= previewBytes) return;
    const copy = Buffer.from(chunk).subarray(0, previewBytes - encodedFallbackBytes);
    encodedFallback.push(copy);
    encodedFallbackBytes += copy.byteLength;
  };

  if (codings.length === 0) {
    const decoded: Buffer[] = [];
    let decodedBytes = 0;
    let sawMore = false;
    return {
      write(chunk) {
        retainFallback(chunk);
        if (decodedBytes >= previewBytes) {
          if (chunk.byteLength > 0) sawMore = true;
          return;
        }
        const copy = Buffer.from(chunk);
        if (decodedBytes + copy.byteLength > previewBytes) {
          decoded.push(copy.subarray(0, previewBytes - decodedBytes));
          decodedBytes = previewBytes;
          sawMore = copy.byteLength > previewBytes - decodedBytes || sawMore;
          return;
        }
        decoded.push(copy);
        decodedBytes += copy.byteLength;
      },
      async finish() {
        return {
          ok: true,
          decoded: Buffer.concat(decoded, decodedBytes),
          truncated: sawMore || decodedBytes >= previewBytes && encodedFallbackBytes > decodedBytes,
        };
      },
    };
  }

  const input = new PassThrough();
  const decoded: Buffer[] = [];
  let decodedBytes = 0;
  let truncated = false;
  let writeFailed: ContentEncodingDecodeError | undefined;

  const collector = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, callback: TransformCallback) {
      if (decodedBytes >= previewBytes) {
        truncated = true;
        callback();
        return;
      }
      const remaining = previewBytes - decodedBytes;
      if (chunk.byteLength > remaining) {
        decoded.push(Buffer.from(chunk.subarray(0, remaining)));
        decodedBytes = previewBytes;
        truncated = true;
      } else {
        decoded.push(Buffer.from(chunk));
        decodedBytes += chunk.byteLength;
      }
      callback();
    },
  });

  const decompressors = [...codings].reverse().map(createCodingStream);
  const pipelineDone = pipelineStreams([input, ...decompressors, collector]).then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof Error)) {
        writeFailed = new ContentEncodingDecodeError('Failed to decode content encoding', { cause: error });
        return;
      }
      writeFailed = error instanceof ContentEncodingDecodeError
        ? error
        : new ContentEncodingDecodeError('Failed to decode content encoding', { cause: error });
    },
  );

  return {
    write(chunk) {
      retainFallback(chunk);
      if (writeFailed !== undefined) return;
      try {
        if (!input.write(Buffer.from(chunk))) {
          // Backpressure is ignored for preview; PassThrough buffers in memory.
        }
      } catch (error) {
        writeFailed = new ContentEncodingDecodeError('Failed to decode content encoding', { cause: error });
      }
    },
    async finish() {
      try {
        input.end();
      } catch (error) {
        writeFailed = new ContentEncodingDecodeError('Failed to decode content encoding', { cause: error });
      }
      await pipelineDone;
      if (writeFailed !== undefined) {
        return {
          ok: false,
          encodedFallback: Buffer.concat(encodedFallback, encodedFallbackBytes),
          error: writeFailed,
        };
      }
      return {
        ok: true,
        decoded: Buffer.concat(decoded, decodedBytes),
        truncated: truncated || decodedBytes >= previewBytes,
      };
    },
  };
}

/** Decode a full encoded readable; enforce maxDecodedBytes on inflated output. */
export async function decodeEntityStream(
  source: Readable,
  encoding: string | undefined,
  maxDecodedBytes: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  const codings = parseCodings(encoding);
  const chunks: Buffer[] = [];
  let total = 0;

  // Terminal sink: collect decoded bytes without emitting downstream. Emitting to
  // the readable side (as a Transform) would buffer unconsumed output and stall the
  // pipeline via backpressure once it reaches the default 16 KiB highWaterMark.
  const limiter = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, callback: (error?: Error | null) => void) {
      total += chunk.byteLength;
      if (total > maxDecodedBytes) {
        callback(new ContentEncodingDecodeError(
          `Decoded body exceeds ${maxDecodedBytes} bytes`,
        ));
        return;
      }
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  try {
    if (codings.length === 0) {
      await pipeline(source, limiter);
    } else {
      const decompressors = [...codings].reverse().map(createCodingStream);
      await pipelineStreams([source, ...decompressors, limiter]);
    }
  } catch (error) {
    if (error instanceof ContentEncodingDecodeError) throw error;
    throw new ContentEncodingDecodeError('Failed to decode content-encoded body', { cause: error });
  }

  const bytes = Buffer.concat(chunks, total);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
