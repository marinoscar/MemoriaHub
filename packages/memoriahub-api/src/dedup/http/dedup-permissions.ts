// =============================================================================
// Permission strings and roles the dedup controllers declare
// =============================================================================
//
// The strings equal the host catalog's (`media:read`, `system_settings:write`, ...): a permission is data the
// identity port checks, and a host registers the catalog. They are constants here so a controller never types
// a literal and the permission matrix of a host can be compared against them.
// =============================================================================

/**
 * The permissions the dedup controllers require.
 *
 * @stability experimental
 */
export const DEDUP_PERMISSIONS = {
  MEDIA_READ: 'media:read',
  MEDIA_WRITE: 'media:write',
  SYSTEM_SETTINGS_READ: 'system_settings:read',
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',
} as const;

/**
 * The roles the dedup controllers require.
 *
 * @stability experimental
 */
export const DEDUP_ROLES = {
  ADMIN: 'admin',
} as const;
