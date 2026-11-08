import { useCallback } from 'react';
import { useUserSettings as usePlatformUserSettings } from '@marinoscar/platform-web/settings/headless';

import { useThemeContext } from '../contexts/ThemeContext';
import { appPlatformApi } from '../platform/platformHost';
import type { UserSettings, UserSettingsUpdate } from '../types';

interface UseUserSettingsOptions {
  /**
   * Push the fetched `theme` into `ThemeContext` on load. Default `true`.
   *
   * Pass `false` when the hook is mounted for some OTHER namespace (issue #392's former `useNavigationPrefs`
   * reads `navigation` from the always-mounted navigation rail). Without the opt-out, adding a
   * settings consumer to the app shell would silently make the stored theme authoritative on EVERY
   * page load and stamp over the AppBar's local light/dark toggle.
   */
  syncTheme?: boolean;
}

/**
 * The signed-in user's settings (`/api/user-settings`) over the platform settings slice's hook
 * (RETRO-B3, #614): the fetch contract, `If-Match`, the 409 refetch and the theme sync are the
 * package's. This binds the app's document type, its theme context and its HTTP client.
 *
 * `syncTimeZone` is off on purpose: the package keeps its display-zone store on `profile.timezone`,
 * while this app stores the zone at the top level (`timezone`, absent is not UTC) and has its own
 * zone store (issue #444).
 */
export function useUserSettings(options: UseUserSettingsOptions = {}) {
  const { syncTheme = true } = options;
  const { setMode } = useThemeContext();

  const applyTheme = useCallback(
    (theme: string) => {
      if (theme === 'light' || theme === 'dark' || theme === 'system') setMode(theme);
    },
    [setMode],
  );

  const result = usePlatformUserSettings<UserSettings, UserSettingsUpdate>({
    api: appPlatformApi,
    syncTheme,
    applyTheme,
    syncTimeZone: false,
  });

  const { updateSettings } = result;
  /** Store an IANA time zone, e.g. `America/Costa_Rica` (issue #444). */
  const updateTimezone = useCallback(
    async (timezone: string) => {
      await updateSettings({ timezone });
    },
    [updateSettings],
  );

  return { ...result, updateTimezone };
}
