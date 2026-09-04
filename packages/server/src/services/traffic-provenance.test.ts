import { describe, expect, it } from 'vitest';

import type { ResolvedMock } from '../repository/compile-project';
import { debugHeaders } from './traffic-provenance';

function resolved(overrides: Partial<ResolvedMock> = {}): ResolvedMock {
  return {
    projectId: 'prj_1', endpointId: 'ep_1', variantId: 'var_1', selectedStateId: 'state_1',
    resolutionSource: 'project_active_state', fallbackReasons: ['active_state_unbound'],
    status: 201, responseHeaders: {}, delayMs: 0,
    ...overrides,
  };
}

describe('mock debug provenance headers', () => {
  it('emits the complete stable mock-only contract', () => {
    expect(debugHeaders(resolved(), {
      enabled: true,
      projectId: 'prj_1',
      requestId: 'req_1',
    })).toEqual({
      'X-MockMate-Project': 'prj_1',
      'X-MockMate-Endpoint': 'ep_1',
      'X-MockMate-Variant': 'var_1',
      'X-MockMate-State': 'state_1',
      'X-MockMate-Resolution-Source': 'project_active_state',
      'X-MockMate-Fallback-Reason': 'active_state_unbound',
      'X-MockMate-Request-Id': 'req_1',
    });
  });

  it('emits nothing when disabled, unresolved, or passthrough', () => {
    expect(debugHeaders(resolved(), { enabled: false })).toEqual({});
    expect(debugHeaders(undefined, { enabled: true })).toEqual({});
    expect(debugHeaders(resolved(), { enabled: true, passthrough: true })).toEqual({});
  });

  it('omits only an absent optional State', () => {
    expect(debugHeaders(resolved({ selectedStateId: undefined }), { enabled: true }))
      .not.toHaveProperty('X-MockMate-State');
  });

  it.each([
    { endpointId: 'ep_1\r\nX-Leak: yes' },
    { variantId: 'var 1' },
    { selectedStateId: 'state\r\ninjected' },
    { fallbackReasons: ['unsafe reason'] as ResolvedMock['fallbackReasons'] },
  ])('rejects unsafe provenance values', override => {
    expect(debugHeaders(resolved(override), { enabled: true })).toEqual({});
  });

  it('returns fresh records', () => {
    const first = debugHeaders(resolved(), { enabled: true });
    first['X-MockMate-State'] = 'mutated';
    expect(debugHeaders(resolved(), { enabled: true })['X-MockMate-State']).toBe('state_1');
  });
});
