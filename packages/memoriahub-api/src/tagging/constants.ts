// =============================================================================
// Constants of the tagging slice (RETRO-J7, #618)
// =============================================================================
//
// The slice imports no generated client, so the enum values it reads and writes are named here. Each
// value is the database enum's literal (`media_type`, `media_tag_status_type`, `media_tag_source`,
// `job_reason`); a change to the schema's enum is a change to this file.
// =============================================================================

/**
 * The `media_type` values the slice reads.
 *
 * @stability experimental
 */
export const MEDIA_TYPE = { photo: 'photo', video: 'video' } as const;

/**
 * The `media_tag_status_type` values.
 *
 * @stability experimental
 */
export const TAG_STATUS = {
  not_processed: 'not_processed',
  pending: 'pending',
  processing: 'processing',
  processed: 'processed',
  failed: 'failed',
} as const;

/**
 * The `media_tag_source` values the slice writes or protects.
 *
 * @stability experimental
 */
export const TAG_SOURCE = { manual: 'manual', ai: 'ai', system: 'system' } as const;

/**
 * The job reasons the slice enqueues with.
 *
 * @stability experimental
 */
export const JOB_REASON = { upload: 'upload', rerun: 'rerun', backfill: 'backfill' } as const;

/**
 * The permanent job type strings of the slice. A job type string is permanent once jobs of that type
 * exist (`apps/api/test/jobs/job-type-snapshot.spec.ts` pins every registered type).
 *
 * @stability experimental
 */
export const TAGGING_JOB_TYPES = {
  autoTagging: 'auto_tagging',
  videoAutoTagging: 'video_auto_tagging',
} as const;

/**
 * The throttle bucket both tagging job types share: it is one provider quota.
 *
 * @stability experimental
 */
export const TAGGING_THROTTLE_KEY = 'tagging';

/**
 * The ids of the AI features the slice calls under. A feature id is permanent once usage rows carry
 * it (`ai_usage_events.feature`); the host registers each (`app-registrations/ai.ts`) before the
 * application starts.
 *
 * @stability experimental
 */
export const TAGGING_AI_FEATURES = {
  /** Photo auto-tagging: one image in, tags and a description out. */
  mediaTagging: 'media_tagging',
  /** Video auto-tagging: several frames (and a transcript) in. */
  videoTagging: 'video_tagging',
  /** Speech-to-text of a video's opening seconds. */
  videoTranscription: 'video_transcription',
  /** Text embeddings: the `media_item_embedding` writes and the `semanticQuery` search. */
  semanticEmbedding: 'semantic_embedding',
} as const;

/**
 * The vector size `media_item_embedding.embedding` (`vector(1536)`) holds. A model that answers
 * another size cannot be stored, so an embedding call refuses it.
 *
 * @stability experimental
 */
export const EMBEDDING_STORAGE_DIMENSIONS = 1536;

/**
 * The permission strings the tagging routes require. They equal the host catalog's: a permission is
 * data the identity port checks, and the host registers the catalog.
 *
 * @stability experimental
 */
export const TAGGING_PERMISSIONS = {
  /** Read media in a circle the caller belongs to. */
  MEDIA_READ: 'media:read',
  /** Write media. */
  MEDIA_WRITE: 'media:write',
  /** Read the AI configuration (the tag vocabulary). */
  AI_CONFIG_READ: 'ai_config:read',
  /** Write the AI configuration (the tag vocabulary). */
  AI_CONFIG_WRITE: 'ai_config:write',
  /** Write system settings (the tagging backfill). */
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',
} as const;

/**
 * The role names the tagging routes require.
 *
 * @stability experimental
 */
export const TAGGING_ROLES = {
  /** The system administrator role. */
  ADMIN: 'admin',
} as const;
