#!/usr/bin/env tsx
/**
 * Test script for HTTPS server
 * Run with: npx tsx src/test-https.ts
 */

import { startServers } from './app';
import * as https from 'https';

async function testHTTPSServer() {
  console.log('🧪 Testing HTTPS Server Setup\n');

  // Start servers on test ports
  const servers = await startServers({ http: 9456, https: 9457, proxy: 9888 });

  console.log('\n✅ Servers started successfully!\n');

  // Test HTTPS connection
  console.log('🔍 Testing HTTPS connection...\n');

  const options = {
    hostname: 'localhost',
    port: 9457,
    path: '/health',
    method: 'GET',
    rejectUnauthorized: false, // Accept self-signed cert for testing
  };

  const req = https.request(options, (res) => {
    console.log(`✓ Status Code: ${res.statusCode}`);

    const socket = res.socket as any;
    console.log(`✓ Protocol: ${socket?.getProtocol?.() || 'TLS'}`);

    const cert = socket?.getPeerCertificate?.();
    if (cert) {
      console.log(`✓ Certificate Subject: ${cert.subject.CN}`);
      console.log(`✓ Certificate Issuer: ${cert.issuer.CN}`);
      console.log(`✓ Valid From: ${cert.valid_from}`);
      console.log(`✓ Valid To: ${cert.valid_to}`);

      if (cert.subjectaltname) {
        console.log(`✓ Subject Alternative Names: ${cert.subjectaltname}`);
      }
    }

    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      console.log(`✓ Response: ${data}`);
      console.log('\n✅ HTTPS test passed!\n');

      // Cleanup
      servers.httpServer.close();
      servers.httpsServer.close();
      process.exit(0);
    });
  });

  req.on('error', (e) => {
    console.error(`❌ Error: ${e.message}`);
    servers.httpServer.close();
    servers.httpsServer.close();
    process.exit(1);
  });

  req.end();
}

testHTTPSServer().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
