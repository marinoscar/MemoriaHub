// =============================================================================
// Permission strings and roles the location controllers declare
// =============================================================================
//
// The strings equal the host catalog's (`media:read`, `geo_settings:write`, ...): a permission is data the
// identity port checks, and a host registers the catalog. They are constants here so a controller never types
// a literal and the permission matrix of a host can be compared against them.
// =============================================================================

/**
 * The permissions the location controllers require.
 *
 * @stability experimental
 */
export const LOCATION_PERMISSIONS = {
  MEDIA_READ: 'media:read',
  MEDIA_WRITE: 'media:write',
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',
  GEO_SETTINGS_READ: 'geo_settings:read',
  GEO_SETTINGS_WRITE: 'geo_settings:write',
} as const;

/**
 * The roles the location controllers require.
 *
 * @stability experimental
 */
export const LOCATION_ROLES = {
  ADMIN: 'admin',
} as const;
