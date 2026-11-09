/**
 * The per-user settings information architecture (`/settings`) — the same
 * registry shape as `adminSections.tsx`, drawn by the same packaged
 * `SettingsHub` (RETRO-B5, #621).
 *
 * `/settings` used to be one page stacking every preference. Each of those
 * sections is now a card here and a page under `/settings/<card>`; the hub is
 * a binding over the packaged component (`pages/UserSettingsHubPage.tsx`).
 * Append new cards; never insert one between existing cards, and never add a
 * settings page as a tab of another (Settings UI Pattern).
 *
 * PERMISSIONS. A card's `permission` is the exact string the API enforces, so
 * almost every card here declares none: the pages edit the caller's own
 * settings through `/api/user-settings` and `/api/users/me/*`, which every
 * signed-in user may use. The gated cards are `Media sync`, behind
 * `media:read`, the string `media-sync.controller.ts` enforces on
 * `GET /api/media-sync/devices` (and the route's `RequirePermission`), and
 * `Webhooks`, behind `webhooks:read` (`GET /api/webhooks`).
 */

import './settingsFeatures';
import PersonIcon from '@mui/icons-material/Person';
import PaletteIcon from '@mui/icons-material/Palette';
import ScheduleIcon from '@mui/icons-material/Schedule';
import NotificationsIcon from '@mui/icons-material/Notifications';
import AutoAwesomeMotionIcon from '@mui/icons-material/AutoAwesomeMotion';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import AndroidIcon from '@mui/icons-material/Android';
import PhonelinkRingIcon from '@mui/icons-material/PhonelinkRing';
import { identityUserSettingsSections } from '@marinoscar/platform-web/identity/ui';
// RETRO-H1 (#591): the user-data slice's Danger Zone card, in its pinned-last group.
import { DANGER_ZONE_GROUP_LABEL } from '@marinoscar/platform-web/user-data/headless';
import { dangerZoneSettingsPage } from '@marinoscar/platform-web/user-data/ui';
import { gettingStartedSettingsPage } from '@marinoscar/platform-web/onboarding/ui';
import { webhooksUserSettingsSections } from '@marinoscar/platform-web/webhooks/ui';
import { dataExportSettingsPage } from '@marinoscar/platform-web/exports/ui';
import { groupsSettingsPage } from '@marinoscar/platform-web/sharing/ui';
import type { SettingsSectionDef } from '@marinoscar/platform-web/settings/ui';
import { ANDROID_APP_SETTINGS_PATH, MEDIA_SYNC_SETTINGS_PATH } from '../services/androidApp';

/** The per-user hub itself — the one `/settings` route that owns no card. */
export const USER_HUB_PATH = '/settings';
export const USER_HUB_TITLE = 'Settings';

/** The per-user settings sections, in hub order. */
export const USER_SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'Account',
    cards: [
      {
        // Issue #354. The page formerly at `/profile`, which still resolves
        // (it redirects here).
        title: 'Profile',
        description: 'Your display name and profile picture, and the person you are in your photos.',
        Icon: PersonIcon,
        path: '/settings/profile',
      },
      {
        title: 'Appearance',
        description: 'Choose a light, dark, or system-matched theme.',
        Icon: PaletteIcon,
        path: '/settings/appearance',
      },
      {
        // Issue #444. MemoriaHub's page: absent is not UTC.
        title: 'Time zone',
        description: 'The time zone used to show dates and times.',
        Icon: ScheduleIcon,
        path: '/settings/time-zone',
      },
      {
        // Issue #251 (until RETRO-D3 moves it to the packaged page).
        title: 'Notifications',
        description: 'Choose which notifications you receive, in the app and on this device.',
        Icon: NotificationsIcon,
        path: '/settings/notifications',
      },
      {
        // Issue #313.
        title: 'Memories',
        description: 'Hide people and dates from your memories, and choose whether you get the email digest.',
        Icon: AutoAwesomeMotionIcon,
        path: '/settings/memories',
      },
      {
        title: 'Search',
        description: 'Choose which fields the search panel offers.',
        Icon: ManageSearchIcon,
        path: '/settings/search',
      },
      {
        // RETRO-H3 (#599): the onboarding slice's card, appended, as data. NO permission:
        // `GET /api/onboarding` needs only `user_settings:read`, which every role holds. It stays
        // after the checklist is dismissed: this is where the user finds it again.
        ...gettingStartedSettingsPage.card,
        Icon: gettingStartedSettingsPage.Icon,
      },
    ],
  },
  {
    // Issue #515 (epic #498). The two pages the stacked page's Android panel
    // linked to; their URLs are unchanged.
    label: 'Android',
    cards: [
      {
        title: 'Android app',
        description: 'Download the MemoriaHub Android app for your phone.',
        Icon: AndroidIcon,
        path: ANDROID_APP_SETTINGS_PATH,
      },
      {
        title: 'Media sync',
        description: 'See and manage the phones that back up their photos and videos to this server.',
        Icon: PhonelinkRingIcon,
        path: MEDIA_SYNC_SETTINGS_PATH,
        permission: 'media:read',
      },
    ],
  },
  {
    // RETRO-B2 (#611): `Access Tokens` (`/settings/tokens`, no permission) is
    // the identity slice's card, as data.
    label: 'Security',
    cards: [...identityUserSettingsSections.security],
  },
  {
    // RETRO-H4 (#603): `Webhooks` (`/settings/webhooks`), the caller's own endpoints, from the
    // webhooks slice as data. `webhooks:read` is the string `GET /api/webhooks` enforces (every
    // org role holds it); writes need `webhooks:write`, gated inside the page.
    label: 'Integrations',
    cards: [...webhooksUserSettingsSections.integrations],
  },
  {
    // RETRO-H2 (#596): "Download your data", the exports slice's card and page as data
    // (`dataExportSettingsPage`, route `/settings/data-export`, where `export.ready` links).
    // Added BEFORE the pinned-last Danger Zone group. No `permission`: the API checks each
    // source (`user-data` on `user_settings:read`, MemoriaHub's on `media:read`, both every role).
    label: 'Your data',
    cards: [{ ...dataExportSettingsPage.card, Icon: dataExportSettingsPage.Icon }],
  },
  {
    // RETRO-I6 (#588): `Groups` (`/settings/groups`), the sharing slice's card and pages as data:
    // the shared libraries that were circles. `groups:read` is the string `GET /api/groups`
    // enforces (every role holds it); create, rename, members and invites are gated inside the
    // pages (`groups:write`, the group's admin role). Added BEFORE the pinned-last Danger Zone.
    label: 'Sharing',
    cards: [{ ...groupsSettingsPage.card, Icon: groupsSettingsPage.Icon }],
  },
  {
    // RETRO-H1 (#591). `Danger Zone`, PINNED LAST: the one documented exception to
    // append-only (a group added later goes BEFORE this one; the registry test
    // asserts it with `dangerZoneLastViolations`). The card, its icon and its page
    // are the platform's (`dangerZoneSettingsPage`, route `/settings/danger-zone`);
    // which scopes it offers comes from the API's user-data registries
    // (`apps/api/src/platform/user-data/user-data.manifest.ts`). No `permission`:
    // the API gates the routes on `user_settings:write`, which every role holds,
    // and each request is scoped to the caller's own data.
    label: DANGER_ZONE_GROUP_LABEL,
    cards: [{ ...dangerZoneSettingsPage.card, Icon: dangerZoneSettingsPage.Icon }],
  },
];
