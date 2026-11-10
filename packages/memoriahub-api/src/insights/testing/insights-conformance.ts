import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { InsightsService } from '../insights.service.js';

// =============================================================================
// describeInsightsSliceConformance (RETRO-J10, #624)
// =============================================================================
//
// The executable proof that the storage-insights slice behaves the same wherever it is hosted.
// Test-runner neutral: the caller hands over `describe`, `it` and `expect`.
//
//   snapshot   the metrics document carries every byte count as a STRING (a BigInt never reaches
//              JSON) and folds the stored bytes by provider and kind;
//   refresh    a refresh enqueues the global `storage_insights` job (no subject) and reports its
//              status.
// =============================================================================

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface InsightsSliceUnderTest {
  /** The service. */
  service: InsightsService;
  /** Seeds the aggregates the next `computeMetrics` reads: one photo row of 2 items / 300 bytes and its storage breakdown. */
  seedLibrary(): void | Promise<void>;
  /** The jobs queued so far (`type`, `subjectType`). */
  queuedJobs(): Array<{ type: string; subjectType: string | null }> | Promise<Array<{ type: string; subjectType: string | null }>>;
}

/**
 * Options of {@link describeInsightsSliceConformance}.
 *
 * @stability experimental
 */
export interface InsightsSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): InsightsSliceUnderTest | Promise<InsightsSliceUnderTest>;
}

/**
 * Runs the insights slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeInsightsSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: InsightsSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`insights slice conformance: ${options.name}`, () => {
    describe('snapshot', () => {
      it('serialises every byte count as a string, so the snapshot is JSON-safe', async () => {
        const { service, seedLibrary } = await options.create();
        await seedLibrary();

        const metrics = await service.computeMetrics();

        expect(typeof metrics.totalBytes).toBe('string');
        expect(typeof metrics.photoBytes).toBe('string');
        expect(typeof metrics.videoBytes).toBe('string');
        expect(() => JSON.stringify(metrics)).not.toThrow();
        expect(metrics.totalBytes).toBe('300');
        expect(metrics.totalItems).toBe(2);
      });

      it('folds stored bytes by provider and kind and counts trashed originals', async () => {
        const { service, seedLibrary } = await options.create();
        await seedLibrary();

        const metrics = await service.computeMetrics();

        expect(metrics.storageBreakdown).toEqual([{ provider: 's3', kind: 'photo', bytes: '300' }]);
        expect(metrics.trashBytes).toBe('100');
      });
    });

    describe('refresh', () => {
      it('enqueues the global storage_insights job, with no subject', async () => {
        const { service, queuedJobs } = await options.create();

        await service.enqueueRefresh('rerun', 0);

        expect(await queuedJobs()).toEqual([{ type: 'storage_insights', subjectType: null }]);
      });
    });
  });
}
