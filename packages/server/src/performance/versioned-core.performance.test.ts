import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { EndpointSummary } from '../domain/model';
import { normalizeHttpOrigin } from '../domain/http-origin';
import type { MatchRequest } from '../repository/compile-project';
import {
  createLargeProject,
  LARGE_PROJECT_SHAPE,
  measureThirtyWarmRuns,
  percentile95,
} from './large-project-fixture';

function bodyIds(
  harness: Awaited<ReturnType<typeof createLargeProject>>,
  projectId: string,
  summaries: readonly EndpointSummary[],
): string[] {
  return summaries.flatMap(summary => harness.repository
    .getEndpoint(projectId, summary.id)
    .variants
    .map(variant => {
      expect(variant.bodyAssetId).toBeDefined();
      return variant.bodyAssetId!;
    }));
}

function expectTwentyCyclicBodyIds(values: readonly string[]): void {
  const distinct = [...new Set(values)];
  expect(distinct).toHaveLength(LARGE_PROJECT_SHAPE.distinctBodies);
  expect(values).toHaveLength(
    LARGE_PROJECT_SHAPE.endpoints * LARGE_PROJECT_SHAPE.variantsPerEndpoint,
  );
  for (const [index, value] of values.entries()) {
    expect(value).toBe(distinct[index % distinct.length]);
  }
}

function bodyIndependentProjection(summary: EndpointSummary): EndpointSummary {
  return { ...summary, projectId: 'prj_projection' };
}

describe('schema v4 server performance', () => {
  it('permanently proves the exact large fixture shape', async () => {
    const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
    try {
      const evidence = harness.fixtureEvidence;
      const summaries = harness.largeBodySummaries;
      const largeBodyIds = bodyIds(harness, 'prj_large', summaries);

      console.info(`server-performance fixture-endpoints=${summaries.length} variants-per-endpoint=${summaries[0]?.variantCount ?? 0} distinct-large-bodies=${new Set(largeBodyIds).size} full-bindings=${Object.keys(evidence.fullState.bindings).length} partial-bindings=${Object.keys(evidence.partialState.bindings).length}`);

      expect(summaries).toHaveLength(LARGE_PROJECT_SHAPE.endpoints);
      expect(summaries.every(
        summary => summary.variantCount === LARGE_PROJECT_SHAPE.variantsPerEndpoint,
      )).toBe(true);
      expectTwentyCyclicBodyIds(largeBodyIds);

      expect(harness.repository.listStates('prj_large')).toHaveLength(2);
      expect(evidence.fullState.id).toBe('state_full');
      expect(evidence.partialState.id).toBe('state_partial');
      expect(Object.keys(evidence.fullState.bindings)).toEqual(
        summaries.map(summary => summary.id),
      );
      expect(Object.keys(evidence.partialState.bindings)).toEqual(
        summaries.filter((_, index) => index % 2 === 0).map(summary => summary.id),
      );
      expect(Object.keys(evidence.partialState.bindings)).toHaveLength(250);
    } finally {
      await harness.dispose();
    }
  });

  it('proves body-independent summaries against one-byte and ten-MiB assets', async () => {
    const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
    try {
      const evidence = harness.fixtureEvidence;
      const smallBodyIds = bodyIds(harness, 'prj_small', harness.smallBodySummaries);
      const largeBodyIds = bodyIds(harness, 'prj_large', harness.largeBodySummaries);

      console.info(`server-performance small-summaries=${harness.smallBodySummaries.length} large-summaries=${harness.largeBodySummaries.length} small-body-bytes=${evidence.smallBodyAssets[0]?.size ?? 0} large-body-bytes=${evidence.largeBodyAssets[0]?.size ?? 0}`);

      expect(harness.smallBodySummaries).toHaveLength(LARGE_PROJECT_SHAPE.endpoints);
      expect(harness.largeBodySummaries).toHaveLength(LARGE_PROJECT_SHAPE.endpoints);
      expect(harness.smallBodySummaries.map(bodyIndependentProjection))
        .toEqual(harness.largeBodySummaries.map(bodyIndependentProjection));
      expectTwentyCyclicBodyIds(smallBodyIds);
      expectTwentyCyclicBodyIds(largeBodyIds);
      expect(evidence.smallBodyAssets).toHaveLength(LARGE_PROJECT_SHAPE.distinctBodies);
      expect(evidence.largeBodyAssets).toHaveLength(LARGE_PROJECT_SHAPE.distinctBodies);
      expect(evidence.smallBodyAssets.every(asset => asset.size === 1)).toBe(true);
      expect(evidence.largeBodyAssets.every(
        asset => asset.size === LARGE_PROJECT_SHAPE.bodyBytes,
      )).toBe(true);
      expect(new Set(evidence.smallBodyAssets.map(asset => asset.id)))
        .toEqual(new Set(smallBodyIds));
      expect(new Set(evidence.largeBodyAssets.map(asset => asset.id)))
        .toEqual(new Set(largeBodyIds));
      expect(harness.largeBodySummaries.every(
        summary => !('variants' in summary) && !('bodyAssetId' in summary) && !('size' in summary),
      )).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('detects an injected whole-body read through the production writer boundary', async () => {
    const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
    try {
      await expect(harness.exerciseWholeBodyReadControl())
        .rejects.toThrow('Whole-body reads are forbidden');

      console.info(`server-performance whole-body-control=${harness.bodyAccess.wholeBodyReadCalls} stream-opens=${harness.bodyAccess.openReadStreamCalls}`);

      expect(harness.bodyAccess.wholeBodyReadCalls).toBe(1);
      expect(harness.bodyAccess.openReadStreamCalls).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('meets repository and matcher p95 gates', async () => {
    const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
    try {
      const request: MatchRequest = {
        origin: normalizeHttpOrigin('http://api.test'),
        method: 'GET',
        path: '/playback/authorize',
        query: { ok: true, entries: [] },
        headers: {},
      };
      const summaryMs = await measureThirtyWarmRuns(
        () => harness.repository.listEndpoints('prj_large'),
      );
      const matcherMs = await measureThirtyWarmRuns(
        () => harness.repository.resolve('prj_large', request),
      );
      const summaryP95 = percentile95(summaryMs);
      const matcherP95 = percentile95(matcherMs);

      console.info(`server-performance summary-p95=${summaryP95.toFixed(3)}ms matcher-p95=${matcherP95.toFixed(3)}ms`);

      expect(summaryP95).toBeLessThanOrEqual(300);
      expect(matcherP95).toBeLessThanOrEqual(10);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps summaries independent of body size and streams bounded chunks', async () => {
    const harness = await createLargeProject(LARGE_PROJECT_SHAPE);
    try {
      const concat = vi.spyOn(Buffer, 'concat');
      try {
        const streamedBytes = await harness.consumeTenMiBResponseIntoCountingSink();

        console.info(`server-performance streamed-bytes=${streamedBytes} max-chunk-bytes=${harness.maximumObservedChunkBytes}`);

        expect(streamedBytes).toBe(10 * 1024 * 1024);
        expect(harness.bodyAccess.openReadStreamCalls).toBe(1);
        expect(harness.bodyAccess.wholeBodyReadCalls).toBe(0);
        expect(concat).not.toHaveBeenCalled();
        expect(harness.maximumObservedChunkBytes).toBeLessThanOrEqual(64 * 1024);
      } finally {
        concat.mockRestore();
      }
    } finally {
      await harness.dispose();
    }
  });
});
