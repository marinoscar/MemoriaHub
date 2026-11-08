/**
 * This app's binding of the packaged app shell (`@marinoscar/platform-web/shell`,
 * RETRO-F1, #571): the ONE navigation object every shell surface reads.
 *
 *   - `destinations` / `destinationRoutes`: the destination model
 *     (`config/destinations.ts`), so the rail, the bottom bar and the context
 *     panes draw the same table with the same visibility and active-state rules;
 *   - `settingsSurfaces`: what the compact AppBar drills into below `sm`
 *     (back arrow + the resolved page title), admin first;
 *   - `console`: the expanded rail's Console mode on `/admin/*`, listing
 *     `ADMIN_SECTIONS` with the same permission and feature filter the hub uses.
 *
 * The rail's collapse preference is the package default
 * (`useShellRailPreference`): the same `user_settings.navigation.railCollapsed`
 * field the app's own rail used to store, so a saved preference carries over.
 *
 * Declared once, at module scope: the shell compares destination references.
 */
import CollectionsIcon from '@mui/icons-material/Collections';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import HomeIcon from '@mui/icons-material/Home';
import SearchIcon from '@mui/icons-material/Search';
import type { ShellDestination, ShellNavigation } from '@marinoscar/platform-web/shell/headless';

// Registers the app's settings features (`orgs`) before any shell surface reads
// the feature map.
import './settingsFeatures';
import { CollectionsContextPane, ReviewContextPane } from '../components/navigation/NavContextPane';
import { useReviewQueues } from '../hooks/useReviewQueues';
import { ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_SECTIONS } from './adminSections';
import { DESTINATION_ROUTES } from './destinations';
import type { DestinationKey } from './destinations';
import { USER_HUB_PATH, USER_HUB_TITLE, USER_SETTINGS_SECTIONS } from './userSettingsSections';

/**
 * Review's badge: the aggregate pending count across every enabled review
 * queue. A module-level hook (the shell calls it once per surface that draws
 * the destination, and only one navigation surface is mounted at any width),
 * so `useReviewCounts` is not doubled.
 */
export function useReviewQueueBadge(): number | null {
  const { totalPending } = useReviewQueues();
  return totalPending > 0 ? totalPending : null;
}

/**
 * The destinations, in navigation order. Review renders UNCONDITIONALLY (spec
 * §6.3): navigation that changes shape is worse than navigation that is
 * slightly long; it keeps the destination and drops the badge at zero.
 *
 * The Console is `pinned`: a mode at the foot of the rail, not a peer of the
 * library destinations. Its `permission` is the admin-only string the API's
 * system-settings controller enforces; the hub itself redirects non-admins.
 */
export const DESTINATIONS: readonly ShellDestination<DestinationKey>[] = [
  { key: 'photos', label: 'Photos', compactLabel: 'Photos', Icon: HomeIcon, path: '/' },
  {
    key: 'collections',
    label: 'Collections',
    compactLabel: 'Collect',
    Icon: CollectionsIcon,
    path: '/collections',
    contextPane: CollectionsContextPane,
  },
  { key: 'search', label: 'Search', compactLabel: 'Search', Icon: SearchIcon, path: '/search' },
  {
    key: 'review',
    label: 'Review',
    compactLabel: 'Review',
    Icon: FactCheckIcon,
    path: '/review',
    badge: useReviewQueueBadge,
    contextPane: ReviewContextPane,
  },
  {
    key: 'console',
    label: 'Console',
    compactLabel: 'Console',
    Icon: AdminIcon,
    path: ADMIN_HUB_PATH,
    permission: 'system_settings:read',
    pinned: true,
  },
];

export const APP_NAVIGATION: ShellNavigation<DestinationKey> = {
  destinations: DESTINATIONS,
  destinationRoutes: DESTINATION_ROUTES,
  settingsSurfaces: [
    { sections: ADMIN_SECTIONS, hubPath: ADMIN_HUB_PATH, hubTitle: ADMIN_HUB_TITLE },
    { sections: USER_SETTINGS_SECTIONS, hubPath: USER_HUB_PATH, hubTitle: USER_HUB_TITLE },
  ],
  console: { prefix: '/admin', sections: ADMIN_SECTIONS },
};

/**
 * The phone bar's navigation: every destination except the pinned ones. The
 * Console is not a tab (spec §4.4: on a phone the admin surface is a place you
 * drill into from the avatar menu, not a mode), so the bar stays the four
 * library destinations and never overflows into a More sheet.
 */
export const PHONE_BAR_NAVIGATION: ShellNavigation<DestinationKey> = {
  ...APP_NAVIGATION,
  destinations: DESTINATIONS.filter((destination) => destination.pinned !== true),
};
