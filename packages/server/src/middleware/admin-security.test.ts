import { describe, expect, it } from 'vitest';
import { isLoopbackAddress } from './admin-security';

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([undefined, '192.168.1.10', '10.0.0.5', '203.0.113.8'])(
    'rejects non-loopback %s',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(false);
    },
  );
});
