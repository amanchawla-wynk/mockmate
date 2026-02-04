#!/usr/bin/env tsx
/**
 * Manual test script for certificate generation
 * Run with: npx tsx src/services/certs/test-certs.ts
 */

import { ensureCertificates, validateCertificate } from './generator';
import * as forge from 'node-forge';

async function main() {
  console.log('🔐 Testing Certificate Generation\n');

  // Test with some example local IPs
  const domains = ['192.168.1.100', '10.0.0.5'];
  console.log('Domains to include:', domains);
  console.log('');

  // Generate or load certificates
  const certs = await ensureCertificates(domains);

  // Validate CA certificate
  console.log('✓ CA Certificate:');
  const caValidation = validateCertificate(certs.ca.cert);
  console.log(`  - Valid: ${caValidation.isValid}`);
  console.log(`  - Expires: ${caValidation.expiryDate?.toISOString()}`);
  console.log(`  - Days until expiry: ${caValidation.daysUntilExpiry}`);
  console.log(`  - Should regenerate: ${caValidation.shouldRegenerate}`);
  console.log('');

  // Validate server certificate
  console.log('✓ Server Certificate:');
  const serverValidation = validateCertificate(certs.server.cert);
  console.log(`  - Valid: ${serverValidation.isValid}`);
  console.log(`  - Expires: ${serverValidation.expiryDate?.toISOString()}`);
  console.log(`  - Days until expiry: ${serverValidation.daysUntilExpiry}`);
  console.log(`  - Should regenerate: ${serverValidation.shouldRegenerate}`);
  console.log('');

  // Parse and display SANs
  const serverCert = forge.pki.certificateFromPem(certs.server.cert);
  const subjectAltName = serverCert.getExtension('subjectAltName') as any;
  console.log('✓ Subject Alternative Names:');

  const dnsNames = subjectAltName.altNames
    .filter((an: any) => an.type === 2)
    .map((an: any) => an.value);
  console.log(`  - DNS Names: ${dnsNames.join(', ')}`);

  const ipAddresses = subjectAltName.altNames
    .filter((an: any) => an.type === 7)
    .map((an: any) => an.ip);
  console.log(`  - IP Addresses: ${ipAddresses.join(', ')}`);
  console.log('');

  console.log('✅ Certificate generation successful!\n');
  console.log('📁 Certificates saved to: ~/.mockmate/certs/');
  console.log('  - ca.crt (CA certificate - install on devices)');
  console.log('  - ca.key (CA private key)');
  console.log('  - server.crt (Server certificate)');
  console.log('  - server.key (Server private key)');
}

main().catch(console.error);
