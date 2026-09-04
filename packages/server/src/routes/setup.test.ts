import express from 'express';
import * as QRCode from 'qrcode';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSetupRouter } from './setup';
import { setupPageHTML } from './setup-page';
import { getLocalIPAddresses } from '../services/network';

vi.mock('qrcode', () => ({
  toBuffer: vi.fn(),
}));

describe('device setup routes', () => {
  beforeEach(() => {
    vi.mocked(QRCode.toBuffer).mockReset().mockResolvedValue(Buffer.from('qr'));
  });

  it('encodes the assigned HTTP port in the setup QR code', async () => {
    const app = express();
    app.use('/setup', createSetupRouter({
      certificateDirectory: '/tmp/mockmate-test/certificates',
      getPorts: () => ({ http: 18080, https: 18443, proxy: 18888 }),
    }));

    const response = await request(app).get('/setup/qr');

    const primaryIP = getLocalIPAddresses()[0] || 'localhost';
    expect(response.status).toBe(200);
    expect(QRCode.toBuffer).toHaveBeenCalledWith(
      `http://${primaryIP}:18080/setup`,
      expect.objectContaining({ type: 'png' }),
    );
  });

  it('reads certificates only from the active server directory', async () => {
    const app = express().use('/setup', createSetupRouter({
      certificateDirectory: '/tmp/mockmate-active-certificate-owner',
      getPorts: () => ({ http: 18080, https: 18443, proxy: 18888 }),
    }));

    await request(app).get('/setup/ca.crt').expect(404);
  });

  it('describes proxy interception without redirecting applications to MockMate', () => {
    const html = setupPageHTML({
      host: '192.0.2.10',
      localAddresses: ['192.0.2.10'],
      ports: { http: 3457, https: 3458, proxy: 8888 },
    });

    expect(html).toContain('interception allowlist');
    expect(html).toContain('Keep your app calling its real backend URL');
    expect(html).toContain('192.0.2.10:8888');
    expect(html).toContain('192.0.2.10:3457');
    expect(html).toContain('192.0.2.10:3458');
    expect(html).not.toContain("project's Base URL");
    expect(html).not.toContain('Base URL domain');
    expect(html).not.toContain('HTTPS URL (use this in your app)');
  });
});
