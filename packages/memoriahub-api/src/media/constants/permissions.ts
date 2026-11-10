// =============================================================================
// Permission strings and roles the media slice's controllers declare
// =============================================================================
//
// The strings equal the host catalog's (`media:read`, ...): a permission is data the identity port
// checks, and a host registers the catalog. They are constants here so a controller never types a
// literal and the permission matrix of a host can be compared against them.
// =============================================================================

/**
 * The permission strings the media slice's routes require.
 *
 * @stability experimental
 */
export const MEDIA_PERMISSIONS = {
  /** Read media in a circle the caller belongs to. */
  MEDIA_READ: 'media:read',
  /** Write media. */
  MEDIA_WRITE: 'media:write',
  /** Delete media permanently. */
  MEDIA_DELETE: 'media:delete',
  /** Administrative recovery of any storage object. */
  STORAGE_DELETE_ANY: 'storage:delete_any',
  /** Read the job queue. */
  JOBS_READ: 'jobs:read',
  /** Write the job queue. */
  JOBS_WRITE: 'jobs:write',
  /** Write system settings. */
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',
} as const;

/**
 * The role names the media slice's routes require.
 *
 * @stability experimental
 */
export const MEDIA_ROLES = {
  /** The system administrator role. */
  ADMIN: 'admin',
} as const;
