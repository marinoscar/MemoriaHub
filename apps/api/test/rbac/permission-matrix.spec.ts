import { permissionRegistry } from '@marinoscar/platform-api/core';

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
  'org_invites:read',
  'org_invites:write',
  'org_members:read',
  'org_members:write',
  'org_settings:read',
  'org_settings:write',
  'organizations:read',
  'organizations:write',
];

/** Permissions a slice adoption retired: the platform's routes check another string. */
const RETIRED_BY_SLICE: Record<string, string> = {
  // RETRO-D2 (#570): /api/email-settings checks system_settings:read|write.
  'email_settings:read': 'system_settings:read',
  'email_settings:write': 'system_settings:write',
};

function grants(role: string): string[] {
  return permissionRegistry
    .list()
    .filter((permission) => permission.defaultGrants.includes(role))
    .map((permission) => permission.id)
    .sort();
}

describe('role permission matrix', () => {
  it('contributor is exactly what it was', () => {
    expect(grants('contributor')).toEqual([...OLD_MATRIX.contributor].sort());
  });

  it('viewer is exactly what it was', () => {
    expect(grants('viewer')).toEqual([...OLD_MATRIX.viewer].sort());
  });

  it('an administrator (admin + org_admin) keeps every permission and gains only the new platform ones', () => {
    const now = new Set([...grants('admin'), ...grants('org_admin')]);
    for (const permission of OLD_MATRIX.admin) {
      // A retired permission's capability is held through its replacement.
      expect(now).toContain(RETIRED_BY_SLICE[permission] ?? permission);
    }
    for (const retired of Object.keys(RETIRED_BY_SLICE)) expect(now).not.toContain(retired);
    const gained = [...now].filter((permission) => !OLD_MATRIX.admin.includes(permission)).sort();
    expect(gained).toEqual(NEW_PLATFORM_PERMISSIONS);
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
