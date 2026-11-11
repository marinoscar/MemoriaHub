// =============================================================================
// The two storage recovery job types (RETRO-D1b, #567)
// =============================================================================
//
// The admin recovery routes of the media slice queue these two host jobs; the host registers their handlers
// (they work on the host's post-upload storage processing) and re-exports the strings.
//
// THE TYPE STRINGS ARE PERMANENT once jobs of them exist.
// =============================================================================

/**
 * The recovery sweep's permanent job type (`media.storage.recover_stuck`): mode `stuck` re-queues objects
 * orphaned at `processing`, mode `failed` re-queues image objects that ended `failed`.
 *
 * @stability experimental
 */
export const STORAGE_RECOVER_STUCK_TYPE = 'media.storage.recover_stuck';

/**
 * The admin bulk reprocess's permanent job type (`media.storage.reprocess`): re-queues processing for the
 * ready or failed media objects of one circle, or of every circle.
 *
 * @stability experimental
 */
export const STORAGE_REPROCESS_TYPE = 'media.storage.reprocess';
