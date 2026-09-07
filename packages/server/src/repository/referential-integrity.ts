import type { ValidationFinding } from '../domain/validation';
import { isStablePathSegment } from '../services/storage';
import type { ValidatedProjectSnapshot } from './snapshot';

function finding(
  code: string,
  file: string,
  path: string,
  message: string,
  recovery: string,
): ValidationFinding {
  return { severity: 'blocking', code, file, path, message, recovery };
}

export function validateReferentialIntegrity(
  snapshot: ValidatedProjectSnapshot,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const { project, settings, endpoints, states, bodyAssets } = snapshot;

  const requireStableId = (value: string | undefined, file: string, path: string): void => {
    if (value !== undefined && !isStablePathSegment(value)) {
      findings.push(finding(
        'INVALID_RECORD_ID', file, path,
        'A persisted ID is not a safe stable segment.',
        'Replace the ID with a non-empty segment without separators, traversal, or NUL bytes.',
      ));
    }
  };

  requireStableId(project.id, 'project.json', '$.id');
  requireStableId(project.activeStateId, 'project.json', '$.activeStateId');
  requireStableId(settings.projectId, 'settings.json', '$.projectId');

  if (settings.projectId !== project.id) {
    findings.push(finding(
      'RECORD_PROJECT_MISMATCH',
      'settings.json',
      '$.projectId',
      'Runtime settings belong to a different Project.',
      'Set projectId to the selected Project ID.',
    ));
  }

  if (project.activeStateId !== undefined && !states.has(project.activeStateId)) {
    findings.push(finding(
      'INVALID_STATE_BINDING',
      'project.json',
      '$.activeStateId',
      'Project activeStateId references a missing App State.',
      'Select an existing App State or clear activeStateId.',
    ));
  }

  const variantOwners = new Map<string, string>();
  const trafficReceiptOwners = new Set<string>();
  for (const endpoint of [...endpoints.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const file = isStablePathSegment(endpoint.id)
      ? `endpoints/${endpoint.id}.json`
      : 'endpoints/<invalid>.json';
    requireStableId(endpoint.id, file, '$.id');
    requireStableId(endpoint.projectId, file, '$.projectId');
    requireStableId(endpoint.defaultVariantId, file, '$.defaultVariantId');
    if (endpoint.projectId !== project.id) {
      findings.push(finding(
        'RECORD_PROJECT_MISMATCH', file, '$.projectId',
        'Endpoint belongs to a different Project.',
        'Set projectId to the selected Project ID.',
      ));
    }

    const fallbackReady = endpoint.defaultVariantId !== undefined
      && endpoint.variants.some(variant => variant.id === endpoint.defaultVariantId);
    if ((endpoint.mode === 'mock' || endpoint.variants.length > 0) && !fallbackReady) {
      findings.push(finding(
        'MISSING_DEFAULT_VARIANT', file, '$.defaultVariantId',
        'Endpoint defaultVariantId does not reference one of its variants.',
        'Choose an existing variant as the Endpoint default.',
      ));
    }

    for (let index = 0; index < endpoint.variants.length; index += 1) {
      const variant = endpoint.variants[index];
      requireStableId(variant.id, file, `$.variants[${index}].id`);
      requireStableId(variant.endpointId, file, `$.variants[${index}].endpointId`);
      if (variant.endpointId !== endpoint.id) {
        findings.push(finding(
          'VARIANT_ENDPOINT_MISMATCH', file, `$.variants[${index}].endpointId`,
          'Response Variant belongs to a different Endpoint.',
          'Set endpointId to the containing Endpoint ID.',
        ));
      }

      const existingOwner = variantOwners.get(variant.id);
      if (existingOwner !== undefined) {
        findings.push(finding(
          'DUPLICATE_RECORD_ID', file, `$.variants[${index}].id`,
          `Response Variant ID is already used by Endpoint ${existingOwner}.`,
          'Assign every Response Variant a unique stable ID.',
        ));
      } else {
        variantOwners.set(variant.id, endpoint.id);
      }

      if (variant.bodyAssetId !== undefined && !bodyAssets.has(variant.bodyAssetId)) {
        findings.push(finding(
          'MISSING_BODY_ASSET', file, `$.variants[${index}].bodyAssetId`,
          'Response Variant references an unavailable or corrupt Body Asset.',
          'Restore the Body Asset or clear the body reference.',
        ));
      }
      for (let provenanceIndex = 0;
        provenanceIndex < (variant.trafficProvenance?.length ?? 0);
        provenanceIndex += 1) {
        const provenance = variant.trafficProvenance![provenanceIndex];
        const provenancePath = `$.variants[${index}].trafficProvenance[${provenanceIndex}]`;
        if (provenance.endpointId !== endpoint.id) {
          findings.push(finding(
            'TRAFFIC_PROVENANCE_ENDPOINT_MISMATCH', file, `${provenancePath}.endpointId`,
            'Traffic provenance belongs to a different Endpoint.',
            'Restore the immutable promotion receipt to its owning Endpoint.',
          ));
        }
        if (provenance.variantId !== variant.id) {
          findings.push(finding(
            'TRAFFIC_PROVENANCE_VARIANT_MISMATCH', file, `${provenancePath}.variantId`,
            'Traffic provenance belongs to a different Response Variant.',
            'Restore the immutable promotion receipt to its owning Response Variant.',
          ));
        }
        if (provenance.stateTarget === 'bound' && provenance.stateId === undefined) {
          findings.push(finding(
            'TRAFFIC_PROVENANCE_STATE_INVALID', file, `${provenancePath}.stateId`,
            'Bound Traffic provenance requires an App State ID.',
            'Restore the immutable reviewed State target.',
          ));
        }
        if (provenance.stateTarget === 'unbound' && provenance.stateId !== undefined) {
          findings.push(finding(
            'TRAFFIC_PROVENANCE_STATE_INVALID', file, `${provenancePath}.stateId`,
            'Unbound Traffic provenance cannot reference an App State.',
            'Remove the State ID from the unbound receipt.',
          ));
        }
        if (trafficReceiptOwners.has(provenance.trafficId)) {
          findings.push(finding(
            'DUPLICATE_TRAFFIC_RECEIPT', file, provenancePath,
            'Traffic ID is already represented by another promotion receipt.',
            'Keep exactly one immutable receipt for each promoted Traffic ID.',
          ));
        } else {
          trafficReceiptOwners.add(provenance.trafficId);
        }
      }
    }
  }

  for (const state of [...states.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const file = isStablePathSegment(state.id)
      ? `states/${state.id}.json`
      : 'states/<invalid>.json';
    requireStableId(state.id, file, '$.id');
    requireStableId(state.projectId, file, '$.projectId');
    if (state.projectId !== project.id) {
      findings.push(finding(
        'RECORD_PROJECT_MISMATCH', file, '$.projectId',
        'App State belongs to a different Project.',
        'Set projectId to the selected Project ID.',
      ));
    }

    for (const [endpointId, variantId] of Object.entries(state.bindings).sort(([left], [right]) => (
      left.localeCompare(right)
    ))) {
      requireStableId(endpointId, file, '$.bindings');
      requireStableId(variantId, file, '$.bindings');
      const endpoint = endpoints.get(endpointId);
      if (!endpoint || !endpoint.variants.some(variant => variant.id === variantId)) {
        findings.push(finding(
          'INVALID_STATE_BINDING', file, '$.bindings',
          `App State binding ${endpointId} -> ${variantId} is invalid.`,
          'Bind only existing Endpoints to one of their own Response Variants.',
        ));
      }
    }
  }

  return findings;
}
