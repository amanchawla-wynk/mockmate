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
 * Certificate validation result
 */
export interface CertificateValidation {
  isValid: boolean;
  expiryDate?: Date;
  daysUntilExpiry?: number;
  shouldRegenerate: boolean;
}
