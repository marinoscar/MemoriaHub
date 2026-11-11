import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { UploadEnrichmentRegistry, UploadEnrichmentService } from '../../media/index.js';

// =============================================================================
// describeSocialMediaSliceConformance (RETRO-J10, #624)
// =============================================================================
//
// The executable proof of the social-media slice's registration with the media slice. Test-runner neutral.
//
//   fan-out   a new video queues `social_media_detection` at priority 10 (and marks the item `pending`)
//             when `features.socialMediaDetection` is on, and the face and tagging jobs are withheld;
//             with the feature off the post-detection fan-out runs directly and no detection job is
//             queued; a photo never queues it.
// =============================================================================

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface SocialMediaSliceUnderTest {
  /** The media slice's registry (the social-media registration is already in it). */
  registry: UploadEnrichmentRegistry;
  /** The media slice's fan-out service. */
  fanout: UploadEnrichmentService;
  /** Turns `features.socialMediaDetection` on or off. */
  setFeature(enabled: boolean): void | Promise<void>;
  /** The jobs queued so far (type, priority). */
  queuedJobs(): Array<{ type: string; priority?: number }> | Promise<Array<{ type: string; priority?: number }>>;
  /** The item ids the post-detection fan-out ran for. */
  postDetectionItems(): string[] | Promise<string[]>;
  /** The items marked `pending` in `media_social_status`. */
  pendingStatusItems(): string[] | Promise<string[]>;
}

/**
 * Options of {@link describeSocialMediaSliceConformance}.
 *
 * @stability experimental
 */
export interface SocialMediaSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): SocialMediaSliceUnderTest | Promise<SocialMediaSliceUnderTest>;
}

/**
 * Runs the social-media slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeSocialMediaSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: SocialMediaSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;
  const item = (type: string) => ({ id: 'm1', type, circleId: 'lib-1', deletedAt: null });

  describe(`social-media slice conformance: ${options.name}`, () => {
    it('queues social_media_detection for a video at priority 10 and marks it pending', async () => {
      const slice = await options.create();
      await slice.setFeature(true);

      await slice.fanout.enqueueUploadEnrichment(item('video'));

      expect(await slice.queuedJobs()).toEqual([{ type: 'social_media_detection', priority: 10 }]);
      expect(await slice.pendingStatusItems()).toEqual(['m1']);
      expect(await slice.postDetectionItems()).toEqual([]);
    });

    it('runs the post-detection fan-out directly while the feature is off', async () => {
      const slice = await options.create();
      await slice.setFeature(false);

      await slice.fanout.enqueueUploadEnrichment(item('video'));

      expect(await slice.queuedJobs()).toEqual([]);
      expect(await slice.postDetectionItems()).toEqual(['m1']);
    });

    it('never queues it for a photo', async () => {
      const slice = await options.create();
      await slice.setFeature(true);

      await slice.fanout.enqueueUploadEnrichment(item('photo'));

      expect(slice.registry.forMediaType('photo').map((entry) => entry.type)).not.toContain('social_media_detection');
      expect(await slice.queuedJobs()).toEqual([]);
    });
  });
}
