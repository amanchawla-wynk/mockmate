import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface FileSystem {
  open(path: string, flags: string | number, mode?: number, signal?: AbortSignal): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  rmdir(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readdir(path: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
  stat(path: string): Promise<fs.Stats>;
  lstat(path: string): Promise<fs.Stats>;
  createReadStream(path: string, options?: { start?: number; end?: number }): fs.ReadStream;
}

export const nodeFileSystem: FileSystem = {
  async open(filePath, flags, mode, signal) {
    if (signal?.aborted) throw signal.reason;
    const handle = await fs.promises.open(filePath, flags, mode);
    if (!signal?.aborted) return handle;
    await handle.close().catch(() => undefined);
    throw signal.reason;
  },
  rename: (from, to) => fs.promises.rename(from, to),
  link: (existingPath, newPath) => fs.promises.link(existingPath, newPath),
  unlink: filePath => fs.promises.unlink(filePath),
  rm: (filePath, options) => fs.promises.rm(filePath, options),
  rmdir: directory => fs.promises.rmdir(directory),
  mkdir: (directory, options) => fs.promises.mkdir(directory, options),
  readdir: (directory, options) => fs.promises.readdir(directory, options),
  stat: filePath => fs.promises.stat(filePath),
  lstat: filePath => fs.promises.lstat(filePath),
  createReadStream: (filePath, options) => fs.createReadStream(filePath, options),
};
