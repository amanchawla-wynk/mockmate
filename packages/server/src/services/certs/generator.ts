import * as forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CertificateData, CertificatePair, CertificateValidation } from './types';

const CERTS_DIR = path.join(os.homedir(), '.mockmate', 'certs');
const CA_CERT_PATH = path.join(CERTS_DIR, 'ca.crt');
const CA_KEY_PATH = path.join(CERTS_DIR, 'ca.key');
const SERVER_CERT_PATH = path.join(CERTS_DIR, 'server.crt');
const SERVER_KEY_PATH = path.join(CERTS_DIR, 'server.key');

// Certificate validity periods
const CA_VALIDITY_YEARS = 10;
const SERVER_VALIDITY_YEARS = 1;
const REGENERATE_THRESHOLD_DAYS = 30;

/**
 * Generate a self-signed CA certificate
 * @returns CA certificate and private key in PEM format
 */
export function generateCA(): CertificateData {
  // Generate RSA key pair (2048-bit)
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';

  // Set validity period (10 years)
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  // Set certificate attributes
  const attrs = [
    { name: 'commonName', value: 'MockMate CA' },
    { name: 'organizationName', value: 'MockMate' },
    { name: 'countryName', value: 'US' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed, so issuer = subject

  // Add extensions for CA
  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true
    },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: 'subjectKeyIdentifier'
    },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: true
    }
  ]);

  // Self-sign the certificate
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey)
  };
}

/**
 * Generate a server certificate signed by the CA
 * @param ca - CA certificate and private key
 * @param domains - List of domains/IPs to include as Subject Alternative Names
 * @returns Server certificate and private key in PEM format
 */
export function generateServerCert(ca: CertificateData, domains: string[]): CertificateData {
  // Parse CA certificate and key
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const caKey = forge.pki.privateKeyFromPem(ca.privateKey);

  // Generate RSA key pair for server (2048-bit)
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create certificate
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));

  // Set validity period (1 year)
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + SERVER_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  // Set certificate attributes
  const attrs = [
    { name: 'commonName', value: 'MockMate Server' },
    { name: 'organizationName', value: 'MockMate' },
    { name: 'countryName', value: 'US' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes); // Issued by CA

  // Build Subject Alternative Names (SANs)
  const altNames: Array<{ type: number; value: string; ip?: string }> = [];

  // Always include localhost and 127.0.0.1
  const defaultDomains = ['localhost', '127.0.0.1'];
  const allDomains = [...new Set([...defaultDomains, ...domains])];

  for (const domain of allDomains) {
    // Check if it's an IP address
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
      altNames.push({ type: 7, ip: domain, value: domain });
    } else {
      altNames.push({ type: 2, value: domain });
    }
  }

  // Add extensions
  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true
    },
    {
      name: 'extKeyUsage',
      serverAuth: true
    },
    {
      name: 'subjectAltName',
      altNames
    },
    {
      name: 'subjectKeyIdentifier'
    },
    {
      name: 'authorityKeyIdentifier',
      keyid: caCert.generateSubjectKeyIdentifier().getBytes()
    }
  ]);

  // Sign with CA private key
  cert.sign(caKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey)
  };
}

/**
 * Save certificates to ~/.mockmate/certs/
 * @param certs - Certificate pair to save
 */
export function saveCertificates(certs: CertificatePair): void {
  // Create directory if it doesn't exist
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  // Save CA certificate and key
  fs.writeFileSync(CA_CERT_PATH, certs.ca.cert, { mode: 0o644 });
  fs.writeFileSync(CA_KEY_PATH, certs.ca.privateKey, { mode: 0o600 });

  // Save server certificate and key
  fs.writeFileSync(SERVER_CERT_PATH, certs.server.cert, { mode: 0o644 });
  fs.writeFileSync(SERVER_KEY_PATH, certs.server.privateKey, { mode: 0o600 });
}

/**
 * Load certificates from ~/.mockmate/certs/
 * @returns Certificate pair or null if any file is missing
 */
export function loadCertificates(): CertificatePair | null {
  // Check if all certificate files exist
  if (
    !fs.existsSync(CA_CERT_PATH) ||
    !fs.existsSync(CA_KEY_PATH) ||
    !fs.existsSync(SERVER_CERT_PATH) ||
    !fs.existsSync(SERVER_KEY_PATH)
  ) {
    return null;
  }

  try {
    return {
      ca: {
        cert: fs.readFileSync(CA_CERT_PATH, 'utf-8'),
        privateKey: fs.readFileSync(CA_KEY_PATH, 'utf-8')
      },
      server: {
        cert: fs.readFileSync(SERVER_CERT_PATH, 'utf-8'),
        privateKey: fs.readFileSync(SERVER_KEY_PATH, 'utf-8')
      }
    };
  } catch (error) {
    return null;
  }
}

/**
 * Validate a certificate
 * @param certPem - Certificate in PEM format
 * @returns Validation result
 */
export function validateCertificate(certPem: string): CertificateValidation {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const now = new Date();
    const expiryDate = cert.validity.notAfter;
    const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    return {
      isValid: true,
      expiryDate,
      daysUntilExpiry,
      shouldRegenerate: daysUntilExpiry <= REGENERATE_THRESHOLD_DAYS
    };
  } catch (error) {
    return {
      isValid: false,
      shouldRegenerate: true
    };
  }
}

/**
 * Check if certificate is expired
 * @param certPem - Certificate in PEM format
 * @returns True if expired, false otherwise
 */
export function isCertificateExpired(certPem: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const now = new Date();
    return now > cert.validity.notAfter;
  } catch (error) {
    return true;
  }
}

/**
 * Get certificate expiry date
 * @param certPem - Certificate in PEM format
 * @returns Expiry date or null if invalid
 */
export function getCertificateExpiry(certPem: string): Date | null {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    return cert.validity.notAfter;
  } catch (error) {
    return null;
  }
}

/**
 * Check if certificates should be regenerated
 * @param certs - Certificate pair to check
 * @returns True if regeneration is needed
 */
export function shouldRegenerateCerts(certs: CertificatePair): boolean {
  const caValidation = validateCertificate(certs.ca.cert);
  const serverValidation = validateCertificate(certs.server.cert);

  return caValidation.shouldRegenerate || serverValidation.shouldRegenerate;
}

/**
 * Ensure certificates exist and are valid
 * Generate new ones if needed
 * @param domains - List of domains/IPs to include in server certificate
 * @returns Certificate pair
 */
export async function ensureCertificates(domains: string[] = []): Promise<CertificatePair> {
  // Try to load existing certificates
  const existing = loadCertificates();

  // If certificates exist and are valid, reuse them
  if (existing && !shouldRegenerateCerts(existing)) {
    console.log('[Certificates] Using existing certificates');
    return existing;
  }

  // Generate new certificates
  console.log('[Certificates] Generating new certificates...');
  const ca = generateCA();
  const server = generateServerCert(ca, domains);

  const certs: CertificatePair = { ca, server };

  // Save certificates
  saveCertificates(certs);
  console.log('[Certificates] Certificates saved to:', CERTS_DIR);

  return certs;
}
