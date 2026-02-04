/**
 * MockMate Server Entry Point
 * Starts both HTTP and HTTPS servers
 */

import { startServers } from './app';
import { readConfig } from './services/storage';
import open from 'open';

/**
 * Main entry point
 */
async function main() {
  try {
    // Read server configuration
    const config = readConfig();
    const httpPort = config.server?.httpPort || 3456;
    const httpsPort = config.server?.httpsPort || 3457;

    // Start both HTTP and HTTPS servers
    await startServers({ http: httpPort, https: httpsPort });

    // Auto-open browser (only if not in production)
    if (process.env.NODE_ENV !== 'production') {
      try {
        await open(`http://localhost:${httpPort}`);
        console.log('✓ Browser opened automatically\n');
      } catch (error) {
        console.log('ℹ Could not open browser automatically\n');
      }
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start the server
main();
