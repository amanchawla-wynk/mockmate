import { describe, expect, it } from 'vitest';

import type { BodyAsset } from '../domain/model';
import { endpointRecord, projectRecord, settingsRecord, stateRecord } from '../test-support/project-builder';
import { validateReferentialIntegrity } from './referential-integrity';
import type { ValidatedProjectSnapshot } from './snapshot';

function snapshot(): ValidatedProjectSnapshot {
  return {
    project: projectRecord({ activeStateId: 'state_1', baseStateId: 'state_1' }),
    settings: settingsRecord(),
    endpoints: new Map([['ep_1', endpointRecord()]]),
    states: new Map([['state_1', stateRecord()]]),
    bodyAssets: new Map(),
    generationId: 'gen_current',
  };
}

function codes(candidate: ValidatedProjectSnapshot): string[] {
  return validateReferentialIntegrity(candidate).map(finding => finding.code);
}

describe('validateReferentialIntegrity', () => {
  it('accepts a complete internally consistent snapshot', () => {
    expect(validateReferentialIntegrity(snapshot())).toEqual([]);
  });

  it('requires a mock endpoint default variant', () => {
    const candidate = snapshot();
    candidate.endpoints = new Map([['ep_1', endpointRecord({ defaultVariantId: 'missing' })]]);
    expect(codes(candidate)).toContain('MISSING_DEFAULT_VARIANT');
  });

  it('allows a passthrough endpoint without variants or fallback', () => {
    const candidate = snapshot();
    candidate.endpoints = new Map([['ep_1', endpointRecord({
      mode: 'passthrough', variants: [], defaultVariantId: undefined,
    })]]);
    delete candidate.project.activeStateId;
    delete candidate.project.baseStateId;
    candidate.states = new Map();
    expect(validateReferentialIntegrity(candidate)).toEqual([]);
  });

  it('requires passthrough Endpoints with variants to retain a fallback', () => {
    const candidate = snapshot();
    candidate.endpoints = new Map([['ep_1', endpointRecord({
      mode: 'passthrough', defaultVariantId: undefined,
    })]]);
    expect(codes(candidate)).toContain('MISSING_DEFAULT_VARIANT');
  });

  it('requires every variant to belong to its containing endpoint', () => {
    const candidate = snapshot();
    const endpoint = endpointRecord();
    endpoint.variants[0].endpointId = 'ep_other';
    candidate.endpoints = new Map([['ep_1', endpoint]]);
    expect(codes(candidate)).toContain('VARIANT_ENDPOINT_MISMATCH');
  });

  it('requires Traffic provenance to belong to its containing Endpoint and Variant', () => {
    const candidate = snapshot();
    const endpoint = endpointRecord();
    endpoint.variants[0].trafficProvenance = [{
      type: 'traffic',
      trafficId: 'trf_1',
      trafficGeneration: 'tg_1',
      capturedAt: '2026-09-02T00:00:00.000Z',
      requestOrigin: 'https://api.example.test',
      responseIdentity: 'resp_1',
      endpointTarget: 'reuse',
      endpointId: 'ep_other',
      endpointCreated: false,
      variantId: 'var_other',
      variantCreated: false,
      endpointModeChanged: false,
      stateTarget: 'bound',
      stateId: 'state_missing',
      bindingChanged: true,
    }];
    candidate.endpoints = new Map([['ep_1', endpoint]]);

    expect(codes(candidate)).toEqual(expect.arrayContaining([
      'TRAFFIC_PROVENANCE_ENDPOINT_MISMATCH',
      'TRAFFIC_PROVENANCE_VARIANT_MISMATCH',
    ]));
    expect(codes(candidate)).not.toContain('TRAFFIC_PROVENANCE_STATE_INVALID');
  });

  it('rejects duplicate variant IDs across endpoint records', () => {
    const candidate = snapshot();
    const second = endpointRecord({ id: 'ep_2', defaultVariantId: 'var_1' });
    second.variants[0].endpointId = 'ep_2';
    candidate.endpoints = new Map([['ep_1', endpointRecord()], ['ep_2', second]]);
    expect(codes(candidate)).toContain('DUPLICATE_RECORD_ID');
  });

  it('checks Project state references and App State endpoint/variant bindings', () => {
    const candidate = snapshot();
    candidate.project.activeStateId = 'missing';
    candidate.states = new Map([[
      'state_1',
      stateRecord({ bindings: { missing_endpoint: 'missing_variant', ep_1: 'missing_variant' } }),
    ]]);
    expect(codes(candidate).filter(code => code === 'INVALID_STATE_BINDING')).toHaveLength(3);
  });

  it('requires project ownership for settings, endpoints, and states', () => {
    const candidate = snapshot();
    candidate.settings = settingsRecord({ projectId: 'foreign' });
    candidate.endpoints = new Map([['ep_1', endpointRecord({ projectId: 'foreign' })]]);
    candidate.states = new Map([['state_1', stateRecord({ projectId: 'foreign' })]]);
    expect(codes(candidate).filter(code => code === 'RECORD_PROJECT_MISMATCH')).toHaveLength(3);
  });

  it('requires validated metadata and content for each referenced body', () => {
    const candidate = snapshot();
    const endpoint = endpointRecord();
    endpoint.variants[0].bodyAssetId = 'a'.repeat(64);
    candidate.endpoints = new Map([['ep_1', endpoint]]);
    expect(codes(candidate)).toContain('MISSING_BODY_ASSET');

    const asset: BodyAsset = {
      schemaVersion: 4,
      id: 'a'.repeat(64),
      mediaType: 'text/plain',
      size: 1,
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    candidate.bodyAssets = new Map([[asset.id, asset]]);
    expect(codes(candidate)).not.toContain('MISSING_BODY_ASSET');
  });

  it.each([
    ['Project', (candidate: ValidatedProjectSnapshot) => { candidate.project.id = 'prj\\unsafe'; }],
    ['Endpoint', (candidate: ValidatedProjectSnapshot) => {
      const endpoint = endpointRecord({ id: '../endpoint' });
      endpoint.variants[0].endpointId = endpoint.id;
      candidate.endpoints = new Map([[endpoint.id, endpoint]]);
    }],
    ['App State', (candidate: ValidatedProjectSnapshot) => {
      const state = stateRecord({ id: 'state/unsafe' });
      candidate.states = new Map([[state.id, state]]);
    }],
    ['Response Variant', (candidate: ValidatedProjectSnapshot) => {
      const endpoint = endpointRecord({ defaultVariantId: 'var\\unsafe' });
      endpoint.variants[0].id = 'var\\unsafe';
      candidate.endpoints = new Map([[endpoint.id, endpoint]]);
    }],
  ])('rejects an unsafe persisted %s ID', (_name, mutate) => {
    const candidate = snapshot();
    mutate(candidate);
    expect(codes(candidate)).toContain('INVALID_RECORD_ID');
  });
});
