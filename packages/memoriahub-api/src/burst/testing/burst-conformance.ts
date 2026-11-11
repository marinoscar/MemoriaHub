import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { UploadEnrichmentRegistry, UploadEnrichmentService } from '../../media/index.js';

// =============================================================================
// describeBurstSliceConformance (RETRO-J10, #624)
// =============================================================================
//
// The executable proof of the burst slice's registration with the media slice. Test-runner neutral.
//
//   fan-out   a new photo queues `burst_detection` at priority 5 when `features.burstDetection`
//             is on, nothing when it is off, and a video never queues it.
// =============================================================================

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface BurstSliceUnderTest {
  /** The media slice's registry (the burst registration is already in it). */
  registry: UploadEnrichmentRegistry;
  /** The media slice's fan-out service. */
  fanout: UploadEnrichmentService;
  /** Turns `features.burstDetection` on or off. */
  setFeature(enabled: boolean): void | Promise<void>;
  /** The jobs queued so far (type, priority). */
  queuedJobs(): Array<{ type: string; priority?: number }> | Promise<Array<{ type: string; priority?: number }>>;
}

/**
 * Options of {@link describeBurstSliceConformance}.
 *
 * @stability experimental
 */
export interface BurstSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): BurstSliceUnderTest | Promise<BurstSliceUnderTest>;
}

/**
 * Runs the burst slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeBurstSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: BurstSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;
  const item = (type: string) => ({ id: 'm1', type, circleId: 'lib-1', deletedAt: null });

  describe(`burst slice conformance: ${options.name}`, () => {
    it('registers burst_detection for photos, ahead of duplicate detection (priority 5)', async () => {
      const slice = await options.create();
      await slice.setFeature(true);

      await slice.fanout.enqueueUploadEnrichment(item('photo'));

      expect(await slice.queuedJobs()).toEqual([{ type: 'burst_detection', priority: 5 }]);
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

      expect(slice.registry.forMediaType('video').map((entry) => entry.type)).not.toContain('burst_detection');
      expect(await slice.queuedJobs()).toEqual([]);
    });
  });
}
