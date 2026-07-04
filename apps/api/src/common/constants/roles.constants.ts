// =============================================================================
// Role Constants
// =============================================================================

export const ROLES = {
  ADMIN: 'admin',
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

  // Storage
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

  // Backup (admin-only: local-drive backup/replication)
  BACKUP_RUN: 'backup:run',
  BACKUP_READ: 'backup:read',

  // AI Settings
  AI_SETTINGS_READ: 'ai_settings:read',
  AI_SETTINGS_WRITE: 'ai_settings:write',

  // Face Recognition Settings (Admin only)
  FACE_SETTINGS_READ: 'face_settings:read',
  FACE_SETTINGS_WRITE: 'face_settings:write',

  // Storage Provider Settings (Admin only)
  STORAGE_SETTINGS_READ: 'storage_settings:read',
  STORAGE_SETTINGS_WRITE: 'storage_settings:write',

  // Search feature usage
  SEARCH_USE: 'search:use',

  // Job queue dashboard (Admin only)
  JOBS_READ: 'jobs:read',
  JOBS_WRITE: 'jobs:write',

  // Geo Provider Settings (Admin only)
  GEO_SETTINGS_READ: 'geo_settings:read',
  GEO_SETTINGS_WRITE: 'geo_settings:write',

  // Sharing (Admin + Contributor; manage_any = Admin only)
  SHARES_MANAGE: 'shares:manage',
  SHARES_MANAGE_ANY: 'shares:manage_any',

  // OneDrive Data Import (personal action — granted to all system roles)
  ONEDRIVE_CONNECT: 'onedrive:connect',
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// =============================================================================
// Default Role
// =============================================================================

export const DEFAULT_ROLE = ROLES.VIEWER;
