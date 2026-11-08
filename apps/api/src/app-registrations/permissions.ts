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
//   - `alerts`    alerts:read, alerts:write (system, admin) (RETRO-H5, #609)
//   - `user-data` system:factory_reset, orgs:offboard (system, admin only; never implied by
//                 system_settings:write) (RETRO-H1, #591)
//   - `sharing`   groups:read, sharing:read (org: viewer, contributor, org_admin), groups:write,
//                 sharing:write (org: contributor, org_admin), groups:admin, sharing:admin (org:
//                 org_admin; a system `admin` holds them through the `org_admin` role the identity
//                 slice gives it on the default organization) (RETRO-I1, #562)
// Not listed on purpose: `storage` and `notifications` collide with
// MemoriaHub's own (legacy) declarations of the same ids until RETRO-D1 and
// D3 adopt those slices; `nodes` and `webhooks` are not mounted.

import type { PlatformPermissionOptions } from '@marinoscar/platform-api/manifest';

import { MEMORIAHUB_PERMISSIONS } from './memoriahub-permissions';

export const PLATFORM_PERMISSION_OPTIONS: PlatformPermissionOptions = {
  slices: ['identity', 'settings', 'jobs', 'db-backup', 'ai', 'telemetry', 'notifications', 'alerts', 'user-data', 'sharing'],
  app: {
    roles: [],
    permissions: [MEMORIAHUB_PERMISSIONS],
    grants: [],
  },
};
