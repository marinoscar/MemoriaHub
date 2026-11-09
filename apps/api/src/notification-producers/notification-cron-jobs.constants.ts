// =============================================================================
// Self-driven notification producers: permanent job types (RETRO-C9, #612)
// =============================================================================
//
// The hourly review-queue reconcile and the daily share-expiry sweep used to run
// in process on the cron's tick. Their crons now only enqueue; the work runs in
// these two GLOBAL, SERVER-ONLY job types:
//
//   notifications.review_queue_reconcile  ReviewQueueReconcileHandler
//   shares.expiring_sweep                 ShareExpiringHandler
//
// THE TYPE STRINGS ARE PERMANENT once jobs of them exist
// (`test/jobs/job-type-snapshot.spec.ts` pins them).
// =============================================================================

/** `ReviewQueueReconcileHandler`'s permanent job type. */
export const REVIEW_QUEUE_RECONCILE_TYPE = 'notifications.review_queue_reconcile';

/** `ShareExpiringHandler`'s permanent job type. */
export const SHARE_EXPIRING_SWEEP_TYPE = 'shares.expiring_sweep';
