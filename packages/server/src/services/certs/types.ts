/**
 * Certificate and private key in PEM format
 */
export interface CertificateData {
  cert: string;       // Certificate in PEM format
  privateKey: string; // Private key in PEM format
}

/**
 * CA and server certificate pair
 */
export interface CertificatePair {
  ca: CertificateData;
  server: CertificateData;
}

/**
 * Files used to persist the certificate authority and server certificate
 */
export interface CertificatePaths {
  certsDir: string;
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
}

/**
 * Certificate validation result
 */
export interface CertificateValidation {
  isValid: boolean;
  expiryDate?: Date;
  daysUntilExpiry?: number;
  shouldRegenerate: boolean;
}
