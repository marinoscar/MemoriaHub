// =============================================================================
// Permission strings and roles the face slice's controllers declare
// =============================================================================
//
// The strings equal the host catalog's (`media:read`, `face_settings:write`, ...): a permission is data
// the identity port checks, and a host registers the catalog. They are constants here so a controller
// never types a literal and the permission matrix of a host can be compared against them.
// =============================================================================

/**
 * The permissions the face controllers require.
 *
 * @stability experimental
 */
export const FACE_PERMISSIONS = {
  MEDIA_READ: 'media:read',
  MEDIA_WRITE: 'media:write',
  MEDIA_DELETE: 'media:delete',
  FACE_SETTINGS_READ: 'face_settings:read',
  FACE_SETTINGS_WRITE: 'face_settings:write',
} as const;

/**
 * The roles the face controllers require.
 *
 * @stability experimental
 */
export const FACE_ROLES = {
  ADMIN: 'admin',
} as const;
