/**
 * Express application setup
 * Configures the MockMate server with routes and middleware
 * Supports both HTTP and HTTPS servers
 */

import express, { type Application } from 'express';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import cors from 'cors';
import adminRouter from './routes/admin';
import setupRouter from './routes/setup';
import { mockRequestHandler } from './routes/mock';
import { initializeStorage } from './services/storage';
import { ensureCertificates } from './services/certs';
import { getLocalIPAddresses } from './services/network';

export interface ServerPorts {
  http: number;
  https: number;
}

export interface ServerInstances {
  httpServer: http.Server;
  httpsServer: https.Server;
  app: Application;
}

/**
 * Create and configure Express application
 */
export function createApp(): Application {
  const app = express();

  // Initialize storage on app creation
  initializeStorage();

  // ============================================================================
  // Middleware
  // ============================================================================

  // Parse JSON bodies
  app.use(express.json());

  // Enable CORS for all origins (mock server should be accessible from anywhere)
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-MockMate-Scenario', 'Authorization'],
      exposedHeaders: ['Content-Type'],
      credentials: false,
    })
  );

  // ============================================================================
  // Admin API Routes
  // ============================================================================

  // Mount admin router on /api/admin prefix
  app.use('/api/admin', adminRouter);

  // ============================================================================
  // Device Setup Routes
  // ============================================================================

  // Mount setup router on /setup prefix
  app.use('/setup', setupRouter);

  // ============================================================================
  // Health Check
  // ============================================================================

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // ============================================================================
  // Dashboard Static Files
  // ============================================================================

  // Serve dashboard static files from dist/public
  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));

    // Serve index.html for all non-API/non-setup routes (SPA routing)
    app.get('*', (req, res, next) => {
      // Let API and setup routes pass through
      if (req.path.startsWith('/api') || req.path.startsWith('/setup') || req.path === '/health') {
        next();
      } else {
        // Serve dashboard for all other routes
        res.sendFile(path.join(publicDir, 'index.html'));
      }
    });
  }

  // ============================================================================
  // Mock API Handler (Catch-all)
  // ============================================================================

  // This must be last! It catches all remaining routes
  // Handle all HTTP methods for mock API
  app.all('*', mockRequestHandler);

  return app;
}

/**
 * Start both HTTP and HTTPS servers
 * @param ports - Port configuration for HTTP and HTTPS
 * @returns Promise resolving to server instances
 */
export async function startServers(
  ports: ServerPorts = { http: 3456, https: 3457 }
): Promise<ServerInstances> {
  const app = createApp();

  // Get local IP addresses for certificate SANs
  const localIPs = getLocalIPAddresses();

  // Ensure certificates exist (generate or load)
  const certs = await ensureCertificates(localIPs);

  // Create HTTP server
  const httpServer = http.createServer(app);

  // Create HTTPS server with certificates
  const httpsServer = https.createServer(
    {
      key: certs.server.privateKey,
      cert: certs.server.cert,
    },
    app
  );

  // Start HTTP server
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(ports.http, () => {
      resolve();
    });
    httpServer.on('error', reject);
  });

  // Start HTTPS server
  await new Promise<void>((resolve, reject) => {
    httpsServer.listen(ports.https, () => {
      resolve();
    });
    httpsServer.on('error', reject);
  });

  // Log server information
  logServerInfo(ports, localIPs);

  return {
    httpServer,
    httpsServer,
    app,
  };
}

/**
 * Log server startup information
 */
function logServerInfo(ports: ServerPorts, localIPs: string[]): void {
  console.log('');
  console.log('🚀 MockMate Server Started');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // HTTP URLs
  console.log('📡 HTTP Server:');
  console.log(`   http://localhost:${ports.http}`);
  for (const ip of localIPs) {
    console.log(`   http://${ip}:${ports.http}`);
  }
  console.log('');

  // HTTPS URLs
  console.log('🔒 HTTPS Server (for physical devices):');
  console.log(`   https://localhost:${ports.https}`);
  for (const ip of localIPs) {
    console.log(`   https://${ip}:${ports.https}`);
  }
  console.log('');

  // Device Setup
  const primaryIP = localIPs[0] || 'localhost';
  console.log('📲 Device Setup:');
  console.log(`   http://${primaryIP}:${ports.http}/setup`);
  console.log('');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('💡 Quick Start:');
  console.log('   1. Open the dashboard (will open automatically)');
  console.log('   2. Create a project');
  console.log('   3. Add resources with scenarios');
  console.log('   4. Point your app to the mock server');
  console.log('');
  console.log('💡 Tips:');
  console.log('   • Use HTTP for simulator/emulator testing');
  console.log('   • Use HTTPS for physical device testing');
  console.log('   • Visit setup page to install certificates on devices');
  console.log('   • Use X-MockMate-Scenario header to override scenarios');
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use startServers() instead
 */
export function startServer(port: number = 3456): Promise<any> {
  const app = createApp();

  return new Promise((resolve, reject) => {
    try {
      const server = app.listen(port, () => {
        console.log('');
        console.log('🚀 MockMate Server Started');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📡 Mock API:  http://localhost:${port}`);
        console.log(`⚙️  Admin API: http://localhost:${port}/api/admin`);
        console.log(`💚 Health:    http://localhost:${port}/health`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('💡 Tip: Use X-MockMate-Scenario header to override scenarios');
        console.log('');

        resolve(server);
      });

      server.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
}
