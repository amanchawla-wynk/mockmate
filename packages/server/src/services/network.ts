/**
 * Network detection service
 * Detects local IP addresses for HTTPS certificate generation
 */

import * as os from 'os';

export interface NetworkInfo {
  /** Local IP addresses (IPv4) */
  localIPs: string[];
  /** Hostname */
  hostname: string;
}

/**
 * Get all local IPv4 addresses from network interfaces
 * Excludes localhost/loopback addresses
 * @returns Array of local IP addresses
 */
export function getLocalIPAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;

    for (const addr of iface) {
      // Skip internal/loopback addresses
      if (addr.internal) continue;

      // Only include IPv4 addresses
      if (addr.family === 'IPv4') {
        addresses.push(addr.address);
      }
    }
  }

  return addresses;
}

/**
 * Get network information for server startup
 * @returns Network info with IPs and hostname
 */
export function getNetworkInfo(): NetworkInfo {
  return {
    localIPs: getLocalIPAddresses(),
    hostname: os.hostname()
  };
}

/**
 * Format URLs for display
 * @param port - Port number
 * @param protocol - 'http' or 'https'
 * @returns Array of formatted URLs
 */
export function formatServerURLs(port: number, protocol: 'http' | 'https' = 'http'): string[] {
  const localIPs = getLocalIPAddresses();
  const urls: string[] = [];

  // Always include localhost
  urls.push(`${protocol}://localhost:${port}`);

  // Add local IP URLs
  for (const ip of localIPs) {
    urls.push(`${protocol}://${ip}:${port}`);
  }

  return urls;
}
