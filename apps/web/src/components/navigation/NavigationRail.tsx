/**
 * The navigation rail — this app's binding of the packaged
 * `ShellNavigationRail` (`@marinoscar/platform-web/shell/ui`, RETRO-F1 #571).
 *
 * The rail (collapsed 56px at `sm`–`lg`, expanded 220px at `lg` and up, the
 * pinned Console row at the foot, Console mode on `/admin/*` listing
 * `ADMIN_SECTIONS`, the desktop-only collapse toggle stored in
 * `user_settings.navigation.railCollapsed`, and the Collections / Review
 * context panes beside the expanded rail) lives in the package;
 * `config/shell.ts` supplies the destinations, the panes and the Console's
 * registry. `ShellLayout` mounts it at `sm` and up only (breakpoint gate 1).
 *
 * Two behaviours of the app's former rail did not move:
 *   - Search now has a rail row. The app used to leave it to the AppBar's
 *     search pill at `sm` and up; the package draws every destination it is
 *     given, and choosing per form factor would be a sixth breakpoint read.
 *     The pill is still there, so Search simply has two entry points.
 *   - The expanded rail's "Pinned" group (`user_settings.navigation.pinned`)
 *     is not drawn: the packaged rail has no slot for user shortcuts, and no
 *     surface in the web app writes pins. Stored pins are left untouched.
 */
import { ShellNavigationRail } from '@marinoscar/platform-web/shell/ui';
import { APP_NAVIGATION } from '../../config/shell';

export { RAIL_WIDTH_COLLAPSED, RAIL_WIDTH_EXPANDED } from '@marinoscar/platform-web/shell/ui';

export function NavigationRail() {
  return <ShellNavigationRail navigation={APP_NAVIGATION} />;
}

export default NavigationRail;
