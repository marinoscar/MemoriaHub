import { permissionRegistry, roleGrantRegistry } from '@marinoscar/platform-api/core';

import '../../src/app-registrations/permission-manifest';

// =============================================================================
// The permission matrix did not change (RETRO-B2, issue #611)
// =============================================================================
//
// OLD_MATRIX is the pre-adoption `ROLE_PERMISSION_MATRIX` of `rbac.catalog.ts`,
// frozen. Since platform migration 0024 a role is system (`admin`) or org
// (`org_admin`, `contributor`, `viewer`), and a user's effective permissions are
// the union of the system roles' grants and the current organization's
// membership role's grants (`resolveEffectiveAccess`). Every administrator holds
// `org_admin` on the default-organization membership, so the old `admin` row is
// compared with `admin` UNION `org_admin`. `contributor` and `viewer` are exact.
//
// The only permissions an administrator may GAIN are the ones the identity and
// settings slices introduce (organizations, members, invites, org settings),
// which did not exist before. The only ones it may LOSE are those of a slice
// whose platform routes check a platform permission instead (RETIRED_BY_SLICE).

const OLD_MATRIX: Record<'admin' | 'contributor' | 'viewer', string[]> = {
  admin: [
    'ai_settings:read',
    'ai_settings:write',
    'allowlist:read',
    'allowlist:write',
    'broadcasts:read',
    'broadcasts:write',
    'circles:manage_any',
    'circles:read',
    'circles:write',
    'db_backup:read',
    'db_backup:restore',
    'db_backup:write',
    'email_settings:read',
    'email_settings:write',
    'face_settings:read',
    'face_settings:write',
    'geo_settings:read',
    'geo_settings:write',
    'jobs:read',
    'jobs:write',
    'media:delete',
    'media:delete_any',
    'media:read',
    'media:read_any',
    'media:write',
    'media:write_any',
    'push:read',
    'push:write',
    'rbac:manage',
    'search:use',
    'shares:manage',
    'shares:manage_any',
    'storage:delete_any',
    'storage:read',
    'storage:write',
    'storage_settings:read',
    'storage_settings:write',
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
  ],
  contributor: [
    'circles:read',
    'circles:write',
    'media:delete',
    'media:read',
    'media:write',
    'search:use',
    'shares:manage',
    'storage:read',
    'storage:write',
    'user_settings:read',
    'user_settings:write',
  ],
  viewer: [
    'circles:read',
    'circles:write',
    'media:delete',
    'media:read',
    'media:write',
    'search:use',
    'storage:read',
    'user_settings:read',
    'user_settings:write',
  ],
};

const NEW_PLATFORM_PERMISSIONS = [
  // The AI slice (RETRO-E1, #595): ai_config:* for admin, ai:use and org_ai_config:* for org_admin.
  'ai:use',
  'ai_config:read',
  'ai_config:write',
  // The alerts slice (RETRO-H5, #609): system scope, admin only. (The list is sorted.)
  'alerts:read',
  'alerts:write',
  // The sharing slice (RETRO-I1, #562): org scope; groups:admin and sharing:admin via org_admin.
  'groups:admin',
  'groups:read',
  'groups:write',
  'org_ai_config:read',
  'org_ai_config:write',
  // RETRO-D3 (#576): the notifications slice's per-organization broadcasts.
  'org_broadcasts:read',
  'org_broadcasts:write',
  'org_invites:read',
  'org_invites:write',
  'org_members:read',
  'org_members:write',
  'org_settings:read',
  'org_settings:write',
  'organizations:read',
  'organizations:write',
  // The telemetry slice (RETRO-T2, #625): system scope, admin only.
  'telemetry:query',
  'telemetry:read',
  'telemetry:write',
  // The user-data slice (RETRO-H1, #591): system scope, admin only; never implied by system_settings:write.
  'orgs:offboard',
  'system:factory_reset',
  // The webhooks slice (RETRO-H4, #603): webhooks:* (every org role), org_webhooks:* (org_admin),
  // system_webhooks:* (admin).
  'org_webhooks:read',
  'org_webhooks:write',
  'system_webhooks:read',
  'system_webhooks:write',
  'webhooks:read',
  'webhooks:write',
  // sharing:admin and sharing:write replace shares:manage_any / shares:manage (RETRO_I4 below).
  'sharing:read',
];

/**
 * Permissions a slice adoption granted to a non-admin role. `ai:use` (RETRO-E1, #595): the
 * platform grants it to `contributor` (never to `viewer`, platform issue #499). Nothing in
 * MemoriaHub checks it yet: the app's AI features run server-side under the deployment key.
 */
const GAINED_BY_SLICE: Partial<Record<'contributor' | 'viewer', string[]>> = {
  // `webhooks:read|write` (RETRO-H4, #603): a member's own webhook endpoints (`/api/webhooks`);
  // the platform grants them to every org role. What an endpoint receives is still gated by the
  // event's own permission (`media:read`), re-checked for the owner at every fan-out.
  // RETRO-I1 (#562): the sharing slice's org grants. Nothing in MemoriaHub checks them yet: the
  // slice's own routes are mounted but empty until circles become groups (RETRO-I2..I5).
  contributor: ['ai:use', 'webhooks:read', 'webhooks:write', 'groups:read', 'groups:write', 'sharing:read', 'sharing:write'],
  // RETRO-D1 (#563): storage:write, widened to `viewer` through platformGrants (the objects API was a
  // bare @Auth() before, so viewers uploaded).
  viewer: ['webhooks:read', 'webhooks:write', 'groups:read', 'sharing:read', 'storage:write'],
};

/** Permissions a slice adoption retired: the platform's routes check another string. */
const RETIRED_BY_SLICE: Record<string, string> = {
  // RETRO-D2 (#570): /api/email-settings checks system_settings:read|write.
  'email_settings:read': 'system_settings:read',
  'email_settings:write': 'system_settings:write',
  // RETRO-D1 (#563): /api/admin/storage-config checks storage_config:read|write.
  'storage_settings:read': 'storage_config:read',
  'storage_settings:write': 'storage_config:write',
  // RETRO-I4 (#578): public shares are the sharing slice's link grants.
  'shares:manage': 'sharing:write',
  'shares:manage_any': 'sharing:admin',
};

/** A role's old row, each retired permission replaced by its successor. */
function migrated(role: 'contributor' | 'viewer'): string[] {
  return OLD_MATRIX[role].map((permission) => RETIRED_BY_SLICE[permission] ?? permission);
}

/** A role's permissions: the declared defaults plus the explicit grants (`platformGrants`, RETRO-D1). */
function grants(role: string): string[] {
  const byDefault = permissionRegistry
    .list()
    .filter((permission) => permission.defaultGrants.includes(role))
    .map((permission) => permission.id);
  const granted = roleGrantRegistry
    .list()
    .filter((grant) => grant.role === role)
    .map((grant) => grant.permission);
  return [...new Set([...byDefault, ...granted])].sort();
}

describe('role permission matrix', () => {
  it('contributor is exactly what it was, plus the slice grants', () => {
    expect(grants('contributor')).toEqual([...new Set([...migrated('contributor'), ...(GAINED_BY_SLICE.contributor ?? [])])].sort());
  });

  it('viewer is exactly what it was, plus the slice grants', () => {
    expect(grants('viewer')).toEqual([...new Set([...migrated('viewer'), ...(GAINED_BY_SLICE.viewer ?? [])])].sort());
  });

  it('an administrator (admin + org_admin) keeps every permission and gains only the new platform ones', () => {
    const now = new Set([...grants('admin'), ...grants('org_admin')]);
    for (const permission of OLD_MATRIX.admin) {
      // A retired permission's capability is held through its replacement.
      expect(now).toContain(RETIRED_BY_SLICE[permission] ?? permission);
    }
    for (const retired of Object.keys(RETIRED_BY_SLICE)) expect(now).not.toContain(retired);
    const replacements = new Set(Object.values(RETIRED_BY_SLICE));
    const gained = [...now]
      .filter((permission) => !OLD_MATRIX.admin.includes(permission) && !replacements.has(permission))
      .sort();
    expect(gained).toEqual([...NEW_PLATFORM_PERMISSIONS].sort());
  });

  it('no role is granted a permission of the other scope', () => {
    const roleScope: Record<string, string> = { admin: 'system', org_admin: 'org', contributor: 'org', viewer: 'org' };
    for (const permission of permissionRegistry.list()) {
      for (const role of permission.defaultGrants) {
        expect({ permission: permission.id, role, scope: roleScope[role] }).toEqual({
          permission: permission.id,
          role,
          scope: permission.scope,
        });
      }
    }
  });
});
