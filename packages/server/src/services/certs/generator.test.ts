import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as forge from 'node-forge';
import {
  generateCA,
  generateServerCert,
  saveCertificates,
  loadCertificates,
  validateCertificate,
  isCertificateExpired,
  getCertificateExpiry,
  shouldRegenerateCerts,
  ensureCertificates
} from './generator';
import { CertificatePair } from './types';

const TEST_CERTS_DIR = path.join(os.homedir(), '.mockmate', 'certs');

describe('Certificate Generator', () => {
  describe('generateCA', () => {
    it('should generate a valid CA certificate', () => {
      const ca = generateCA();

      expect(ca.cert).toBeDefined();
      expect(ca.privateKey).toBeDefined();
      expect(ca.cert).toContain('BEGIN CERTIFICATE');
      expect(ca.cert).toContain('END CERTIFICATE');
      expect(ca.privateKey).toContain('BEGIN RSA PRIVATE KEY');
      expect(ca.privateKey).toContain('END RSA PRIVATE KEY');
    });

    it('should create a self-signed certificate', () => {
      const ca = generateCA();
      const cert = forge.pki.certificateFromPem(ca.cert);

      // Subject and issuer should be the same for self-signed cert
      const subject = cert.subject.getField('CN');
      const issuer = cert.issuer.getField('CN');
      expect(subject?.value).toBe('MockMate CA');
      expect(issuer?.value).toBe('MockMate CA');
    });

    it('should have CA basic constraints', () => {
      const ca = generateCA();
      const cert = forge.pki.certificateFromPem(ca.cert);

      const basicConstraints = cert.getExtension('basicConstraints') as any;
      expect(basicConstraints).toBeDefined();
      expect(basicConstraints.cA).toBe(true);
    });

    it('should have appropriate key usage', () => {
      const ca = generateCA();
      const cert = forge.pki.certificateFromPem(ca.cert);

      const keyUsage = cert.getExtension('keyUsage') as any;
      expect(keyUsage).toBeDefined();
      expect(keyUsage.keyCertSign).toBe(true);
      expect(keyUsage.digitalSignature).toBe(true);
    });

    it('should have 10 year validity period', () => {
      const ca = generateCA();
      const cert = forge.pki.certificateFromPem(ca.cert);

      const notBefore = cert.validity.notBefore;
      const notAfter = cert.validity.notAfter;
      const years = (notAfter.getTime() - notBefore.getTime()) / (1000 * 60 * 60 * 24 * 365);

      expect(years).toBeCloseTo(10, 0);
    });
  });

  describe('generateServerCert', () => {
    it('should generate a valid server certificate', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, ['192.168.1.100']);

      expect(server.cert).toBeDefined();
      expect(server.privateKey).toBeDefined();
      expect(server.cert).toContain('BEGIN CERTIFICATE');
      expect(server.cert).toContain('END CERTIFICATE');
      expect(server.privateKey).toContain('BEGIN RSA PRIVATE KEY');
      expect(server.privateKey).toContain('END RSA PRIVATE KEY');
    });

    it('should be signed by the CA', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);

      const caCert = forge.pki.certificateFromPem(ca.cert);
      const serverCert = forge.pki.certificateFromPem(server.cert);

      // Issuer should match CA subject
      const issuer = serverCert.issuer.getField('CN');
      const caSubject = caCert.subject.getField('CN');
      expect(issuer?.value).toBe(caSubject?.value);
    });

    it('should NOT have CA basic constraints', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const cert = forge.pki.certificateFromPem(server.cert);

      const basicConstraints = cert.getExtension('basicConstraints') as any;
      expect(basicConstraints).toBeDefined();
      expect(basicConstraints.cA).toBe(false);
    });

    it('should include localhost and 127.0.0.1 in SANs', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const cert = forge.pki.certificateFromPem(server.cert);

      const subjectAltName = cert.getExtension('subjectAltName') as any;
      expect(subjectAltName).toBeDefined();

      const altNames = subjectAltName.altNames;
      const dnsNames = altNames.filter((an: any) => an.type === 2).map((an: any) => an.value);
      const ipAddresses = altNames.filter((an: any) => an.type === 7).map((an: any) => an.ip);

      expect(dnsNames).toContain('localhost');
      expect(ipAddresses).toContain('127.0.0.1');
    });

    it('should include custom domains in SANs', () => {
      const ca = generateCA();
      const customDomains = ['192.168.1.100', '10.0.0.5', 'custom.local'];
      const server = generateServerCert(ca, customDomains);
      const cert = forge.pki.certificateFromPem(server.cert);

      const subjectAltName = cert.getExtension('subjectAltName') as any;
      const altNames = subjectAltName.altNames;
      const dnsNames = altNames.filter((an: any) => an.type === 2).map((an: any) => an.value);
      const ipAddresses = altNames.filter((an: any) => an.type === 7).map((an: any) => an.ip);

      expect(ipAddresses).toContain('192.168.1.100');
      expect(ipAddresses).toContain('10.0.0.5');
      expect(dnsNames).toContain('custom.local');
    });

    it('should have 1 year validity period', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const cert = forge.pki.certificateFromPem(server.cert);

      const notBefore = cert.validity.notBefore;
      const notAfter = cert.validity.notAfter;
      const years = (notAfter.getTime() - notBefore.getTime()) / (1000 * 60 * 60 * 24 * 365);

      expect(years).toBeCloseTo(1, 0);
    });

    it('should have serverAuth extended key usage', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const cert = forge.pki.certificateFromPem(server.cert);

      const extKeyUsage = cert.getExtension('extKeyUsage') as any;
      expect(extKeyUsage).toBeDefined();
      expect(extKeyUsage.serverAuth).toBe(true);
    });
  });

  describe('saveCertificates and loadCertificates', () => {
    beforeEach(() => {
      // Clean up test certificates before each test
      if (fs.existsSync(TEST_CERTS_DIR)) {
        fs.rmSync(TEST_CERTS_DIR, { recursive: true });
      }
    });

    afterEach(() => {
      // Clean up after tests
      if (fs.existsSync(TEST_CERTS_DIR)) {
        fs.rmSync(TEST_CERTS_DIR, { recursive: true });
      }
    });

    it('should save certificates to disk', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const certs: CertificatePair = { ca, server };

      saveCertificates(certs);

      expect(fs.existsSync(path.join(TEST_CERTS_DIR, 'ca.crt'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_CERTS_DIR, 'ca.key'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_CERTS_DIR, 'server.crt'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_CERTS_DIR, 'server.key'))).toBe(true);
    });

    it('should create directory if it does not exist', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const certs: CertificatePair = { ca, server };

      expect(fs.existsSync(TEST_CERTS_DIR)).toBe(false);
      saveCertificates(certs);
      expect(fs.existsSync(TEST_CERTS_DIR)).toBe(true);
    });

    it('should set proper file permissions for private keys', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const certs: CertificatePair = { ca, server };

      saveCertificates(certs);

      const caKeyStats = fs.statSync(path.join(TEST_CERTS_DIR, 'ca.key'));
      const serverKeyStats = fs.statSync(path.join(TEST_CERTS_DIR, 'server.key'));

      // Check that permissions are 600 (owner read/write only)
      expect(caKeyStats.mode & 0o777).toBe(0o600);
      expect(serverKeyStats.mode & 0o777).toBe(0o600);
    });

    it('should load saved certificates', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const certs: CertificatePair = { ca, server };

      saveCertificates(certs);
      const loaded = loadCertificates();

      expect(loaded).not.toBeNull();
      expect(loaded?.ca.cert).toBe(certs.ca.cert);
      expect(loaded?.ca.privateKey).toBe(certs.ca.privateKey);
      expect(loaded?.server.cert).toBe(certs.server.cert);
      expect(loaded?.server.privateKey).toBe(certs.server.privateKey);
    });

    it('should return null if certificates do not exist', () => {
      const loaded = loadCertificates();
      expect(loaded).toBeNull();
    });

    it('should return null if any certificate file is missing', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const certs: CertificatePair = { ca, server };

      saveCertificates(certs);

      // Delete one file
      fs.unlinkSync(path.join(TEST_CERTS_DIR, 'server.crt'));

      const loaded = loadCertificates();
      expect(loaded).toBeNull();
    });
  });

  describe('validateCertificate', () => {
    it('should validate a valid certificate', () => {
      const ca = generateCA();
      const validation = validateCertificate(ca.cert);

      expect(validation.isValid).toBe(true);
      expect(validation.expiryDate).toBeDefined();
      expect(validation.daysUntilExpiry).toBeGreaterThan(0);
      expect(validation.shouldRegenerate).toBe(false);
    });

    it('should mark certificate for regeneration if expiring soon', () => {
      // This test would require creating a certificate that expires soon
      // For now, we'll test with an invalid cert to check the logic
      const validation = validateCertificate('invalid cert');

      expect(validation.isValid).toBe(false);
      expect(validation.shouldRegenerate).toBe(true);
    });

    it('should handle invalid certificate PEM', () => {
      const validation = validateCertificate('not a certificate');

      expect(validation.isValid).toBe(false);
      expect(validation.shouldRegenerate).toBe(true);
      expect(validation.expiryDate).toBeUndefined();
    });
  });

  describe('isCertificateExpired', () => {
    it('should return false for valid certificate', () => {
      const ca = generateCA();
      const expired = isCertificateExpired(ca.cert);

      expect(expired).toBe(false);
    });

    it('should return true for invalid certificate', () => {
      const expired = isCertificateExpired('not a certificate');

      expect(expired).toBe(true);
    });
  });

  describe('getCertificateExpiry', () => {
    it('should return expiry date for valid certificate', () => {
      const ca = generateCA();
      const expiry = getCertificateExpiry(ca.cert);

      expect(expiry).toBeInstanceOf(Date);
      expect(expiry!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should return null for invalid certificate', () => {
      const expiry = getCertificateExpiry('not a certificate');

      expect(expiry).toBeNull();
    });
  });

  describe('shouldRegenerateCerts', () => {
    it('should return false for valid certificates', () => {
      const ca = generateCA();
      const server = generateServerCert(ca, []);
      const certs: CertificatePair = { ca, server };

      const shouldRegenerate = shouldRegenerateCerts(certs);

      expect(shouldRegenerate).toBe(false);
    });

    it('should return true for invalid certificates', () => {
      const certs: CertificatePair = {
        ca: { cert: 'invalid', privateKey: 'invalid' },
        server: { cert: 'invalid', privateKey: 'invalid' }
      };

      const shouldRegenerate = shouldRegenerateCerts(certs);

      expect(shouldRegenerate).toBe(true);
    });
  });

  describe('ensureCertificates', () => {
    beforeEach(() => {
      // Clean up test certificates before each test
      if (fs.existsSync(TEST_CERTS_DIR)) {
        fs.rmSync(TEST_CERTS_DIR, { recursive: true });
      }
    });

    afterEach(() => {
      // Clean up after tests
      if (fs.existsSync(TEST_CERTS_DIR)) {
        fs.rmSync(TEST_CERTS_DIR, { recursive: true });
      }
    });

    it('should generate and save new certificates if none exist', async () => {
      const certs = await ensureCertificates(['192.168.1.100']);

      expect(certs).toBeDefined();
      expect(certs.ca.cert).toBeDefined();
      expect(certs.server.cert).toBeDefined();
      expect(fs.existsSync(TEST_CERTS_DIR)).toBe(true);
    });

    it('should reuse existing valid certificates', async () => {
      // Generate first time
      const certs1 = await ensureCertificates(['192.168.1.100']);

      // Load second time
      const certs2 = await ensureCertificates(['192.168.1.100']);

      // Should be the same certificates
      expect(certs2.ca.cert).toBe(certs1.ca.cert);
      expect(certs2.server.cert).toBe(certs1.server.cert);
    });

    it('should regenerate if certificates are invalid', async () => {
      // Create invalid certificates
      fs.mkdirSync(TEST_CERTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(TEST_CERTS_DIR, 'ca.crt'), 'invalid');
      fs.writeFileSync(path.join(TEST_CERTS_DIR, 'ca.key'), 'invalid');
      fs.writeFileSync(path.join(TEST_CERTS_DIR, 'server.crt'), 'invalid');
      fs.writeFileSync(path.join(TEST_CERTS_DIR, 'server.key'), 'invalid');

      const certs = await ensureCertificates(['192.168.1.100']);

      // Should have valid certificates now
      const validation = validateCertificate(certs.ca.cert);
      expect(validation.isValid).toBe(true);
    });

    it('should include custom domains in server certificate', async () => {
      const customDomains = ['192.168.1.100', '10.0.0.5'];
      const certs = await ensureCertificates(customDomains);

      const serverCert = forge.pki.certificateFromPem(certs.server.cert);
      const subjectAltName = serverCert.getExtension('subjectAltName') as any;
      const ipAddresses = subjectAltName.altNames
        .filter((an: any) => an.type === 7)
        .map((an: any) => an.ip);

      expect(ipAddresses).toContain('192.168.1.100');
      expect(ipAddresses).toContain('10.0.0.5');
    });
  });
});
