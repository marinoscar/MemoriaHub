/**
 * The providers around the signed-in shell, as ONE ordered list for the
 * packaged `ShellProviders` (`@marinoscar/platform-web/shell/headless`,
 * RETRO-F1 #571), outermost first. They used to be a staircase inside
 * `Layout.tsx`; the order is unchanged.
 *
 *   - `NotificationProvider` (`@marinoscar/platform-web/notifications`, RETRO-D3):
 *     the live inbox, unread count and SSE stream the AppBar bell and the
 *     Notifications page read.
 *   - `MediaRefreshProvider`: the AppBar's Upload refreshes the open gallery.
 *   - `MediaPreviewProvider`: the shared media preview state.
 *   - `SearchProvider`: the AppBar's search pill and `SearchPage` share it.
 *
 * Mounted around `Layout` (App.tsx), so the AppBar slot and every page are
 * inside them.
 */
import type { ShellProvider } from '@marinoscar/platform-web/shell/headless';
import { NotificationProvider } from '@marinoscar/platform-web/notifications/headless';
import { MediaRefreshProvider } from '../contexts/MediaRefreshContext';
import { MediaPreviewProvider } from '../contexts/MediaPreviewContext';
import { SearchProvider } from '../contexts/SearchContext';

export const APP_SHELL_PROVIDERS: readonly ShellProvider[] = [
  NotificationProvider,
  MediaRefreshProvider,
  MediaPreviewProvider,
  SearchProvider,
];
