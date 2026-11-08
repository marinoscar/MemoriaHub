/**
 * The providers around the signed-in shell, as ONE ordered list for the
 * packaged `ShellProviders` (`@marinoscar/platform-web/shell/headless`,
 * RETRO-F1 #571), outermost first. They used to be a staircase inside
 * `Layout.tsx`; the order is unchanged.
 *
 *   - `MediaRefreshProvider`: the AppBar's Upload refreshes the open gallery.
 *   - `MediaPreviewProvider`: the shared media preview state.
 *   - `SearchProvider`: the AppBar's search pill and `SearchPage` share it.
 *
 * Mounted around `Layout` (App.tsx), so the AppBar slot and every page are
 * inside them.
 */
import type { ShellProvider } from '@marinoscar/platform-web/shell/headless';
import { MediaRefreshProvider } from '../contexts/MediaRefreshContext';
import { MediaPreviewProvider } from '../contexts/MediaPreviewContext';
import { SearchProvider } from '../contexts/SearchContext';

export const APP_SHELL_PROVIDERS: readonly ShellProvider[] = [
  MediaRefreshProvider,
  MediaPreviewProvider,
  SearchProvider,
];
