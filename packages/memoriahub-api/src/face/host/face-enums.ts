// =============================================================================
// The enum values the face slice names
// =============================================================================
//
// The values of the domain schema's enums (`MediaFaceStatusType`, `JobReason`, `MediaType`),
// as plain string constants: the slice imports no generated client. The strings are what the
// database stores and never change.
// =============================================================================

/**
 * `MediaFaceStatusType`: the state of a media item's face detection.
 *
 * @stability experimental
 */
export const MediaFaceStatusType = {
  not_processed: 'not_processed',
  pending: 'pending',
  processing: 'processing',
  processed: 'processed',
  failed: 'failed',
  no_faces: 'no_faces',
} as const;

/** One value of {@link MediaFaceStatusType}. @stability experimental */
export type MediaFaceStatusType = (typeof MediaFaceStatusType)[keyof typeof MediaFaceStatusType];

/**
 * `JobReason`: why a job was queued.
 *
 * @stability experimental
 */
export const JobReason = { upload: 'upload', rerun: 'rerun', backfill: 'backfill' } as const;

/** One value of {@link JobReason}. @stability experimental */
export type JobReason = (typeof JobReason)[keyof typeof JobReason];

/**
 * `MediaType`: a photo or a video.
 *
 * @stability experimental
 */
export const MediaType = { photo: 'photo', video: 'video' } as const;

/** One value of {@link MediaType}. @stability experimental */
export type MediaType = (typeof MediaType)[keyof typeof MediaType];
