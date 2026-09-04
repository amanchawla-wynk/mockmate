import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./generator', () => ({
  ensureCertificates: vi.fn(async () => ({
    ca: { cert: '', privateKey: '' },
    server: { cert: '', privateKey: '' },
  })),
  getCertificatePaths: (directory: string) => ({ certsDir: directory }),
  validateCertificate: () => ({ isValid: true, shouldRegenerate: false }),
}));

import { parseTestCertificateArguments } from './test-certs';

describe('manual certificate utility paths', () => {
  const root = path.resolve('/tmp/mockmate-explicit-test-root');
  const certificates = path.join(root, 'certificates');

  it.each([
    [[], /test-root/i],
    [['--test-root', 'relative', '--certificate-directory', certificates], /absolute/i],
    [['--test-root', root, '--certificate-directory', 'relative'], /absolute/i],
    [['--test-root', root, '--certificate-directory', root], /strict descendant/i],
    [['--test-root', root, '--certificate-directory', path.resolve(root, '..', 'escape')], /strict descendant/i],
  ])('rejects unsafe arguments %#', (arguments_, message) => {
    expect(() => parseTestCertificateArguments(arguments_)).toThrow(message);
  });

  it('accepts only an explicit absolute strict descendant', () => {
    expect(parseTestCertificateArguments([
      '--test-root', root,
      '--certificate-directory', certificates,
    ])).toEqual({ testRoot: root, certificateDirectory: certificates });
  });
});
