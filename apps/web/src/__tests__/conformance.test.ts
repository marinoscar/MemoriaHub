/**
 * The platform's web conformance suites over MemoriaHub's settings registries
 * and live route table (RETRO-B5, #621), and the shell suites (RETRO-F1, #571). `@marinoscar/platform-web/settings/testing`
 * registers the five `settings-*` suites; every expectation is derived from
 * `ADMIN_SECTIONS`, `USER_SETTINGS_SECTIONS`, the text of `App.tsx` and the
 * API's generated permission catalog, never a copy.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '@marinoscar/platform-web/settings/testing';
// The shell suites (RETRO-F1, #571): `shell-layout-variants` (the padded /
// full-bleed `<main>` and the context pane the map and the Collections / Review
// destinations rely on) and `shell-local-host`.
import '@marinoscar/platform-web/shell/testing';
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
        'route ownership is pinned by __tests__/config/destinations.test.ts and navigation/reachability.test.tsx.',
    },
    'shell-local-host': {
      skip:
        'MemoriaHub is a server host: the shell reads permissions from the signed-in AuthProvider and the ' +
        'rail preference from /user-settings; there is no local (no-API) host to prove.',
    },
    // RETRO-E4 (#607): the admin AI cards are the platform's (AI, AI Models, AI Usage on
    // ai_config:read, `feature: 'ai'` except the AI card). The suite also requires at least one
    // per-user AI card (`ai:use`, the AI Keys page), which MemoriaHub deliberately does not ship.
    'settings-ai-cards': {
      skip:
        'Requires a per-user AI card (ai:use, the AI Keys page): MemoriaHub uses deployment keys only, with no ' +
        'user BYOK and no Playground (RETRO-E1 decision; EnterpriseAppBase #1132 requests a deployment-only key ' +
        'policy). The admin half of the suite (permission in the catalog, feature gating, the AI card ungated, ' +
        'no AI card without ai_config:*) runs in __tests__/platform/ai/aiAdminCards.test.ts.',
    },
  },
});
