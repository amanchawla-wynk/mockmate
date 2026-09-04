/**
 * MockMate Server Entry Point
 * Starts both HTTP and HTTPS servers
 */

import { startServers, type ServerRuntimeOwner } from './app';
import { createProcessTrafficContext, createRuntime } from './runtime/create-runtime';
import { getStorageConfig, readConfig } from './services/storage';
import open from 'open';

/**
 * Main entry point
 */
interface SignalProcess {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exitCode?: string | number;
}

export function installSignalShutdown(
  owner: Pick<ServerRuntimeOwner, 'close'>,
  processLike: SignalProcess = process,
): void {
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= owner.close().then(
      () => { processLike.exitCode = 0; },
      error => {
        console.error('Failed to close server:', error);
        processLike.exitCode = 1;
      },
    );
  };
  processLike.once('SIGTERM', close);
  processLike.once('SIGINT', close);
}

export async function main() {
  try {
    // Read server configuration
    const config = readConfig();
    const httpPort = config.server?.httpPort ?? 3456;
    const httpsPort = config.server?.httpsPort ?? 3457;
    const proxyPort = config.server?.proxyPort ?? 8888;

    const runtime = await createRuntime({
      rootDirectory: getStorageConfig().baseDir,
      processTraffic: createProcessTrafficContext(),
      isAdminRequestLocal: request => request.socket.remoteAddress === '127.0.0.1'
        || request.socket.remoteAddress === '::1'
        || request.socket.remoteAddress === '::ffff:127.0.0.1',
    });
    const owner = await startServers({
      runtime,
      requestedPorts: { http: httpPort, https: httpsPort, proxy: proxyPort },
      certificateDirectory: getStorageConfig().certsDir,
    });
    installSignalShutdown(owner);

    // Auto-open browser (only if not in production)
    if (process.env.NODE_ENV !== 'production') {
      try {
        await open(`http://localhost:${owner.ports.http}`);
        console.log('✓ Browser opened automatically\n');
      } catch (error) {
        console.log('ℹ Could not open browser automatically\n');
      }
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
