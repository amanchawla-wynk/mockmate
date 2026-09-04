import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { FileSystem } from './file-system';

export interface AtomicFileWriter {
  writeJson<T>(destination: string, value: T, options?: AtomicWriteOptions): Promise<void>;
  writeJsonIfAbsent<T>(destination: string, value: T, guard?: AtomicPathGuard): Promise<boolean>;
  writeStream(destination: string, source: NodeJS.ReadableStream, guard?: AtomicPathGuard): Promise<{
    size: number;
    sha256: string;
  }>;
}

export type AtomicPathGuard = () => Promise<void>;

export interface AtomicWriteOptions {
  beforePublish?(): Promise<void>;
}

function siblingTempPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
}

async function closeBestEffort(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the primary operation error.
  }
}

async function unlinkBestEffort(
  fileSystem: FileSystem,
  filePath: string,
  guard?: AtomicPathGuard,
): Promise<void> {
  try {
    await guard?.();
  } catch {
    return;
  }
  try {
    await fileSystem.unlink(filePath);
  } catch {
    // Preserve the primary operation error.
  }
}

export function createAtomicFileWriter(fileSystem: FileSystem): AtomicFileWriter {
  async function writeStream(
    destination: string,
    source: NodeJS.ReadableStream,
    guard?: AtomicPathGuard,
    options?: AtomicWriteOptions,
  ): Promise<{ size: number; sha256: string }> {
    const tempPath = siblingTempPath(destination);
    const hash = createHash('sha256');
    let size = 0;
    let handle: FileHandle | undefined;
    let published = false;

    await fileSystem.mkdir(path.dirname(destination), { recursive: true });

    try {
      await guard?.();
      handle = await fileSystem.open(tempPath, 'wx', 0o600);
      await guard?.();
      for await (const chunk of source as AsyncIterable<Buffer | string | Uint8Array>) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes, offset, bytes.length - offset, null);
          if (result.bytesWritten === 0) throw new Error('Atomic write made no progress');
          offset += result.bytesWritten;
        }
        hash.update(bytes);
        size += bytes.length;
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await guard?.();
      await options?.beforePublish?.();
      await fileSystem.rename(tempPath, destination);
      published = true;
      await guard?.();
      return { size, sha256: hash.digest('hex') };
    } finally {
      if (!published) {
        await closeBestEffort(handle);
        await unlinkBestEffort(fileSystem, tempPath, guard);
      }
    }
  }

  return {
    async writeJson<T>(destination: string, value: T, options?: AtomicWriteOptions): Promise<void> {
      await writeStream(
        destination,
        Readable.from([Buffer.from(JSON.stringify(value))]),
        undefined,
        options,
      );
    },
    async writeJsonIfAbsent<T>(destination: string, value: T, guard?: AtomicPathGuard): Promise<boolean> {
      const candidate = siblingTempPath(destination);
      await writeStream(candidate, Readable.from([Buffer.from(JSON.stringify(value))]), guard);
      try {
        await guard?.();
        await fileSystem.link(candidate, destination);
        await guard?.();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      } finally {
        await unlinkBestEffort(fileSystem, candidate, guard);
      }
    },
    writeStream,
  };
}
