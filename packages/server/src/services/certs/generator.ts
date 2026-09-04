import * as forge from 'node-forge';
import * as fs from 'fs';
import * as path from 'path';
import { getStorageConfig } from '../storage';
import {
  CertificateData,
  CertificatePair,
  CertificatePaths,
  CertificateValidation,
} from './types';

// Certificate validity periods
const CA_VALIDITY_YEARS = 10;
const SERVER_VALIDITY_YEARS = 1;
const REGENERATE_THRESHOLD_DAYS = 30;

export function getCertificatePaths(
  certsDir = getStorageConfig().certsDir,
): CertificatePaths {
  return {
    certsDir,
    caCert: path.join(certsDir, 'ca.crt'),
    caKey: path.join(certsDir, 'ca.key'),
    serverCert: path.join(certsDir, 'server.crt'),
    serverKey: path.join(certsDir, 'server.key'),
  };
}

function normalizeDomains(domains: string[]): string[] {
  return [...new Set(['localhost', '127.0.0.1', ...domains])].sort();
}

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

  const allDomains = normalizeDomains(domains);

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
 * Save a certificate and private key to the selected paths.
 */
function saveCertificateData(
  data: CertificateData,
  certPath: string,
  keyPath: string,
): void {
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  fs.writeFileSync(certPath, data.cert, { mode: 0o644 });
  fs.chmodSync(certPath, 0o644);
  fs.writeFileSync(keyPath, data.privateKey, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
}

function loadCertificateData(
  certPath: string,
  keyPath: string,
): CertificateData | null {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    return null;
  }

  try {
    return {
      cert: fs.readFileSync(certPath, 'utf-8'),
      privateKey: fs.readFileSync(keyPath, 'utf-8'),
    };
  } catch {
    return null;
  }
}

export function loadCA(certsDir?: string): CertificateData | null {
  const paths = getCertificatePaths(certsDir);
  return loadCertificateData(paths.caCert, paths.caKey);
}

export function loadServerCertificate(certsDir?: string): CertificateData | null {
  const paths = getCertificatePaths(certsDir);
  return loadCertificateData(paths.serverCert, paths.serverKey);
}

export function saveCA(ca: CertificateData, certsDir?: string): void {
  const paths = getCertificatePaths(certsDir);
  saveCertificateData(ca, paths.caCert, paths.caKey);
}

export function saveServerCertificate(
  server: CertificateData,
  certsDir?: string,
): void {
  const paths = getCertificatePaths(certsDir);
  saveCertificateData(server, paths.serverCert, paths.serverKey);
}

export function saveCertificates(
  certs: CertificatePair,
  certsDir?: string,
): void {
  saveCA(certs.ca, certsDir);
  saveServerCertificate(certs.server, certsDir);
}

export function loadCertificates(certsDir?: string): CertificatePair | null {
  const ca = loadCA(certsDir);
  const server = loadServerCertificate(certsDir);
  return ca && server ? { ca, server } : null;
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

export function validateCertificateKeyPair(data: CertificateData): boolean {
  try {
    const cert = forge.pki.certificateFromPem(data.cert);
    const privateKey = forge.pki.privateKeyFromPem(
      data.privateKey,
    ) as forge.pki.rsa.PrivateKey;
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
    const message = 'mockmate-certificate-key-pair';
    const signingDigest = forge.md.sha256.create();
    signingDigest.update(message, 'utf8');
    const signature = privateKey.sign(signingDigest);
    const verificationDigest = forge.md.sha256.create();
    verificationDigest.update(message, 'utf8');
    return publicKey.verify(verificationDigest.digest().bytes(), signature);
  } catch {
    return false;
  }
}

export function validateCertificateAuthority(certPem: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const basicConstraints = cert.getExtension('basicConstraints') as
      | { cA?: boolean }
      | undefined;
    return basicConstraints?.cA === true && cert.verify(cert);
  } catch {
    return false;
  }
}

export function isCertificateSignedBy(
  certificatePem: string,
  caCertPem: string,
): boolean {
  try {
    const certificate = forge.pki.certificateFromPem(certificatePem);
    const ca = forge.pki.certificateFromPem(caCertPem);
    return ca.verify(certificate);
  } catch {
    return false;
  }
}

export function certificateCoversDomains(
  certPem: string,
  domains: string[],
): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const subjectAltName = cert.getExtension('subjectAltName') as
      | { altNames?: Array<{ type: number; value?: string; ip?: string }> }
      | undefined;
    const certificateDomains = (subjectAltName?.altNames ?? [])
      .map((altName) => {
        if (altName.type === 2) return altName.value;
        if (altName.type === 7) return altName.ip;
        return undefined;
      })
      .filter((domain): domain is string => Boolean(domain))
      .sort();
    const requestedDomains = normalizeDomains(domains);
    return certificateDomains.length === requestedDomains.length
      && certificateDomains.every(
        (domain, index) => domain === requestedDomains[index],
      );
  } catch {
    return false;
  }
}

export function shouldRegenerateLeaf(
  ca: CertificateData,
  server: CertificateData | null,
  domains: string[],
): boolean {
  if (!server) return true;
  if (!validateCertificateKeyPair(server)) return true;
  if (validateCertificate(server.cert).shouldRegenerate) return true;
  if (!certificateCoversDomains(server.cert, normalizeDomains(domains))) {
    return true;
  }
  return !isCertificateSignedBy(server.cert, ca.cert);
}

/**
 * Ensure certificates exist and are valid
 * Generate new ones if needed
 * @param domains - List of domains/IPs to include in server certificate
 * @returns Certificate pair
 */
export async function ensureCertificates(
  domains: string[] = [],
  certsDir?: string,
): Promise<CertificatePair> {
  const requestedDomains = normalizeDomains(domains);
  let ca = loadCA(certsDir);
  const caInvalid = !ca
    || !validateCertificateKeyPair(ca)
    || !validateCertificateAuthority(ca.cert)
    || validateCertificate(ca.cert).shouldRegenerate;

  if (caInvalid) {
    ca = generateCA();
    saveCA(ca, certsDir);
    const server = generateServerCert(ca, requestedDomains);
    saveServerCertificate(server, certsDir);
    return { ca, server };
  }

  if (!ca) throw new Error('Failed to initialize certificate authority');

  let server = loadServerCertificate(certsDir);
  if (shouldRegenerateLeaf(ca, server, requestedDomains)) {
    server = generateServerCert(ca, requestedDomains);
    saveServerCertificate(server, certsDir);
  }
  return { ca, server: server! };
}
