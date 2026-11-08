/**
 * The user-data slice's two Danger Zone cards (RETRO-H1, #591).
 *
 * Both registries end with a `Danger Zone` group (the one documented exception
 * to append-only), checked with the platform's own web conformance helper; the
 * user card has no permission (the API scopes it to the caller's own data), the
 * admin card carries the exact `system:factory_reset` the controller enforces.
 */
import { describe, expect, it } from 'vitest';
import { DANGER_ZONE_GROUP_LABEL, dangerZoneLastViolations } from '@marinoscar/platform-web/user-data/headless';

import { ADMIN_SECTIONS, visibleAdminSections } from '../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

describe('Danger Zone cards (RETRO-H1)', () => {
  it('keeps the Danger Zone group last in both registries', () => {
    expect(dangerZoneLastViolations(USER_SETTINGS_SECTIONS, '/settings/danger-zone')).toEqual([]);
    expect(dangerZoneLastViolations(ADMIN_SECTIONS, '/admin/settings/factory-reset')).toEqual([]);
    expect(USER_SETTINGS_SECTIONS.at(-1)?.label).toBe(DANGER_ZONE_GROUP_LABEL);
    expect(ADMIN_SECTIONS.at(-1)?.label).toBe(DANGER_ZONE_GROUP_LABEL);
  });

  it('declares the user card without a permission and the admin card on system:factory_reset', () => {
    const user = USER_SETTINGS_SECTIONS.at(-1)!.cards;
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ path: '/settings/danger-zone' });
    expect(user[0].permission).toBeUndefined();

    const admin = ADMIN_SECTIONS.at(-1)!.cards;
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({ path: '/admin/settings/factory-reset', permission: 'system:factory_reset' });
  });

  it('hides the factory reset from an administrator who only holds system_settings:write', () => {
    const visible = visibleAdminSections((permission) => permission === 'system_settings:write');
    expect(visible.some((section) => section.label === DANGER_ZONE_GROUP_LABEL)).toBe(false);
    const allowed = visibleAdminSections((permission) => permission === 'system:factory_reset');
    expect(allowed.map((section) => section.label)).toEqual([DANGER_ZONE_GROUP_LABEL]);
  });
});
