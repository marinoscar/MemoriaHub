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
//   - `ai`        ai_config:read, ai_config:write (system, admin), ai:use (org: org_admin and
//                 contributor, the platform's grants), org_ai_config:read|write (org, org_admin)
//                 (RETRO-E1, #595). MemoriaHub's own ai_settings:* stay until RETRO-E4 retires the
//                 old /api/ai/* admin routes; an administrator holds both pairs.
//   - `telemetry` telemetry:read, telemetry:write, telemetry:query (system, admin) (RETRO-T2, #625)
// Not listed on purpose: `storage` and `notifications` collide with
// MemoriaHub's own (legacy) declarations of the same ids until RETRO-D1 and
// D3 adopt those slices; `nodes`, `sharing`, `user-data`,
// `webhooks` and `alerts` are not mounted.

import type { PlatformPermissionOptions } from '@marinoscar/platform-api/manifest';

import { MEMORIAHUB_PERMISSIONS } from './memoriahub-permissions';

export const PLATFORM_PERMISSION_OPTIONS: PlatformPermissionOptions = {
  slices: ['identity', 'settings', 'jobs', 'db-backup', 'ai', 'telemetry'],
  app: {
    roles: [],
    permissions: [MEMORIAHUB_PERMISSIONS],
    grants: [],
  },
};
