// =============================================================================
// The review-queue notification events and the reconcile job type (epic #240, RETRO-C9, RETRO-J10)
// =============================================================================
//
// THE EVENT KEYS AND THE JOB TYPE ARE PERMANENT: an inbox row, a user preference and a queued job name
// them. Add one; never rename or reuse.
// =============================================================================

/**
 * The four review-queue STATE events: one live row per (user, library, event), refreshed in place and
 * dismissed when the queue drains. Permanent.
 *
 * @stability experimental
 */
export const REVIEW_QUEUE_EVENT_KEYS = {
  /** Burst groups waiting for review. */
  bursts: 'review.bursts',
  /** Near-duplicate groups waiting for review. */
  duplicates: 'review.duplicates',
  /** Inferred locations waiting to be accepted or rejected. */
  locationSuggestions: 'review.location_suggestions',
  /** AI enhancements waiting to be kept, replaced or discarded. */
  enhancements: 'review.enhancements',
} as const;

/**
 * The permanent job type of the hourly review-queue reconcile.
 *
 * @stability experimental
 */
export const REVIEW_QUEUE_RECONCILE_TYPE = 'notifications.review_queue_reconcile';
