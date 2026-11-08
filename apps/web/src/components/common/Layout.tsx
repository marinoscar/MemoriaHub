import { ShellProviders } from '@marinoscar/platform-web/shell/headless';
import { ShellLayout } from '@marinoscar/platform-web/shell/ui';
import type { ShellMainVariant } from '@marinoscar/platform-web/shell/headless';
import { MaintenanceBanner } from '@marinoscar/platform-web/host/ui';
import { AppBar } from '../navigation/AppBar';
import { NavigationRail } from '../navigation/NavigationRail';
import { BottomNav } from '../navigation/BottomNav';
import { TimezonePrompt } from '../settings/TimezonePrompt';
import { NotificationPermissionBanner } from '@marinoscar/platform-web/notifications/ui';
import { usePushSubscriptionSync } from '@marinoscar/platform-web/notifications/headless';
import { AndroidUpdateBanner } from './AndroidUpdateBanner';
import { useCircleLinkParam } from '../../hooks/useCircleLinkParam';
import { APP_NAVIGATION } from '../../config/shell';
import { APP_SHELL_PROVIDERS } from '../../platform/shellProviders';

interface LayoutProps {
  /**
   * How `<main>` is drawn when the page does not ask itself
   * (`useShellMainVariant`). Default `'padded'`.
   */
  mainVariant?: ShellMainVariant;
}

/**
 * The app shell — this app's binding of the packaged `ShellLayout`
 * (`@marinoscar/platform-web/shell/ui`, RETRO-F1 #571; the shell design is
 * issue #392, epic #388).
 *
 *   compact (< sm)  →  bottom bar only. No drawer, no hamburger.
 *   medium  (sm–lg) →  a permanent collapsed rail (56px).
 *   expanded (≥ lg) →  the expanded rail (220px) plus, for Collections and
 *                      Review, the context pane beside it.
 *
 * The chrome is chosen by MOUNTING in the package. This file fills its slots:
 * the AppBar, rail and bottom-bar bindings, the shell-wide banners above the
 * page and the time-zone prompt. A page that owns the whole content area (the
 * map) asks for it with `useShellMainVariant('full-bleed')`: no padding and no
 * banners, without remounting the shell.
 *
 * ⚠️ FIVE BREAKPOINT GATES ARE COUPLED AND MUST MOVE TOGETHER, all at `sm`
 * (600px), never `md` (issue #402). All five now live in
 * `@marinoscar/platform-web`, which this repository does not edit:
 *   1. `ShellLayout`'s `showRail` (`up('sm')`)       shell/ui/ShellLayout
 *   2. `ShellBottomNav`'s `down('sm')` self-gate     shell/ui/ShellBottomNav
 *   3. `<main>`'s `pb: { xs: 10, sm: 3 }`            shell/ui/ShellLayout
 *   4. `SettingsHub`'s `isCompactWindow`             settings/ui/SettingsHub
 *   5. `ShellAppBar`'s `isCompactWindow`             shell/ui/ShellAppBar
 * Nothing in this file reads a breakpoint, and nothing may:
 * `__tests__/config/breakpointGates.test.ts` fails on a new read.
 */
export function Layout({ mainVariant }: LayoutProps) {
  // Browser notifications (issue #486; the platform slice since RETRO-D3).
  // Mounted ONCE, here, because this shell only renders for an authenticated
  // user: auto-prompts for permission when push is on and keeps this device's
  // push subscription registered. A notification link's `?c=<circleId>` switches
  // the active circle, whichever way it was opened.
  const pushSync = usePushSubscriptionSync();
  useCircleLinkParam();

  return (
    <ShellProviders providers={APP_SHELL_PROVIDERS}>
      <ShellLayout
        navigation={APP_NAVIGATION}
        mainVariant={mainVariant}
        appBar={<AppBar />}
        rail={<NavigationRail />}
        bottomNav={<BottomNav />}
        // Each renders NOTHING on an ordinary day; the full-bleed variant
        // drops them all.
        banners={
          <>
            {/* Issue #348. Nothing for non-admins, nothing outside a window. */}
            <MaintenanceBanner />
            <NotificationPermissionBanner
              config={pushSync.config}
              capability={pushSync.capability}
              onRequestPermission={() => void pushSync.requestPermission()}
              isRequestingPermission={pushSync.isRequestingPermission}
            />
            {/* Issue #515: only inside the app's TWA, when the installed build
                is older than the hosted release. */}
            <AndroidUpdateBanner />
          </>
        }
        // Renders only when `AuthProvider` detected a time-zone mismatch
        // (issue #444). Mounted here because this is the highest themed point
        // below the auth provider that owns the state.
        overlays={<TimezonePrompt />}
      />
    </ShellProviders>
  );
}
