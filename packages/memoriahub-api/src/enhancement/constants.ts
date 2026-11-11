// =============================================================================
// Constants of the enhancement slice (RETRO-J10, #624)
// =============================================================================
//
// The slice imports no generated client, so the enum values it reads and writes are named here. Each
// value is the database enum's literal (`media_enhancement_status`, `media_enhancement_decision`,
// `media_type`, `media_tag_source`, `job_reason`); a change to the schema's enum is a change to this
// file. The ORDER of `ENHANCEMENT_STATUS` is the schema enum's order: the OpenAPI document lists it.
// =============================================================================

/**
 * The job types of the slice. A job `type` string is permanent once jobs of that type exist.
 *
 * @stability experimental
 */
export const ENHANCEMENT_JOB_TYPES = {
  pictureEnhancement: 'picture_enhancement',
  purge: 'picture_enhancement_purge',
} as const;

/**
 * The throttle bucket of the image-edit quota (apart from tagging).
 *
 * @stability experimental
 */
export const ENHANCEMENT_THROTTLE_KEY = 'enhance';

/**
 * The AI feature id the host registers with the model runtime for the image edit.
 *
 * @stability experimental
 */
export const ENHANCEMENT_AI_FEATURE = 'picture_enhance';

/**
 * The `media_enhancement_status` literals, in the schema enum's order.
 *
 * @stability experimental
 */
export const ENHANCEMENT_STATUS = {
  pending: 'pending',
  processing: 'processing',
  ready: 'ready',
  failed: 'failed',
  applied: 'applied',
  discarded: 'discarded',
  expired: 'expired',
  cancelled: 'cancelled',
} as const;

/**
 * A `media_enhancement_status` literal.
 *
 * @stability experimental
 */
export type EnhancementStatus = (typeof ENHANCEMENT_STATUS)[keyof typeof ENHANCEMENT_STATUS];

/**
 * The `media_enhancement_decision` literals.
 *
 * @stability experimental
 */
export const ENHANCEMENT_DECISION = { keep_both: 'keep_both', replace: 'replace' } as const;

/**
 * The `media_type` literals the slice reads.
 *
 * @stability experimental
 */
export const ENHANCEMENT_MEDIA_TYPE = { photo: 'photo', video: 'video' } as const;

/**
 * The `media_tag_source` literals the slice writes.
 *
 * @stability experimental
 */
export const ENHANCEMENT_TAG_SOURCE = { manual: 'manual', ai: 'ai', system: 'system' } as const;

/**
 * The `job_reason` literals.
 *
 * @stability experimental
 */
export const ENHANCEMENT_JOB_REASON = { upload: 'upload', rerun: 'rerun', backfill: 'backfill' } as const;

/**
 * The Cache-Control of every staged thumbnail upload: the bytes behind a key never change.
 *
 * @stability experimental
 */
export const ENHANCEMENT_THUMBNAIL_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The permission strings the slice's controllers declare (equal to the host catalog's).
 *
 * @stability experimental
 */
export const ENHANCEMENT_PERMISSIONS = {
  MEDIA_READ: 'media:read',
  MEDIA_WRITE: 'media:write',
  SYSTEM_SETTINGS_READ: 'system_settings:read',
} as const;

/**
 * The role names the slice's controllers declare.
 *
 * @stability experimental
 */
export const ENHANCEMENT_ROLES = { ADMIN: 'admin' } as const;
