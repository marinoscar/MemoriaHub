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
 *   - `AiConfigProvider` (`@marinoscar/platform-web/ai`, RETRO-E4): the one
 *     `GET /api/ai/config` answer the `ai` settings feature, `RequireAiEnabled`
 *     and the admin AI page read (the page refreshes it after switching AI).
 *
 * Mounted around `Layout` (App.tsx), so the AppBar slot and every page are
 * inside them.
 */
import type { ShellProvider } from '@marinoscar/platform-web/shell/headless';
import { NotificationProvider } from '@marinoscar/platform-web/notifications/headless';
import { AiConfigProvider } from '@marinoscar/platform-web/ai/headless';
import { MediaRefreshProvider } from '@marinoscar/memoriahub-web/media/headless';
import { MediaPreviewProvider } from '@marinoscar/memoriahub-web/media/headless';
import { SearchProvider } from '@marinoscar/memoriahub-web/search/ui';
import { MemoriahubSearchBridge } from '../platform-memoriahub/HostBinding';

export const APP_SHELL_PROVIDERS: readonly ShellProvider[] = [
  NotificationProvider,
  MediaRefreshProvider,
  MediaPreviewProvider,
  SearchProvider,
  AiConfigProvider,
  // RETRO-J11 (#626): adds the search surface to the packaged slices' host (needs `SearchProvider`).
  MemoriahubSearchBridge,
];
