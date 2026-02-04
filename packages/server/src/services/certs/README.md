# Certificate Generation Service

This module handles SSL/TLS certificate generation for HTTPS support in MockMate.

## Overview

The certificate service generates self-signed CA (Certificate Authority) and server certificates to enable HTTPS connections for testing on physical devices over local networks.

## Features

- **Self-signed CA certificate** with 10-year validity
- **Server certificates** signed by CA with 1-year validity
- **Automatic certificate reuse** - loads existing valid certificates
- **Smart regeneration** - auto-regenerates expired or expiring certificates
- **Subject Alternative Names (SANs)** - supports multiple domains/IPs
- **Secure storage** - private keys stored with 600 permissions

## Usage

### Basic Usage

```typescript
import { ensureCertificates } from './services/certs';

// Generate or load certificates
const certs = await ensureCertificates(['192.168.1.100', '10.0.0.5']);

// Use with HTTPS server
import * as https from 'https';
const server = https.createServer({
  key: certs.server.privateKey,
  cert: certs.server.cert
}, app);
```

### Manual Certificate Generation

```typescript
import { generateCA, generateServerCert, saveCertificates } from './services/certs';

// Generate CA
const ca = generateCA();

// Generate server certificate
const server = generateServerCert(ca, ['192.168.1.100']);

// Save to disk
saveCertificates({ ca, server });
```

### Certificate Validation

```typescript
import { validateCertificate, isCertificateExpired } from './services/certs';

// Validate certificate
const validation = validateCertificate(certPem);
console.log('Valid:', validation.isValid);
console.log('Expires:', validation.expiryDate);
console.log('Days until expiry:', validation.daysUntilExpiry);

// Check if expired
const expired = isCertificateExpired(certPem);
```

## File Storage

Certificates are stored in `~/.mockmate/certs/`:

```
~/.mockmate/certs/
├── ca.crt         (CA certificate - 644 permissions)
├── ca.key         (CA private key - 600 permissions)
├── server.crt     (Server certificate - 644 permissions)
└── server.key     (Server private key - 600 permissions)
```

## Certificate Details

### CA Certificate
- **Common Name**: MockMate CA
- **Validity**: 10 years
- **Key Size**: 2048-bit RSA
- **Self-signed**: Yes
- **Extensions**: basicConstraints (cA=true), keyUsage (keyCertSign)

### Server Certificate
- **Common Name**: MockMate Server
- **Validity**: 1 year
- **Key Size**: 2048-bit RSA
- **Signed by**: MockMate CA
- **Extensions**: basicConstraints (cA=false), extKeyUsage (serverAuth)
- **SANs**: Includes localhost, 127.0.0.1, and custom domains

## Subject Alternative Names (SANs)

The server certificate includes:
- **Default**: `localhost`, `127.0.0.1`
- **Custom**: Any domains/IPs passed to `ensureCertificates()`

Example:
```typescript
// Will include: localhost, 127.0.0.1, 192.168.1.100, 10.0.0.5
await ensureCertificates(['192.168.1.100', '10.0.0.5']);
```

## Auto-Regeneration

Certificates are automatically regenerated when:
- No existing certificates found
- Any certificate file is missing
- Certificate is invalid or corrupted
- Certificate expires within 30 days

## Security Considerations

1. **Private Key Protection**
   - Keys stored with 600 permissions (owner only)
   - Never logged or exposed in error messages

2. **Certificate Validity**
   - CA: 10 years (minimal maintenance)
   - Server: 1 year (regenerates annually)
   - 30-day warning threshold

3. **Trust Warning**
   - Self-signed certificates will show browser warnings
   - Users must manually install CA certificate on devices
   - Required for HTTPS testing on physical devices

## API Reference

### `ensureCertificates(domains?: string[]): Promise<CertificatePair>`
Main entry point - generates or loads certificates.

### `generateCA(): CertificateData`
Generate a self-signed CA certificate.

### `generateServerCert(ca: CertificateData, domains: string[]): CertificateData`
Generate server certificate signed by CA.

### `saveCertificates(certs: CertificatePair): void`
Save certificates to `~/.mockmate/certs/`.

### `loadCertificates(): CertificatePair | null`
Load certificates from disk, returns null if missing.

### `validateCertificate(certPem: string): CertificateValidation`
Validate certificate and check expiry.

### `isCertificateExpired(certPem: string): boolean`
Check if certificate is expired.

### `getCertificateExpiry(certPem: string): Date | null`
Get certificate expiration date.

### `shouldRegenerateCerts(certs: CertificatePair): boolean`
Check if certificates need regeneration.

## Testing

Run tests:
```bash
npm test -- generator.test.ts
```

Manual test:
```bash
npx tsx src/services/certs/test-certs.ts
```

## Next Steps (Day 16)

This certificate service will be integrated with:
1. **HTTPS Server** - Create https.Server with generated certs
2. **Network Detection** - Detect local IP addresses
3. **Device Setup** - Provide CA download and setup instructions
