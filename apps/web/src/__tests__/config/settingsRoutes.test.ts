/**
 * The settings registries against the live `App.tsx` (RETRO-B5, #621).
 *
 * The platform's `settings-card-routes` suite checks card → route; this file
 * checks the other direction (every settings route belongs to a card, so no
 * settings page exists outside the hubs), pins every admin card's permission
 * to the string its controller enforces, and keeps the pre-existing settings
 * URLs resolving.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppRoutes } from '@marinoscar/platform-web/settings/testing';
import { ADMIN_HUB_PATH, ADMIN_SECTIONS } from '../../config/adminSections';
import { USER_HUB_PATH, USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

const HERE = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(HERE, '../../App.tsx'), 'utf8');
const routes = parseAppRoutes(appSource);
const routePaths = new Set(routes.map((r) => r.path));
const cardPaths = new Set(
  [...ADMIN_SECTIONS, ...USER_SETTINGS_SECTIONS].flatMap((s) => s.cards.flatMap((c) => (c.path ? [c.path] : []))),
);

/**
 * Settings routes that are deliberately not cards: a child page reached from
 * its card's page, and the retired v0 backup URL, which redirects.
 */
const NOT_CARDS = new Set(['/admin/settings/nodes/:id/backup', '/admin/settings/backup']);

/**
 * Every admin card's permission, and the controller that enforces it on the
 * page's read (paths under apps/api/src unless noted). Changing a card's
 * permission without changing the API is the split-brain the registry exists
 * to prevent, so this list changes only with a controller.
 */
const ENFORCED_ADMIN_PERMISSIONS: Record<string, string> = {
  '/admin/settings/general': 'system_settings:read', // platform settings: system-settings.controller
  '/admin/settings/users': 'users:read', // platform identity: users.controller
  '/admin/settings/archiving': 'system_settings:read', // system settings
  '/admin/settings/email': 'system_settings:read', // platform email: email-settings.controller (RETRO-D2)
  '/admin/settings/push': 'push:read', // notifications/push/push-config.controller
  '/admin/settings/notifications': 'system_settings:read', // system settings (notifications.* policy)
  '/admin/settings/android': 'system_settings:read', // android-app/android-app.controller
  '/admin/settings/setup': 'system_settings:read', // platform onboarding (admin block, metrics) RETRO-H3
  '/admin/settings/ai': 'ai_settings:read', // ai/ai-settings.controller
  '/admin/settings/tagging': 'ai_settings:read', // tagging/tag-labels.controller
  '/admin/settings/face': 'face_settings:read', // face/face-settings.controller
  '/admin/settings/bursts': 'system_settings:read', // system settings (burst.*)
  '/admin/settings/duplicates': 'system_settings:read', // dedup/admin-duplicate.controller
  '/admin/settings/enhancer': 'system_settings:read', // enhancement/admin-enhancement.controller
  '/admin/settings/memories': 'system_settings:read', // system settings (memories.*)
  '/admin/settings/social-media': 'system_settings:read', // social-media/admin-social-media.controller
  '/admin/settings/geo': 'system_settings:read', // system settings (geo.*)
  '/admin/settings/location-inference': 'system_settings:read', // system settings (locationInference.*)
  '/admin/settings/location-groups': 'geo_settings:read', // location-groups/location-groups.controller
  '/admin/settings/storage/providers': 'storage_settings:read', // storage-settings/storage-settings.controller
  '/admin/settings/storage/insights': 'system_settings:read', // insights/insights.controller
  '/admin/settings/jobs': 'jobs:read', // enrichment/enrichment-admin.controller
  '/admin/settings/jobs/insights': 'jobs:read', // enrichment/enrichment-admin.controller
  '/admin/settings/nodes': 'jobs:read', // nodes/nodes-admin.controller
  '/admin/settings/db-backup': 'db_backup:read', // platform db-backup slice: DatabaseBackupController (RETRO-D4)
  '/admin/settings/sharing': 'shares:manage_any', // share/share.service (scope=all)
  '/admin/settings/workflows': 'system_settings:read', // workflows/admin/workflows-admin.controller
  '/admin/settings/doctor': 'system_settings:read', // platform doctor: DEFAULT_DOCTOR_PERMISSION
  '/admin/settings/broadcasts': 'broadcasts:read', // notifications/broadcasts/broadcasts.controller
  '/admin/settings/maintenance': 'system_settings:read', // platform host: maintenance controller
  '/admin/settings/about': 'system_settings:read', // platform host: about controller
  // RETRO-T2 (#625): platform telemetry controllers (TELEMETRY_PERMISSION_DECLARATIONS).
  '/admin/settings/telemetry': 'telemetry:read', // telemetry-admin.controller (GET admin/telemetry/config)
  '/admin/settings/telemetry/explorer': 'telemetry:query', // telemetry-explorer.controller
  '/admin/settings/telemetry/dashboard': 'telemetry:query', // telemetry dashboard controller
  // RETRO-H5 (#609): platform alerts controller (ALERTS_PERMISSIONS; GET admin/alerts/*).
  '/admin/settings/alerts': 'alerts:read',
  // RETRO-H1 (#591): platform user-data slice, factory reset controller (USER_DATA_PERMISSIONS).
  '/admin/settings/factory-reset': 'system:factory_reset',
  // RETRO-H4 (#603): platform webhooks admin controller (SYSTEM_WEBHOOKS_PERMISSIONS).
  '/admin/settings/webhooks': 'system_webhooks:read', // admin-webhooks.controller (GET admin/webhooks)
  // RETRO-H2 (#596): platform exports service (ORG_DATA_EXPORT_PERMISSION for `org-data`).
  '/admin/settings/data-export': 'org_members:read',
};

describe('settings routes against the registries', () => {
  it('reads the live route table', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it.each([
    ['admin', ADMIN_HUB_PATH],
    ['user', USER_HUB_PATH],
  ])('gives every %s settings route a card (no settings page outside the hub)', (_name, hub) => {
    const orphans = routes
      .map((r) => r.path)
      .filter((path) => path.startsWith(`${hub}/`))
      .filter((path) => !cardPaths.has(path) && !NOT_CARDS.has(path));
    expect(orphans).toEqual([]);
  });

  it('pins every admin card’s permission to the string its controller enforces', () => {
    const actual = Object.fromEntries(
      ADMIN_SECTIONS.flatMap((s) => s.cards).map((c) => [c.path, c.permission]),
    );
    expect(actual).toEqual(ENFORCED_ADMIN_PERMISSIONS);
  });

  it.each([
    '/settings',
    '/settings/tokens',
    '/settings/android-app',
    '/settings/media-sync',
    '/profile',
    ADMIN_HUB_PATH,
    ...Object.keys(ENFORCED_ADMIN_PERMISSIONS),
    '/admin/settings/nodes/:id/backup',
    '/admin/settings/backup',
    '/admin/users',
    '/admin/ai-settings',
    '/admin/face-settings',
    '/admin/jobs',
    '/admin/tags',
    '/admin/insights',
    '/admin/storage-providers',
    '/admin/backup',
  ])('keeps the pre-existing settings URL %s routed', (path) => {
    expect(routePaths.has(path)).toBe(true);
  });
});
