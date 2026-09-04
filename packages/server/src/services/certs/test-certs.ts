#!/usr/bin/env tsx
/**
 * Manual test script for certificate generation
 * Run with: npx tsx src/services/certs/test-certs.ts --test-root /tmp/mockmate-certs --certificate-directory /tmp/mockmate-certs/generated
 */

import {
  ensureCertificates,
  getCertificatePaths,
  validateCertificate,
} from './generator';
import * as forge from 'node-forge';
import * as path from 'node:path';

export function parseTestCertificateArguments(arguments_: readonly string[]): {
  testRoot: string;
  certificateDirectory: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error('Explicit --test-root and --certificate-directory are required');
    values.set(name, value);
  }
  const testRoot = values.get('--test-root');
  const certificateDirectory = values.get('--certificate-directory');
  if (!testRoot || !certificateDirectory) {
    throw new Error('Explicit --test-root and --certificate-directory are required');
  }
  if (!path.isAbsolute(testRoot) || !path.isAbsolute(certificateDirectory)) {
    throw new Error('Test certificate paths must be absolute');
  }
  const normalizedRoot = path.resolve(testRoot);
  const normalizedCertificates = path.resolve(certificateDirectory);
  const relative = path.relative(normalizedRoot, normalizedCertificates);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Certificate directory must be a strict descendant of the test root');
  }
  return { testRoot: normalizedRoot, certificateDirectory: normalizedCertificates };
}

async function main() {
  const { certificateDirectory } = parseTestCertificateArguments(process.argv.slice(2));
  console.log('🔐 Testing Certificate Generation\n');

  // Test with some example local IPs
  const domains = ['192.168.1.100', '10.0.0.5'];
  console.log('Domains to include:', domains);
  console.log('');

  // Generate or load certificates
  const certs = await ensureCertificates(domains, certificateDirectory);

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
  console.log(`📁 Certificates saved to: ${getCertificatePaths(certificateDirectory).certsDir}`);
  console.log('  - ca.crt (CA certificate - install on devices)');
  console.log('  - ca.key (CA private key)');
  console.log('  - server.crt (Server certificate)');
  console.log('  - server.key (Server private key)');
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
