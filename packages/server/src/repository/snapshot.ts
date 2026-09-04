import type {
  AppState,
  BodyAsset,
  EndpointDetail,
  Project,
  ProjectRuntimeSettings,
} from '../domain/model';

export interface ValidatedProjectSnapshot {
  project: Project;
  settings: ProjectRuntimeSettings;
  endpoints: ReadonlyMap<string, EndpointDetail>;
  states: ReadonlyMap<string, AppState>;
  bodyAssets: ReadonlyMap<string, BodyAsset>;
  generationId: string;
}

export function cloneSnapshot(snapshot: ValidatedProjectSnapshot): ValidatedProjectSnapshot {
  return {
    project: structuredClone(snapshot.project),
    settings: structuredClone(snapshot.settings),
    endpoints: new Map([...snapshot.endpoints].map(([id, endpoint]) => [id, structuredClone(endpoint)])),
    states: new Map([...snapshot.states].map(([id, state]) => [id, structuredClone(state)])),
    bodyAssets: new Map([...snapshot.bodyAssets].map(([id, asset]) => [id, structuredClone(asset)])),
    generationId: snapshot.generationId,
  };
}
