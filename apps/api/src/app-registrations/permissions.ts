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
// Not listed on purpose: `storage`, `db-backup` and `notifications` collide with
// MemoriaHub's own (legacy) declarations of the same ids until RETRO-D1, D4 and
// D3 adopt those slices; `nodes`, `ai`, `telemetry`, `sharing`, `user-data`,
// `webhooks` and `alerts` are not mounted.

import type { PlatformPermissionOptions } from '@marinoscar/platform-api/manifest';

import { MEMORIAHUB_PERMISSIONS } from './memoriahub-permissions';

export const PLATFORM_PERMISSION_OPTIONS: PlatformPermissionOptions = {
  slices: ['identity', 'settings', 'jobs'],
  app: {
    roles: [],
    permissions: [MEMORIAHUB_PERMISSIONS],
    grants: [],
  },
};
