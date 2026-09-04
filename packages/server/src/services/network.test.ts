import { describe, it, expect } from 'vitest';
import { getLocalIPAddresses, getNetworkInfo, formatServerURLs } from './network';

describe('Network Service', () => {
  describe('getLocalIPAddresses', () => {
    it('should return an array of IP addresses', () => {
      const ips = getLocalIPAddresses();
      expect(Array.isArray(ips)).toBe(true);
    });

    it('should not include localhost addresses', () => {
      const ips = getLocalIPAddresses();
      expect(ips).not.toContain('127.0.0.1');
      expect(ips).not.toContain('::1');
    });

    it('should only include IPv4 addresses', () => {
      const ips = getLocalIPAddresses();

      for (const ip of ips) {
        // IPv4 format: xxx.xxx.xxx.xxx
        expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      }
    });

    it('should return valid IP addresses', () => {
      const ips = getLocalIPAddresses();

      for (const ip of ips) {
        const parts = ip.split('.');
        expect(parts).toHaveLength(4);

        for (const part of parts) {
          const num = parseInt(part, 10);
          expect(num).toBeGreaterThanOrEqual(0);
          expect(num).toBeLessThanOrEqual(255);
        }
      }
    });
  });

  describe('getNetworkInfo', () => {
    it('should return network info object', () => {
      const info = getNetworkInfo();

      expect(info).toHaveProperty('localIPs');
      expect(info).toHaveProperty('hostname');
    });

    it('should include local IPs array', () => {
      const info = getNetworkInfo();

      expect(Array.isArray(info.localIPs)).toBe(true);
    });

    it('should include hostname string', () => {
      const info = getNetworkInfo();

      expect(typeof info.hostname).toBe('string');
      expect(info.hostname.length).toBeGreaterThan(0);
    });
  });

  describe('formatServerURLs', () => {
    it('should include localhost URL', () => {
      const urls = formatServerURLs(3456, 'http');

      expect(urls).toContain('http://localhost:3456');
    });

    it('should format HTTP URLs correctly', () => {
      const urls = formatServerURLs(3456, 'http');

      for (const url of urls) {
        expect(url).toMatch(/^http:\/\//);
        expect(url).toMatch(/:3456$/);
      }
    });

    it('should format HTTPS URLs correctly', () => {
      const urls = formatServerURLs(3457, 'https');

      expect(urls[0]).toBe('https://localhost:3457');

      for (const url of urls) {
        expect(url).toMatch(/^https:\/\//);
        expect(url).toMatch(/:3457$/);
      }
    });

    it('should include local IP URLs', () => {
      const localIPs = getLocalIPAddresses();
      const urls = formatServerURLs(3456, 'http');

      // Should have at least localhost
      expect(urls.length).toBeGreaterThanOrEqual(1);

      // Should have localhost + local IPs
      expect(urls.length).toBe(1 + localIPs.length);
    });

    it('should default to http protocol', () => {
      const urls = formatServerURLs(3456);

      expect(urls[0]).toBe('http://localhost:3456');
    });
  });
});
