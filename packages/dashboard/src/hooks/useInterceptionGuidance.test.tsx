import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { interceptionGuidanceApi } from '../api/client';
import { useInterceptionGuidance } from './useInterceptionGuidance';

vi.mock('../api/client', () => ({ interceptionGuidanceApi: { get: vi.fn() } }));

const guidance = {
  configuredPatterns: ['api.example.test'],
  origins: [{
    origin: 'https://api.example.test', hostname: 'api.example.test', source: 'import' as const,
    coveredBy: 'api.example.test', missing: false,
  }],
  unusedPatterns: [],
};

describe('useInterceptionGuidance', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads sorted unique ephemeral origins with an abortable owner', async () => {
    vi.mocked(interceptionGuidanceApi.get).mockResolvedValue(guidance);
    const { result } = renderHook(() => useInterceptionGuidance('prj_1', [
      'https://z.example.test', 'https://api.example.test', 'https://z.example.test',
    ]));

    await waitFor(() => expect(result.current.guidance).toEqual(guidance));
    expect(interceptionGuidanceApi.get).toHaveBeenCalledWith('prj_1', [
      'https://api.example.test', 'https://z.example.test',
    ], expect.any(AbortSignal));
  });

  it('drops stale guidance when the Project changes', async () => {
    vi.mocked(interceptionGuidanceApi.get)
      .mockResolvedValueOnce(guidance)
      .mockResolvedValueOnce({ ...guidance, configuredPatterns: ['other.test'] });
    const { result, rerender } = renderHook(
      ({ projectId }) => useInterceptionGuidance(projectId, []),
      { initialProps: { projectId: 'prj_1' } },
    );
    await waitFor(() => expect(result.current.guidance).toEqual(guidance));

    rerender({ projectId: 'prj_2' });
    expect(result.current.guidance).toBeUndefined();
    await waitFor(() => expect(result.current.guidance?.configuredPatterns).toEqual(['other.test']));
  });
});
