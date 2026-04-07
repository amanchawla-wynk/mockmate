/**
 * Express application setup
 * Configures the MockMate server with routes and middleware
 * Supports both HTTP and HTTPS servers
 */

import express, { type Application } from 'express';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import cors from 'cors';
import adminRouter from './routes/admin';
import { getActiveProject } from './services/projects';
import { getStaticFilesRoot } from './services/fixtures';
import setupRouter from './routes/setup';
import automationRouter from './routes/automation';
import { mockRequestHandler } from './routes/mock';
import { ensureCertificates } from './services/certs';
import { getLocalIPAddresses } from './services/network';
import { createProxyServer } from './services/proxy-server';

export interface ServerPorts {
  http: number;
  https: number;
  proxy: number;
}

export interface ServerInstances {
  httpServer: http.Server;
  httpsServer: https.Server;
  proxyServer: net.Server;
  app: Application;
}

/**
 * Create and configure Express application
 */
export function createApp(): Application {
  const app = express();

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

  // Lightweight automation helpers (XCUITest/Espresso)
  app.use(automationRouter);

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
  // Static File Upload (raw body — must come before express.json middleware)
  // ============================================================================

  // The admin upload endpoint needs raw bytes, not JSON-parsed body.
  // We register it here with express.raw() BEFORE the catch-all json middleware
  // that runs on adminRouter, so the raw body is preserved.
  app.post(
    '/api/admin/projects/:id/static-files',
    express.raw({ type: '*/*', limit: process.env.MOCKMATE_STATIC_UPLOAD_LIMIT ?? '500mb' }),
    (req, _res, next) => { next(); },
  );

  // ============================================================================
  // Static Files (Automation Media)
  // ============================================================================

  // Serve static files from the active project's static_files/ directory.
  // Falls back to MOCKMATE_STATIC_DIR env var for developer convenience.
  app.use('/static_files', (req, res, next) => {
    // Env-var override (e.g. developer pointing at repo static_files directly)
    const envDir = process.env.MOCKMATE_STATIC_DIR;
    if (envDir && fs.existsSync(envDir)) {
      return express.static(envDir)(req, res, next);
    }
    // Per-project directory
    const project = getActiveProject();
    if (!project) {
      res.status(503).json({ error: 'No active project' });
      return;
    }
    const root = getStaticFilesRoot(project.slug);
    if (!fs.existsSync(root)) {
      res.status(404).send('No static_files for this project. Upload files via the Static Files view.');
      return;
    }
    return express.static(root)(req, res, next);
  });

  // ============================================================================
  // Dashboard Static Files
  // ============================================================================

  // Serve dashboard static files.
  // In production, assets live under dist/public next to compiled JS.
  // In dev (tsx), __dirname points to src/, so we also search common workspace paths.
  const dashboardCandidates = [
    path.join(__dirname, 'public'),
    path.resolve(__dirname, '../dist/public'),
    path.resolve(process.cwd(), 'dist/public'),
    path.resolve(process.cwd(), '../server/dist/public'),
    path.resolve(__dirname, '../../dashboard/dist'),
    path.resolve(process.cwd(), '../dashboard/dist'),
  ];
  const publicDir = dashboardCandidates.find((p) =>
    fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html'))
  );

  if (publicDir) {
    app.use(express.static(publicDir));

    // Serve index.html for all non-API/non-setup routes (SPA routing)
    app.get('*', (req, res, next) => {
      // Let API and setup routes pass through
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/setup') ||
        req.path.startsWith('/static_files') ||
        req.path === '/health' ||
        req.path === '/setMockServerflags' ||
        req.path === '/getMockServerData'
      ) {
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
  ports: ServerPorts = { http: 3456, https: 3457, proxy: 8888 }
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

  // Start HTTP proxy server for device interception
  const { server: proxyServer } = await createProxyServer({
    port: ports.proxy,
    caCert: certs.ca.cert,
    caKey: certs.ca.privateKey,
  });

  // Log server information
  logServerInfo(ports, localIPs);

  return {
    httpServer,
    httpsServer,
    proxyServer,
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

  // Proxy
  const primaryIP = localIPs[0] || 'localhost';
  console.log('🔀 HTTP Proxy (for transparent interception):');
  console.log(`   Proxy: ${primaryIP}:${ports.proxy}`);
  console.log('   Set your device WiFi proxy to this address');
  console.log('');

  // Device Setup
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
