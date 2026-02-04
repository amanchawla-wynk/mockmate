#!/usr/bin/env tsx
/**
 * Test script for device setup page
 * Run with: npx tsx src/test-setup.ts
 */

import { startServers } from './app';
import * as http from 'http';
import * as https from 'https';

async function testSetupPage() {
  console.log('🧪 Testing Device Setup Page\n');

  // Start servers on test ports
  const servers = await startServers({ http: 9456, https: 9457 });

  console.log('\n✅ Servers started!\n');
  console.log('🔍 Testing setup page endpoints...\n');

  const baseURL = 'http://localhost:9456';

  const testEndpoint = (path: string, useHttps = false): Promise<void> => {
    return new Promise((resolve, reject) => {
      const client = useHttps ? https : http;
      const options = {
        hostname: 'localhost',
        port: useHttps ? 9457 : 9456,
        path,
        method: 'GET',
        rejectUnauthorized: false,
      };

      const req = client.request(options, (res) => {
        console.log(`✓ GET ${path}: ${res.statusCode} ${res.statusMessage}`);
        console.log(`  Content-Type: ${res.headers['content-type']}`);
        if (res.headers['content-disposition']) {
          console.log(`  Content-Disposition: ${res.headers['content-disposition']}`);
        }
        resolve();
      });

      req.on('error', reject);
      req.end();
    });
  };

  try {
    // Test all endpoints
    await testEndpoint('/setup');
    await testEndpoint('/setup/ca.crt');
    await testEndpoint('/setup/ios-profile');
    await testEndpoint('/setup/android-config');
    await testEndpoint('/setup/qr');
    await testEndpoint('/setup/test', true);

    console.log('\n✅ All setup page tests passed!\n');

    console.log('📋 Setup Page URLs:');
    console.log(`  - Setup Page: ${baseURL}/setup`);
    console.log(`  - CA Certificate: ${baseURL}/setup/ca.crt`);
    console.log(`  - iOS Profile: ${baseURL}/setup/ios-profile`);
    console.log(`  - Android Config: ${baseURL}/setup/android-config`);
    console.log(`  - QR Code: ${baseURL}/setup/qr`);
    console.log(`  - Test Endpoint: https://localhost:9457/setup/test\n`);

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    // Cleanup
    servers.httpServer.close();
    servers.httpsServer.close();
    process.exit(0);
  }
}

testSetupPage().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
