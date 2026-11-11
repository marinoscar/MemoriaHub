// =============================================================================
// Constants of the social-media slice (RETRO-J10, #624)
// =============================================================================
//
// The slice imports no generated client, so the enum values it reads and writes are named here. Each
// value is the database enum's literal (`media_type`, `media_social_status_type`, `media_tag_source`,
// `job_reason`); a change to the schema's enum is a change to this file.
// =============================================================================

/**
 * The job type of the detection job. A job `type` string is permanent once jobs of that type exist.
 *
 * @stability experimental
 */
export const SOCIAL_MEDIA_JOB_TYPE = 'social_media_detection';

/**
 * The `media_type` literals the slice reads.
 *
 * @stability experimental
 */
export const SOCIAL_MEDIA_TYPE = { photo: 'photo', video: 'video' } as const;

/**
 * The `media_social_status_type` literals.
 *
 * @stability experimental
 */
export const SOCIAL_STATUS = {
  not_processed: 'not_processed',
  pending: 'pending',
  processing: 'processing',
  processed: 'processed',
  failed: 'failed',
} as const;

/** One value of {@link SOCIAL_STATUS}. */
type SocialStatusValue = (typeof SOCIAL_STATUS)[keyof typeof SOCIAL_STATUS];

/**
 * A `media_social_status_type` literal.
 *
 * @stability experimental
 */
export type SocialStatus = SocialStatusValue;

/**
 * The `media_tag_source` literals the slice writes.
 *
 * @stability experimental
 */
export const SOCIAL_TAG_SOURCE = { manual: 'manual', ai: 'ai', system: 'system' } as const;

/**
 * The `job_reason` literals.
 *
 * @stability experimental
 */
export const SOCIAL_JOB_REASON = { upload: 'upload', rerun: 'rerun', backfill: 'backfill' } as const;

/**
 * A job enqueue reason.
 *
 * @stability experimental
 */
export type SocialJobReason = (typeof SOCIAL_JOB_REASON)[keyof typeof SOCIAL_JOB_REASON];

/**
 * The permission strings the slice's controllers declare (equal to the host catalog's).
 *
 * @stability experimental
 */
export const SOCIAL_MEDIA_PERMISSIONS = {
  MEDIA_READ: 'media:read',
  MEDIA_WRITE: 'media:write',
  SYSTEM_SETTINGS_READ: 'system_settings:read',
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',
} as const;

/**
 * The role names the slice's controllers declare.
 *
 * @stability experimental
 */
export const SOCIAL_MEDIA_ROLES = { ADMIN: 'admin' } as const;
