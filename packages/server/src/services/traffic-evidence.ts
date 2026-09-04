import type { TrafficAppStateContext, TrafficRoutingEvidence } from '../domain/traffic';
import type { ProjectRepository } from '../repository/project-repository';
import type { RuntimeRoutingDecision } from './runtime-decision';

export function currentTrafficAppState(
  repository: ProjectRepository,
  projectId: string,
): TrafficAppStateContext {
  const project = repository.getProject(projectId);
  const fallbackReasons: TrafficAppStateContext['fallbackReasons'] = [];
  if (project.appStateMode === 'disabled') fallbackReasons.push('app_state_mode_disabled');
  else {
    if (project.activeStateId === undefined) fallbackReasons.push('active_state_not_set');
    if (project.baseStateId === undefined) fallbackReasons.push('base_state_not_set');
  }
  return {
    mode: project.appStateMode,
    ...(project.activeStateId === undefined ? {} : { activeStateId: project.activeStateId }),
    ...(project.baseStateId === undefined ? {} : { baseStateId: project.baseStateId }),
    fallbackReasons,
  };
}

export function projectTrafficDecision(
  decision: Exclude<RuntimeRoutingDecision, { kind: 'blind' }>,
  appState: TrafficAppStateContext,
): TrafficRoutingEvidence {
  if (decision.kind === 'mock') {
    return {
      decision: 'mock',
      endpoint: {
        id: decision.endpoint.endpointId,
        name: decision.endpoint.endpointName,
        specificity: decision.endpoint.specificity,
        mode: 'mock',
      },
      variantId: decision.endpoint.resolved.variantId,
      ...(decision.endpoint.resolved.bodyAssetId === undefined
        ? {}
        : { bodyAssetId: decision.endpoint.resolved.bodyAssetId }),
      appState: {
        ...appState,
        ...(decision.endpoint.resolved.selectedStateId === undefined
          ? {}
          : { selectedStateId: decision.endpoint.resolved.selectedStateId }),
        resolutionSource: decision.endpoint.resolved.resolutionSource,
        fallbackReasons: [...decision.endpoint.resolved.fallbackReasons],
      },
    };
  }
  if (decision.reason === 'endpoint_passthrough'
    || decision.reason === 'direct_passthrough_unavailable') {
    return {
      decision: decision.reason,
      endpoint: {
        id: decision.endpoint.endpointId,
        name: decision.endpoint.endpointName,
        specificity: decision.endpoint.specificity,
        mode: 'passthrough',
      },
      appState,
    };
  }
  return {
    decision: decision.reason,
    ...(decision.provenanceReason === undefined ? {} : { reason: decision.provenanceReason }),
    appState,
  };
}
