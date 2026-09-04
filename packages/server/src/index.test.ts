import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import open from 'open';

vi.mock('open', () => ({ default: vi.fn() }));
vi.mock('./services/storage', () => ({
  getStorageConfig: () => ({ baseDir: '/tmp/mockmate-index-test', certsDir: '/tmp/mockmate-index-test/certs' }),
  readConfig: vi.fn(() => ({ server: { httpPort: 0, httpsPort: 0, proxyPort: 0 } })),
}));
vi.mock('./runtime/create-runtime', () => ({
  createProcessTrafficContext: () => ({}),
  createRuntime: vi.fn(async () => ({ dispose: vi.fn() })),
}));
vi.mock('./app', () => ({
  startServers: vi.fn(async () => ({
    ports: { http: 1, https: 2, proxy: 3 },
    close: vi.fn(async () => undefined),
  })),
}));

import { startServers } from './app';
import { installSignalShutdown, main } from './index';
import { createRuntime } from './runtime/create-runtime';
import { readConfig } from './services/storage';

describe('process lifecycle ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes configured zero for all listener ports and uses assigned ports after startup', async () => {
    vi.mocked(readConfig).mockReturnValue({ server: { httpPort: 0, httpsPort: 0, proxyPort: 0 } });

    await main();

    expect(startServers).toHaveBeenCalledWith(expect.objectContaining({
      requestedPorts: { http: 0, https: 0, proxy: 0 },
    }));
    const runtimeOptions = vi.mocked(createRuntime).mock.calls[0][0];
    expect(runtimeOptions).not.toHaveProperty('upstreamTransport');
    expect(runtimeOptions).not.toHaveProperty('blindTunnelConnector');
    expect(open).toHaveBeenCalledWith('http://localhost:1');
  });

  it('preserves mixed zero and fixed configured listener ports', async () => {
    vi.mocked(readConfig).mockReturnValue({
      server: { httpPort: 0, httpsPort: 7443, proxyPort: 0 },
    });

    await main();

    expect(startServers).toHaveBeenCalledWith(expect.objectContaining({
      requestedPorts: { http: 0, https: 7443, proxy: 0 },
    }));
  });

  it('awaits exactly one owner close across repeated termination signals', async () => {
    const processLike = new EventEmitter() as EventEmitter & { exitCode?: number };
    const close = vi.fn(async () => undefined);
    installSignalShutdown({ close }, processLike);

    processLike.emit('SIGTERM');
    processLike.emit('SIGINT');
    await new Promise(resolve => setImmediate(resolve));

    expect(close).toHaveBeenCalledOnce();
    expect(processLike.exitCode).toBe(0);
  });

  it('sets failure exit status only after asynchronous close rejects', async () => {
    const processLike = new EventEmitter() as EventEmitter & { exitCode?: number };
    let reject!: (error: Error) => void;
    const close = vi.fn(() => new Promise<void>((_resolve, nextReject) => { reject = nextReject; }));
    installSignalShutdown({ close }, processLike);

    processLike.emit('SIGTERM');
    expect(processLike.exitCode).toBeUndefined();
    reject(new Error('cleanup failed'));
    await new Promise(resolve => setImmediate(resolve));

    expect(processLike.exitCode).toBe(1);
  });
});
