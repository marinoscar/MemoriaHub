// =============================================================================
// MemoriaHub's own permissions (RETRO-B2, issue #611)
// =============================================================================
//
// The domain and admin permissions the product adds on top of the platform's
// (`users:*`, `allowlist:*`, `rbac:manage`, `system_settings:*`,
// `user_settings:*`, `jobs:*`, which `registerPlatformPermissions` supplies).
// Pure data: no side effects, so `common/constants/roles.constants.ts` and the
// seed catalog generator can read it. The registration is
// `permission-manifest.ts`.
//
// SCOPES. Since platform migration 0024 a role is `system` (`admin`, held in
// `user_roles`) or `org` (`org_admin`, `contributor`, `viewer`, held on the
// membership). A permission is granted only to roles of its own scope:
//   - `org` permissions are the domain ones every member uses. The old matrix
//     gave them to admin, contributor and viewer; the system `admin` now holds
//     them through the `org_admin` role on their default-organization
//     membership (0024 gave every administrator one), so a user's effective
//     permission set is unchanged. `scripts/verify-identity-transform.mjs`
//     proves that per user.
//   - `system` permissions operate the deployment and stay with `admin`.
//
// THE MATRIX (identical to the pre-adoption `rbac.catalog.ts`):
//   admin       everything
//   contributor user_settings:*, storage:read|write, media:read|write|delete,
//               circles:read|write, search:use, shares:manage
//   viewer      user_settings:*, storage:read|write, media:read|write|delete,
//               circles:read|write, search:use
// `user_settings:*` is the platform's. Its default grants (org_admin,
// contributor, viewer) are the same.
//
// REMOVED BY SLICE: email_settings:* (D2, done: the platform email routes check
// system_settings:read|write), the AI settings pair (E4, done: replaced by the AI slice's
// ai_config:read|write, admin only, which also gates the tag vocabulary), storage_settings:* (D1, done:
// replaced by the storage slice's storage_config:read|write, admin only),
// storage:* (D1: the storage slice's set, registered through `permissions.ts`),
// db_backup:* (D4), push:* and broadcasts:* (D3, done: the notifications slice
// declares them, plus the org-scoped org_broadcasts:* granted to org_admin). Their
// ids are permanent: the web cards and the CLI use the strings exactly.
//
// STORAGE (RETRO-D1): `storage:read|write`, `storage:delete_any` and
// `storage_config:read|write` are the storage slice's (`permissions.ts` lists
// `storage` in `slices`), with ONE grant widened through
// `platformGrants` (platform 0.1.0-next.28): `storage:write` for `viewer` too.
// Before RETRO-D1 the objects API was a bare `@Auth()`, so every member (the
// default role is `viewer`) uploaded, and the per-circle role decided where the
// media item may go; the platform grants it to org_admin and contributor only.
// =============================================================================

import type { PermissionDeclaration } from '@marinoscar/platform-api/core';

const ALL_ORG_ROLES = ['org_admin', 'contributor', 'viewer'] as const;
const ORG_WRITERS = ['org_admin', 'contributor'] as const;

export const MEMORIAHUB_PERMISSIONS = {
  // Media
  MEDIA_READ: {
    id: 'media:read',
    description: 'Read own media items',
    scope: 'org',
    defaultGrants: [...ALL_ORG_ROLES],
  },
  MEDIA_WRITE: {
    id: 'media:write',
    description: 'Create and update own media items',
    scope: 'org',
    defaultGrants: [...ALL_ORG_ROLES],
  },
  MEDIA_DELETE: {
    id: 'media:delete',
    description: 'Soft-delete own media items',
    scope: 'org',
    defaultGrants: [...ALL_ORG_ROLES],
  },
  MEDIA_READ_ANY: {
    id: 'media:read_any',
    description: 'Admin: read any user media items',
    scope: 'system',
    defaultGrants: ['admin'],
  },
  MEDIA_WRITE_ANY: {
    id: 'media:write_any',
    description: 'Admin: update any user media items',
    scope: 'system',
    defaultGrants: ['admin'],
  },
  MEDIA_DELETE_ANY: {
    id: 'media:delete_any',
    description: 'Admin: delete any user media items',
    scope: 'system',
    defaultGrants: ['admin'],
  },

  // Circles (the per-circle role still gates which circle; these grant API access)
  CIRCLES_READ: {
    id: 'circles:read',
    description: 'Read circles and memberships',
    scope: 'org',
    defaultGrants: [...ALL_ORG_ROLES],
  },
  CIRCLES_WRITE: {
    id: 'circles:write',
    description: 'Create and manage own circles',
    scope: 'org',
    defaultGrants: [...ALL_ORG_ROLES],
  },
  CIRCLES_MANAGE_ANY: {
    id: 'circles:manage_any',
    description: 'Admin: manage any circle',
    scope: 'system',
    defaultGrants: ['admin'],
  },

  // Search
  SEARCH_USE: {
    id: 'search:use',
    description: 'Use the AI-powered search feature',
    scope: 'org',
    defaultGrants: [...ALL_ORG_ROLES],
  },

  // Sharing
  SHARES_MANAGE: {
    id: 'shares:manage',
    description: 'Create, list, update, and revoke own shares',
    scope: 'org',
    defaultGrants: [...ORG_WRITERS],
  },
  SHARES_MANAGE_ANY: {
    id: 'shares:manage_any',
    description: "Admin: manage any user's shares",
    scope: 'system',
    defaultGrants: ['admin'],
  },

  // Provider and operations settings (Admin only)
  FACE_SETTINGS_READ: {
    id: 'face_settings:read',
    description: 'Read face recognition provider settings and status',
    scope: 'system',
    defaultGrants: ['admin'],
  },
  FACE_SETTINGS_WRITE: {
    id: 'face_settings:write',
    description: 'Configure face recognition provider credentials and settings',
    scope: 'system',
    defaultGrants: ['admin'],
  },
  GEO_SETTINGS_READ: {
    id: 'geo_settings:read',
    description: 'Read geo provider settings and status',
    scope: 'system',
    defaultGrants: ['admin'],
  },
  GEO_SETTINGS_WRITE: {
    id: 'geo_settings:write',
    description: 'Configure geo provider credentials and active reverse-geocoding provider',
    scope: 'system',
    defaultGrants: ['admin'],
  },
} as const satisfies Record<string, PermissionDeclaration>;
