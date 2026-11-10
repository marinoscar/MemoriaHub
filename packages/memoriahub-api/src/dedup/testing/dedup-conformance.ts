import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { UploadEnrichmentRegistry, UploadEnrichmentService } from '../../media/index.js';

// =============================================================================
// describeDedupSliceConformance (RETRO-J10, #624)
// =============================================================================
//
// The executable proof of the dedup slice's registration with the media slice. Test-runner neutral.
//
//   fan-out   a new photo queues `duplicate_detection` at priority 10 when `features.duplicateDetection`
//             is on, nothing when it is off, and a video never queues it.
// =============================================================================

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface DedupSliceUnderTest {
  /** The media slice's registry (the dedup registration is already in it). */
  registry: UploadEnrichmentRegistry;
  /** The media slice's fan-out service. */
  fanout: UploadEnrichmentService;
  /** Turns `features.duplicateDetection` on or off. */
  setFeature(enabled: boolean): void | Promise<void>;
  /** The jobs queued so far (type, priority). */
  queuedJobs(): Array<{ type: string; priority?: number }> | Promise<Array<{ type: string; priority?: number }>>;
}

/**
 * Options of {@link describeDedupSliceConformance}.
 *
 * @stability experimental
 */
export interface DedupSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): DedupSliceUnderTest | Promise<DedupSliceUnderTest>;
}

/**
 * Runs the dedup slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeDedupSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: DedupSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;
  const item = (type: string) => ({ id: 'm1', type, circleId: 'lib-1', deletedAt: null });

  describe(`dedup slice conformance: ${options.name}`, () => {
    it('registers duplicate_detection for photos, ahead of nothing but burst (priority 10)', async () => {
      const slice = await options.create();
      await slice.setFeature(true);

      await slice.fanout.enqueueUploadEnrichment(item('photo'));

      expect(await slice.queuedJobs()).toEqual([{ type: 'duplicate_detection', priority: 10 }]);
    });

    it('queues nothing while the feature is off', async () => {
      const slice = await options.create();
      await slice.setFeature(false);

      await slice.fanout.enqueueUploadEnrichment(item('photo'));

      expect(await slice.queuedJobs()).toEqual([]);
    });

    it('never queues it for a video', async () => {
      const slice = await options.create();
      await slice.setFeature(true);

      await slice.fanout.enqueueUploadEnrichment(item('video'));

      expect(slice.registry.forMediaType('video').map((entry) => entry.type)).not.toContain('duplicate_detection');
      expect(await slice.queuedJobs()).toEqual([]);
    });
  });
}
