import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RepositoryDiagnostic } from '../api/types';
import { RepositoryDiagnostics } from './RepositoryDiagnostics';

const corruptEndpoint: RepositoryDiagnostic = {
  severity: 'blocking',
  code: 'MALFORMED_JSON',
  file: 'projects/prj_1/endpoints/ep_bad.json',
  message: 'Endpoint is corrupt',
  recovery: 'Correct the Endpoint JSON and reload the Project.',
  requestId: 'req_42',
};

describe('RepositoryDiagnostics', () => {
  it('shows corruption recovery and diagnostic request IDs with no active Project', () => {
    render(<RepositoryDiagnostics diagnostics={[corruptEndpoint]} />);
    expect(screen.getByText(corruptEndpoint.recovery)).toBeVisible();
    expect(screen.getByText('Request req_42')).toBeVisible();
  });
});
