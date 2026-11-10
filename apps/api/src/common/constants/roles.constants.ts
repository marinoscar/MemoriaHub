// =============================================================================
// Role Constants
// =============================================================================

// Since platform migration 0024 `admin` is the SYSTEM role (held in `user_roles`);
// `org_admin`, `contributor` and `viewer` are ORG roles held on a membership.
export const ROLES = {
  ADMIN: 'admin',
  ORG_ADMIN: 'org_admin',
  CONTRIBUTOR: 'contributor',
  VIEWER: 'viewer',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

// =============================================================================
// Permission Constants
// =============================================================================

export const PERMISSIONS = {
  // System settings
  SYSTEM_SETTINGS_READ: 'system_settings:read',
  SYSTEM_SETTINGS_WRITE: 'system_settings:write',

  // User settings
  USER_SETTINGS_READ: 'user_settings:read',
  USER_SETTINGS_WRITE: 'user_settings:write',

  // Users
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',

  // RBAC
  RBAC_MANAGE: 'rbac:manage',

  // Allowlist
  ALLOWLIST_READ: 'allowlist:read',
  ALLOWLIST_WRITE: 'allowlist:write',

  // Storage (the platform storage slice's since RETRO-D1)
  STORAGE_READ: 'storage:read',
  STORAGE_WRITE: 'storage:write',
  STORAGE_DELETE_ANY: 'storage:delete_any',

  // Media
  MEDIA_READ: 'media:read',
  MEDIA_WRITE: 'media:write',
  MEDIA_DELETE: 'media:delete',
  MEDIA_READ_ANY: 'media:read_any',
  MEDIA_WRITE_ANY: 'media:write_any',
  MEDIA_DELETE_ANY: 'media:delete_any',

  // Circles (per-circle role still gates which circle; these grant API access)
  CIRCLES_READ: 'circles:read',
  CIRCLES_WRITE: 'circles:write',
  CIRCLES_MANAGE_ANY: 'circles:manage_any', // Admin: manage any circle


  // AI administration: the platform AI slice's pair (`@marinoscar/platform-api/ai`), which
  // replaced MemoriaHub's own AI settings pair in RETRO-E4 (#607). Also gates the MemoriaHub feature
  // selections (`/api/admin/memoriahub-ai/*`) and the tag vocabulary (`/api/tag-labels`).
  AI_CONFIG_READ: 'ai_config:read',
  AI_CONFIG_WRITE: 'ai_config:write',

  // Face Recognition Settings (Admin only)
  FACE_SETTINGS_READ: 'face_settings:read',
  FACE_SETTINGS_WRITE: 'face_settings:write',

  // Storage configuration (Admin only; the platform storage slice's since RETRO-D1, which
  // replaced MemoriaHub's `storage_settings:*`)
  STORAGE_CONFIG_READ: 'storage_config:read',
  STORAGE_CONFIG_WRITE: 'storage_config:write',

  // Search feature usage
  SEARCH_USE: 'search:use',

  // Job queue dashboard (Admin only)
  JOBS_READ: 'jobs:read',
  JOBS_WRITE: 'jobs:write',

  // Worker-node fleet (Admin only; the platform nodes slice's, RETRO-C2). The Local Media Backup
  // routes and the model manifest enforce them too.
  NODES_READ: 'nodes:read',
  NODES_WRITE: 'nodes:write',

  // Geo Provider Settings (Admin only)
  GEO_SETTINGS_READ: 'geo_settings:read',
  GEO_SETTINGS_WRITE: 'geo_settings:write',

  // Web Push (VAPID) configuration (Admin only, epic #481). Separate from
  // system_settings:* because generating/rotating key material has a real
  // blast radius: every existing push subscriber goes dark on rotation.
  PUSH_READ: 'push:read',
  PUSH_WRITE: 'push:write',

  // Admin notification broadcasts (Admin only, epic #481, issue #488).
  // Separate from push:* — composing an announcement that reaches every user
  // is a different capability from managing the VAPID keys it may travel on.
  BROADCASTS_READ: 'broadcasts:read',
  BROADCASTS_WRITE: 'broadcasts:write',

  // Sharing (the sharing slice's; RETRO-I4 replaced shares:manage / shares:manage_any)
  SHARING_WRITE: 'sharing:write',
  SHARING_ADMIN: 'sharing:admin',

  // PostgreSQL Database Backup & Restore (Admin only, epic #339)
  DB_BACKUP_READ: 'db_backup:read',
  DB_BACKUP_WRITE: 'db_backup:write',
  DB_BACKUP_RESTORE: 'db_backup:restore',
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// =============================================================================
// Default Role
// =============================================================================

export const DEFAULT_ROLE = ROLES.VIEWER;

// =============================================================================
// Typed names in the identity slice's decorators (RETRO-B2)
// =============================================================================
//
// `@Auth({ permissions, roles })` lives in `@marinoscar/platform-api/identity`,
// which cannot know this app's ids. This augmentation widens the slice's
// permission and role names to exactly this app's, so a typo in a route's
// permission stays a compile error. `common/constants/roles.constants.spec.ts`
// proves every constant above is a registered permission.
declare module '@marinoscar/platform-api/identity' {
  interface IdentityPermissionIds extends Record<PermissionName, true> {}
  interface IdentityRoleIds extends Record<RoleName, true> {}
}
