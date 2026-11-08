/**
 * The platform's web conformance suites over MemoriaHub's settings registries
 * and live route table (RETRO-B5, #621). `@marinoscar/platform-web/settings/testing`
 * registers the five `settings-*` suites; every expectation is derived from
 * `ADMIN_SECTIONS`, `USER_SETTINGS_SECTIONS`, the text of `App.tsx` and the
 * API's generated permission catalog, never a copy.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '@marinoscar/platform-web/settings/testing';
import { runPlatformWebConformance } from '@marinoscar/platform-web/testing';
import { ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_SECTIONS } from '../config/adminSections';
import {
  USER_HUB_PATH,
  USER_HUB_TITLE,
  USER_SETTINGS_SECTIONS,
} from '../config/userSettingsSections';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX = resolve(HERE, '../App.tsx');
const PERMISSION_CATALOG = resolve(HERE, '../../../api/prisma/catalog/permissions.json');

const catalog = JSON.parse(readFileSync(PERMISSION_CATALOG, 'utf8')) as {
  permissions: { name: string }[];
};

runPlatformWebConformance({
  adminSections: ADMIN_SECTIONS,
  userSettingsSections: USER_SETTINGS_SECTIONS,
  hubs: {
    admin: { path: ADMIN_HUB_PATH, title: ADMIN_HUB_TITLE },
    user: { path: USER_HUB_PATH, title: USER_HUB_TITLE },
  },
  routes: { appTsx: readFileSync(APP_TSX, 'utf8') },
  apiPermissions: catalog.permissions.map((permission) => permission.name),
  suites: {
    // `settings-card-routes` still runs (every card path is routed under its
    // card's permission); only its destination half needs the table below.
    'settings-route-ownership': {
      skip:
        'MemoriaHub keeps /settings deliberately unowned by any destination (config/destinations.ts ' +
        'UNOWNED_ROUTES), which this suite and the destination half of settings-card-routes reject; ' +
        'route ownership is pinned by __tests__/config/destinations.test.ts until RETRO-F1 moves the shell.',
    },
    'settings-ai-cards': {
      skip:
        'MemoriaHub AI is not on the platform AI slice yet (RETRO-E4): the admin AI cards gate on the ' +
        'app permissions the app AI controllers enforce (ai_settings:read), not ai_config:*.',
    },
  },
});
