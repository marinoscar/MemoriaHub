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
//   - `nodes`     nodes:read, nodes:write (system, admin only; the worker-node fleet and its routes,
//                 RETRO-C2, #581: MemoriaHub's node routes were gated on jobs:read / jobs:write)
//   - `db-backup` db_backup:read, db_backup:write, db_backup:restore (RETRO-D4, #580; same ids and
//                 grants as MemoriaHub's former declarations: system scope, admin only)
//   - `ai`        ai_config:read, ai_config:write (system, admin), ai:use (org: org_admin and
//                 contributor, the platform's grants), org_ai_config:read|write (org, org_admin)
//                 (RETRO-E1, #595). Since RETRO-E4 (#607) ai_config:* is the only AI admin pair:
//                 MemoriaHub's old AI settings pair is retired with its /api/ai/* admin routes.
//   - `telemetry` telemetry:read, telemetry:write, telemetry:query (system, admin) (RETRO-T2, #625)
//   - `notifications` push:*, broadcasts:* (system, admin), org_broadcasts:* (org, org_admin) (RETRO-D3)
//   - `alerts`    alerts:read, alerts:write (system, admin) (RETRO-H5, #609)
//   - `user-data` system:factory_reset, orgs:offboard (system, admin only; never implied by
//                 system_settings:write) (RETRO-H1, #591)
//   - `storage`   storage:read (org: every member), storage:write (org: org_admin, contributor, and
//                 `viewer` through `platformGrants`, below), storage:delete_any (system, admin),
//                 storage_config:read|write (system, admin) (RETRO-D1, #563)
//   - `webhooks`  webhooks:read|write (org: org_admin, contributor, viewer; a member's own endpoints),
//                 org_webhooks:read|write (org, org_admin), system_webhooks:read|write (system, admin)
//                 (RETRO-H4, #603)
//   - `sharing`   groups:read, sharing:read (org: viewer, contributor, org_admin), groups:write,
//                 sharing:write (org: contributor, org_admin), groups:admin, sharing:admin (org:
//                 org_admin; a system `admin` holds them through the `org_admin` role the identity
//                 slice gives it on the default organization) (RETRO-I1, #562)

import type { PlatformPermissionOptions } from '@marinoscar/platform-api/manifest';

import { MEMORIAHUB_PERMISSIONS } from './memoriahub-permissions';

export const PLATFORM_PERMISSION_OPTIONS: PlatformPermissionOptions = {
  slices: ['identity', 'settings', 'jobs', 'nodes', 'db-backup', 'ai', 'telemetry', 'notifications', 'alerts', 'user-data', 'webhooks', 'sharing', 'storage'],
  app: {
    roles: [],
    permissions: [MEMORIAHUB_PERMISSIONS],
    grants: [],
    // RETRO-D1: every member uploads (the per-circle role decides where a media item may go), as
    // before the slice, when the objects API was a bare `@Auth()` and the default role is `viewer`.
    // RETRO-I3 (#573): `viewer` also gets `groups:write`, so a viewer can still create a shared
    // library as they could always create a circle (`circles:write`, granted to every role);
    // the platform grants it to contributor and org_admin only. Managing a group's members
    // stays bound to the caller's group `admin` role, as before.
    platformGrants: { 'storage:write': ['viewer'], 'groups:write': ['viewer'] },
  },
};
