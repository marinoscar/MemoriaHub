// =============================================================================
// MemoriaHub's own verdict rules (RETRO-T3, #628)
// =============================================================================
//
// The thresholds of the four rules `MemoriaHubVerdictPolicy` adds on top of the
// platform verdict, in ONE exported constant so RETRO-H5's alert rules reuse the
// same numbers. The platform's own thresholds stay in
// `platform/telemetry/memoriahub-verdict-thresholds.ts` (`verdictThresholds`).
//
//   enrichment failure ratio  per MemoriaHub job type, failed / (succeeded + failed)
//                             over the window: > 10 % degraded, > 25 % critical,
//                             only with at least 50 settled jobs of that type
//   oldest pending upload job the five upload-time types: > 30 min degraded,
//                             > 2 h critical
//   processing backlog        storage objects at `processing` for the whole window
//                             (every sample): > 50 degraded, > 500 critical
//   idle fleet                > 500 node-eligible jobs pending, worker nodes are
//                             registered and none is online: degraded
//
// THE WINDOW IS FIXED (`windowMinutes`): the platform's `VerdictInput` carries
// neither the dashboard's range nor any app metric, and `VerdictPolicy.compute` is
// synchronous, so these rules read PostgreSQL (the `jobs`, `storage_objects` and
// `worker_nodes` tables) through `MemoriaHubTelemetrySignals`, refreshed in the
// background at most once a minute. Seam gap reported on #628 (see
// docs/platform-adoption/local-exceptions.md).
//
// PLATFORM-ADOPTION-SHIM(#628): the verdict reads PostgreSQL because the platform's
// `VerdictInput` carries no window and no app metric (seam gap; local-exceptions.md).
// =============================================================================

/** The job types MemoriaHub's enrichment failure rule judges (each separately). */
export const MEMORIAHUB_ENRICHMENT_JOB_TYPES = [
  'face_detection',
  'video_face_detection',
  'auto_tagging',
  'video_auto_tagging',
  'metadata_extraction',
  'geocode',
  'social_media_detection',
  'duplicate_detection',
  'duplicate_detection_batch',
  'burst_detection',
  'thumbnail_regen',
  'location_inference',
  'picture_enhancement',
  'memory_generation',
] as const;

/** The job types every upload enqueues: a stale one means the import is not moving. */
export const MEMORIAHUB_UPLOAD_JOB_TYPES = [
  'face_detection',
  'auto_tagging',
  'metadata_extraction',
  'thumbnail_regen',
  'social_media_detection',
] as const;

export const MEMORIAHUB_VERDICT_RULES = {
  /** The look-back of the failure ratio and of the sustained-backlog rule. */
  windowMinutes: 60,
  enrichmentFailurePct: { degraded: 10, critical: 25, minSettled: 50 },
  uploadOldestPendingMinutes: { degraded: 30, critical: 120 },
  processingBacklog: {
    degraded: 50,
    critical: 500,
    /** "Sustained" needs samples spanning at least this long (one sample a minute at most). */
    minSpanMinutes: 15,
  },
  idleFleet: { minNodeEligiblePending: 500 },
} as const;

export type MemoriaHubVerdictRules = typeof MEMORIAHUB_VERDICT_RULES;
