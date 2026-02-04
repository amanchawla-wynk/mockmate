/**
 * LRU certificate cache for on-the-fly TLS certificate generation
 * Used by the proxy server to generate per-domain certificates
 * signed by the MockMate CA
 */

import { generateServerCert } from './certs/generator';
import type { CertificateData } from './certs/types';

export interface CertCacheOptions {
  /** Maximum number of cached domains */
  maxSize: number;
  /** CA certificate PEM */
  caCert: string;
  /** CA private key PEM */
  caKey: string;
}

export class CertCache {
  private cache = new Map<string, CertificateData>();
  private maxSize: number;
  private caData: CertificateData;
  private hits = 0;
  private misses = 0;

  constructor(options: CertCacheOptions) {
    this.maxSize = options.maxSize;
    this.caData = {
      cert: options.caCert,
      privateKey: options.caKey,
    };
  }

  /**
   * Get or generate a TLS certificate for the given domain
   */
  getCert(domain: string): CertificateData {
    const cached = this.cache.get(domain);
    if (cached) {
      this.hits++;
      // Move to end (most recently used) by deleting and re-inserting
      this.cache.delete(domain);
      this.cache.set(domain, cached);
      return cached;
    }

    this.misses++;

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    // Generate new cert for this domain
    console.log(`[CertCache] Generating certificate for ${domain}`);
    const cert = generateServerCert(this.caData, [domain]);
    this.cache.set(domain, cert);

    return cert;
  }

  /** Clear the cache */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Get cache stats */
  stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
