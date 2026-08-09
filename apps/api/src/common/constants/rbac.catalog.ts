// =============================================================================
// RBAC Catalog — the canonical permission set and role→permission matrix
// =============================================================================
//
// WHY THIS FILE EXISTS (issue #293)
//
// `roles.constants.ts` declares the permission *names* the API guards on
// (`@Auth({ permissions: [...] })`), but a name means nothing until a matching
// row exists in the `permissions` table and is granted to a role. Before this
// file, the only place that mapping lived was `prisma/seed.ts` — and the seed
// runs at INSTALL time only (`install-memoriahub.sh`), never on update
// (`update.sh` runs `prisma migrate deploy` without the seed).
//
// So every permission added after a deployment was installed silently never
// reached that database, and the first symptom was a runtime
// "Missing permissions: <name>" error on the page that needed it. That is
// exactly how `email_settings:read` broke /admin/settings/email in production.
//
// This catalog is the single source of truth that `RbacReconcileService`
// applies to the database on every API boot, so a new permission deploys
// itself. Adding a permission is now: add it to `roles.constants.ts`, add it
// here with a description and its roles — no migration, no seed re-run.
//
// KEEPING THE SEED IN STEP
//
// `prisma/seed.ts` deliberately keeps its own copy of this data rather than
// importing this file. It cannot import it: the production image
// (`apps/api/Dockerfile`) ships `dist/`, `prisma/` and `scripts/` but NOT
// `src/`, so a seed that reached into `src/` would break install-time seeding.
// `rbac.catalog.spec.ts` parses `seed.ts` and fails if the two ever diverge,
// which is what makes the duplication safe.

import { PERMISSIONS, ROLES, type PermissionName, type RoleName } from './roles.constants';

export interface PermissionDefinition {
  name: PermissionName;
  description: string;
}

/**
 * Every permission the system knows about, with the description stored on the
 * row. Order is cosmetic; grouping mirrors `roles.constants.ts`.
 */
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  // System settings
  { name: PERMISSIONS.SYSTEM_SETTINGS_READ, description: 'Read system settings' },
  { name: PERMISSIONS.SYSTEM_SETTINGS_WRITE, description: 'Modify system settings' },

  // User settings
  { name: PERMISSIONS.USER_SETTINGS_READ, description: 'Read own user settings' },
  { name: PERMISSIONS.USER_SETTINGS_WRITE, description: 'Modify own user settings' },

  // Users management
  { name: PERMISSIONS.USERS_READ, description: 'View user list and details' },
  { name: PERMISSIONS.USERS_WRITE, description: 'Modify user accounts' },

  // RBAC management
  { name: PERMISSIONS.RBAC_MANAGE, description: 'Manage roles and permissions' },

  // Allowlist management
  { name: PERMISSIONS.ALLOWLIST_READ, description: 'View allowlisted emails' },
  { name: PERMISSIONS.ALLOWLIST_WRITE, description: 'Manage allowlisted emails' },

  // Storage management
  { name: PERMISSIONS.STORAGE_READ, description: 'Read object metadata, get download URLs' },
  { name: PERMISSIONS.STORAGE_WRITE, description: 'Upload, update metadata' },
  { name: PERMISSIONS.STORAGE_DELETE_ANY, description: 'Admin: delete any object' },

  // Media management
  { name: PERMISSIONS.MEDIA_READ, description: 'Read own media items' },
  { name: PERMISSIONS.MEDIA_WRITE, description: 'Create and update own media items' },
  { name: PERMISSIONS.MEDIA_DELETE, description: 'Soft-delete own media items' },
  { name: PERMISSIONS.MEDIA_READ_ANY, description: 'Admin: read any user media items' },
  { name: PERMISSIONS.MEDIA_WRITE_ANY, description: 'Admin: update any user media items' },
  { name: PERMISSIONS.MEDIA_DELETE_ANY, description: 'Admin: delete any user media items' },

  // Circles (per-circle role still gates which circle; these grant API access)
  { name: PERMISSIONS.CIRCLES_READ, description: 'Read circles and memberships' },
  { name: PERMISSIONS.CIRCLES_WRITE, description: 'Create and manage own circles' },
  { name: PERMISSIONS.CIRCLES_MANAGE_ANY, description: 'Admin: manage any circle' },

  // Backup (admin-only: local-drive backup/replication)
  { name: PERMISSIONS.BACKUP_RUN, description: 'Admin: trigger local-drive backup job' },
  { name: PERMISSIONS.BACKUP_READ, description: 'Admin: read backup status and manifests' },

  // AI Settings
  { name: PERMISSIONS.AI_SETTINGS_READ, description: 'Read AI provider settings and status' },
  {
    name: PERMISSIONS.AI_SETTINGS_WRITE,
    description: 'Configure AI provider credentials and settings',
  },

  // Face Recognition Settings (Admin only)
  {
    name: PERMISSIONS.FACE_SETTINGS_READ,
    description: 'Read face recognition provider settings and status',
  },
  {
    name: PERMISSIONS.FACE_SETTINGS_WRITE,
    description: 'Configure face recognition provider credentials and settings',
  },

  // Storage Provider Settings (Admin only)
  {
    name: PERMISSIONS.STORAGE_SETTINGS_READ,
    description: 'View storage provider configuration and test connectivity',
  },
  {
    name: PERMISSIONS.STORAGE_SETTINGS_WRITE,
    description: 'Configure storage provider credentials, set active provider, run migrations',
  },

  // Search feature usage
  { name: PERMISSIONS.SEARCH_USE, description: 'Use the AI-powered search feature' },

  // Job queue dashboard (Admin only)
  { name: PERMISSIONS.JOBS_READ, description: 'Admin: read enrichment job queue stats and list' },
  { name: PERMISSIONS.JOBS_WRITE, description: 'Admin: retry, reset, or delete enrichment jobs' },

  // Geo Provider Settings (Admin only)
  { name: PERMISSIONS.GEO_SETTINGS_READ, description: 'Read geo provider settings and status' },
  {
    name: PERMISSIONS.GEO_SETTINGS_WRITE,
    description: 'Configure geo provider credentials and active reverse-geocoding provider',
  },

  // Sharing (Admin + Contributor; manage_any = Admin only)
  { name: PERMISSIONS.SHARES_MANAGE, description: 'Create, list, update, and revoke own shares' },
  { name: PERMISSIONS.SHARES_MANAGE_ANY, description: "Admin: manage any user's shares" },

  // Email Provider Settings (Admin only)
  {
    name: PERMISSIONS.EMAIL_SETTINGS_READ,
    description: 'View email provider configuration and test connectivity',
  },
  {
    name: PERMISSIONS.EMAIL_SETTINGS_WRITE,
    description:
      'Configure email provider credentials, set active provider, and send test emails',
  },

  // PostgreSQL Database Backup & Restore (Admin only, epic #339)
  { name: PERMISSIONS.DB_BACKUP_READ, description: 'Admin: read database backup run history and status' },
  { name: PERMISSIONS.DB_BACKUP_WRITE, description: 'Admin: configure and trigger database backups' },
  { name: PERMISSIONS.DB_BACKUP_RESTORE, description: 'Admin: restore the database from a backup' },
];

/**
 * Which permissions each role is granted by default.
 *
 * Nothing in the API mutates `role_permissions` at runtime (`rbac:manage` only
 * guards user→role assignment in `users.controller.ts`), so this matrix is the
 * complete intended state — there are no operator customisations to preserve.
 * The reconciler is still additive-only; see the service for why.
 */
export const ROLE_PERMISSION_MATRIX: Record<RoleName, readonly PermissionName[]> = {
  [ROLES.ADMIN]: [
    PERMISSIONS.SYSTEM_SETTINGS_READ,
    PERMISSIONS.SYSTEM_SETTINGS_WRITE,
    PERMISSIONS.USER_SETTINGS_READ,
    PERMISSIONS.USER_SETTINGS_WRITE,
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_WRITE,
    PERMISSIONS.RBAC_MANAGE,
    PERMISSIONS.ALLOWLIST_READ,
    PERMISSIONS.ALLOWLIST_WRITE,
    PERMISSIONS.STORAGE_READ,
    PERMISSIONS.STORAGE_WRITE,
    PERMISSIONS.STORAGE_DELETE_ANY,
    PERMISSIONS.MEDIA_READ,
    PERMISSIONS.MEDIA_WRITE,
    PERMISSIONS.MEDIA_DELETE,
    PERMISSIONS.MEDIA_READ_ANY,
    PERMISSIONS.MEDIA_WRITE_ANY,
    PERMISSIONS.MEDIA_DELETE_ANY,
    // Circles: full access including super-admin operations
    PERMISSIONS.CIRCLES_READ,
    PERMISSIONS.CIRCLES_WRITE,
    PERMISSIONS.CIRCLES_MANAGE_ANY,
    // Backup: admin-only
    PERMISSIONS.BACKUP_RUN,
    PERMISSIONS.BACKUP_READ,
    // AI: admin-only credential management
    PERMISSIONS.AI_SETTINGS_READ,
    PERMISSIONS.AI_SETTINGS_WRITE,
    // Face Recognition: admin-only credential management
    PERMISSIONS.FACE_SETTINGS_READ,
    PERMISSIONS.FACE_SETTINGS_WRITE,
    // Storage Provider Settings: admin-only configuration
    PERMISSIONS.STORAGE_SETTINGS_READ,
    PERMISSIONS.STORAGE_SETTINGS_WRITE,
    // Search: all authenticated users
    PERMISSIONS.SEARCH_USE,
    // Job queue dashboard: admin-only
    PERMISSIONS.JOBS_READ,
    PERMISSIONS.JOBS_WRITE,
    // Geo Provider Settings: admin-only
    PERMISSIONS.GEO_SETTINGS_READ,
    PERMISSIONS.GEO_SETTINGS_WRITE,
    // Sharing: admin can manage any share
    PERMISSIONS.SHARES_MANAGE,
    PERMISSIONS.SHARES_MANAGE_ANY,
    // Email Provider Settings: admin-only
    PERMISSIONS.EMAIL_SETTINGS_READ,
    PERMISSIONS.EMAIL_SETTINGS_WRITE,
    // PostgreSQL Database Backup & Restore: admin-only
    PERMISSIONS.DB_BACKUP_READ,
    PERMISSIONS.DB_BACKUP_WRITE,
    PERMISSIONS.DB_BACKUP_RESTORE,
  ],
  [ROLES.CONTRIBUTOR]: [
    PERMISSIONS.USER_SETTINGS_READ,
    PERMISSIONS.USER_SETTINGS_WRITE,
    PERMISSIONS.STORAGE_READ,
    PERMISSIONS.STORAGE_WRITE,
    PERMISSIONS.MEDIA_READ,
    PERMISSIONS.MEDIA_WRITE,
    PERMISSIONS.MEDIA_DELETE,
    // Circles: any user can use circles; per-circle role gates which circle
    PERMISSIONS.CIRCLES_READ,
    PERMISSIONS.CIRCLES_WRITE,
    // Search: contributors can use AI search
    PERMISSIONS.SEARCH_USE,
    // Sharing: contributors can manage their own shares
    PERMISSIONS.SHARES_MANAGE,
  ],
  [ROLES.VIEWER]: [
    PERMISSIONS.USER_SETTINGS_READ,
    PERMISSIONS.USER_SETTINGS_WRITE,
    PERMISSIONS.STORAGE_READ,
    PERMISSIONS.MEDIA_READ,
    PERMISSIONS.MEDIA_WRITE,
    PERMISSIONS.MEDIA_DELETE,
    // Circles: any user can use circles; per-circle role gates which circle
    PERMISSIONS.CIRCLES_READ,
    PERMISSIONS.CIRCLES_WRITE,
    // Search: viewers can use AI search
    PERMISSIONS.SEARCH_USE,
  ],
};
