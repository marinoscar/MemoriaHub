// =============================================================================
// The platform permission slices MemoriaHub mounts, and its own permissions
// (RETRO-B2, issue #611). Data only; registered by `permission-manifest.ts`.
// =============================================================================
//
// `slices` selects the platform sets whose routes MemoriaHub enforces today:
//   - `identity`  users:*, rbac:manage, allowlist:*, org_members:*, org_invites:*,
//                 organizations:* (the organization routes are mounted but the
//                 web hides them in single-org mode)
//   - `settings`  system_settings:*, user_settings:*, org_settings:*
//   - `jobs`      jobs:read, jobs:write
//   - `db-backup` db_backup:read, db_backup:write, db_backup:restore (RETRO-D4, #580; same ids and
//                 grants as MemoriaHub's former declarations: system scope, admin only)
// Not listed on purpose: `storage` (RETRO-D1 mounts the slice, but MemoriaHub declares its ids itself
// to keep `storage:write` for `viewer`: memoriahub-permissions.ts) and `notifications`, which
// collides with MemoriaHub's own (legacy) declarations of the same ids until D3 adopts that slice; `nodes`, `ai`, `telemetry`, `sharing`, `user-data`,
// `webhooks` and `alerts` are not mounted.

import type { PlatformPermissionOptions } from '@marinoscar/platform-api/manifest';

import { MEMORIAHUB_PERMISSIONS } from './memoriahub-permissions';

export const PLATFORM_PERMISSION_OPTIONS: PlatformPermissionOptions = {
  slices: ['identity', 'settings', 'jobs', 'db-backup'],
  app: {
    roles: [],
    permissions: [MEMORIAHUB_PERMISSIONS],
    grants: [],
  },
};
