/**
 * Device Setup Routes
 * Provides certificate downloads and setup instructions for physical devices
 */

import { Router, Request, Response } from 'express';
import * as QRCode from 'qrcode';
import { getCertificatePaths, loadCA } from '../services/certs';
import { generateiOSProfile, generateAndroidNetworkConfig } from '../services/certs/profile';
import { getLocalIPAddresses } from '../services/network';
import type { ServerPorts } from '../app';
import { setupPageHTML } from './setup-page';

export interface SetupRouterDependencies {
  certificateDirectory: string;
  getPorts(): ServerPorts;
}

export function createSetupRouter(dependencies: SetupRouterDependencies): Router {
const router = Router();

/**
 * GET /setup
 * Render device setup page with instructions
 */
router.get('/', (req: Request, res: Response) => {
  const localIPs = getLocalIPAddresses();
  const primaryIP = localIPs[0] || 'localhost';
  const ports = dependencies.getPorts();

  res.setHeader('Content-Type', 'text/html');
  res.send(setupPageHTML({ host: primaryIP, localAddresses: localIPs, ports }));
});

/**
 * GET /setup/ca.crt
 * Download CA certificate file
 */
router.get('/ca.crt', (req: Request, res: Response) => {
  const ca = loadCA(getCertificatePaths(dependencies.certificateDirectory).certsDir);

  if (!ca) {
    return res.status(404).json({
      error: 'Certificates not found. Please start the server to generate certificates.',
    });
  }

  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="mockmate-ca.crt"');
  res.send(ca.cert);
});

/**
 * GET /setup/ios-profile
 * Download iOS configuration profile (.mobileconfig)
 */
router.get('/ios-profile', (req: Request, res: Response) => {
  const ca = loadCA(getCertificatePaths(dependencies.certificateDirectory).certsDir);

  if (!ca) {
    return res.status(404).json({
      error: 'Certificates not found. Please start the server to generate certificates.',
    });
  }

  const localIPs = getLocalIPAddresses();
  const primaryIP = localIPs[0] || 'localhost';

  const profile = generateiOSProfile(ca.cert, primaryIP);

  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="MockMate.mobileconfig"');
  res.send(profile);
});

/**
 * GET /setup/android-config
 * Get Android network security config XML
 */
router.get('/android-config', (req: Request, res: Response) => {
  const localIPs = getLocalIPAddresses();
  const primaryIP = localIPs[0] || 'localhost';

  const config = generateAndroidNetworkConfig(primaryIP);

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', 'attachment; filename="network_security_config.xml"');
  res.send(config);
});

/**
 * GET /setup/qr
 * Generate QR code for setup page URL
 */
router.get('/qr', async (req: Request, res: Response) => {
  try {
    const localIPs = getLocalIPAddresses();
    const primaryIP = localIPs[0] || 'localhost';
    const httpPort = dependencies.getPorts().http;

    // QR code points to HTTP setup page (no cert needed to access it)
    const setupURL = `http://${primaryIP}:${httpPort}/setup`;

    // Generate QR code as PNG
    const qrImage = await QRCode.toBuffer(setupURL, {
      type: 'png',
      width: 300,
      margin: 2,
      errorCorrectionLevel: 'M',
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(qrImage);
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

/**
 * GET /setup/test
 * Test endpoint for connection verification
 */
router.get('/test', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'HTTPS connection successful!',
    timestamp: new Date().toISOString(),
    server: 'MockMate',
  });
});

return router;
}
