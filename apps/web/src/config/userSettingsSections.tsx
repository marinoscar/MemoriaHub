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
 * signed-in user may use. The one gated card is `Media sync`, behind
 * `media:read`, the string `media-sync.controller.ts` enforces on
 * `GET /api/media-sync/devices` (and the route's `RequirePermission`).
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
];
