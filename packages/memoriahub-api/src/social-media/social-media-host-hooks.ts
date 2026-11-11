// =============================================================================
// What the social-media slice needs of the host that is not a port (RETRO-J10, #624)
// =============================================================================
//
// One hook and one options object. The video fan-out after a CLEAN verdict belongs to the host's media
// enrichment service (it routes to face detection and video tagging, which have their own gates); the
// slice calls it through the hook. Each token's description string is permanent.
// =============================================================================

/**
 * Injection token of {@link SocialMediaPostDetection}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const SOCIAL_MEDIA_POST_DETECTION = Symbol.for('@marinoscar/memoriahub/SOCIAL_MEDIA_POST_DETECTION');

/**
 * The video fan-out withheld while a video was being classified: the host enqueues its face detection
 * and video tagging jobs for the item (each behind its own gate), best-effort and never throwing. The
 * slice calls it after a CLEAN verdict commits, and when social-media detection is switched off at
 * upload (so that case keeps the behaviour from before the feature existed). A DETECTED verdict never
 * calls it.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface SocialMediaPostDetection {
  /**
   * Enqueues the withheld video enrichment for one item.
   *
   * @param item - the media item (`id`, `type`, `circleId`, `deletedAt`).
   * @param reason - why the detection job was queued (`upload`, `rerun` or `backfill`), which sets the priority.
   */
  enqueueVideoPostDetectionEnrichment(
    item: { id: string; type: string; circleId: string; deletedAt: Date | null },
    reason: string,
  ): Promise<void>;
}

/**
 * Injection token of {@link SocialMediaModuleOptions}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const SOCIAL_MEDIA_OPTIONS = Symbol.for('@marinoscar/memoriahub/SOCIAL_MEDIA_OPTIONS');

/**
 * The default budget of the detection job: the video bucket (20 minutes).
 *
 * @stability experimental
 */
export const DEFAULT_SOCIAL_VIDEO_JOB_TIMEOUT_MS = 1_200_000;

/**
 * Options of `SocialMediaModule.forRoot`.
 *
 * @stability experimental
 */
export interface SocialMediaModuleOptions {
  /** The job's `maxRuntimeMs` (default 20 minutes, the video bucket). */
  videoJobTimeoutMs?: number;
}
