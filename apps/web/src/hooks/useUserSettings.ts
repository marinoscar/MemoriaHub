import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { UserSettings, UserSettingsUpdate } from '../types';
import { useThemeContext } from '../contexts/ThemeContext';
import { useIsMounted } from './useIsMounted';

interface UseUserSettingsReturn {
  settings: UserSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  /**
   * PATCH a subset of settings. Takes `UserSettingsUpdate` rather than
   * `Partial<UserSettings>` so a `notifications.types` entry can be sent as
   * `null` to DELETE the override (JSON Merge Patch) — see issue #251.
   */
  updateSettings: (updates: UserSettingsUpdate) => Promise<void>;
  updateTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>;
  updateProfile: (profile: UserSettings['profile']) => Promise<void>;
  refresh: () => Promise<void>;
}

interface UseUserSettingsOptions {
  /**
   * Push the fetched `theme` into `ThemeContext` on load. Default `true`.
   *
   * Pass `false` when the hook is mounted for some OTHER namespace (issue
   * #392's `useNavigationPrefs` reads `navigation` from the always-mounted
   * navigation rail). Without the opt-out, adding a settings consumer to the
   * app shell would silently make the stored theme authoritative on EVERY page
   * load and stamp over the AppBar's local light/dark toggle — a behaviour
   * change that has nothing to do with the namespace the new consumer wanted.
   */
  syncTheme?: boolean;
}

export function useUserSettings(
  options: UseUserSettingsOptions = {},
): UseUserSettingsReturn {
  const { syncTheme = true } = options;
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { setMode } = useThemeContext();
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<UserSettings>('/user-settings');
      if (!isMounted()) return;
      setSettings(data);
      // Sync theme with settings — unless this consumer opted out (see
      // `syncTheme`), in which case it is here for a different namespace and
      // has no business moving the user's theme.
      if (syncTheme) setMode(data.theme);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof ApiError ? err.message : 'Failed to load settings';
      setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [setMode, isMounted, syncTheme]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: UserSettingsUpdate) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<UserSettings>('/user-settings', updates, {
          headers: {
            'If-Match': settings.version.toString(),
          },
        });

        if (isMounted()) {
          setSettings(data);

          // Sync theme if changed. Unconditional on `syncTheme`: an opted-out
          // consumer never SENDS a theme, and a caller that explicitly patches
          // one is asking for it to take effect.
          if (updates.theme) {
            setMode(updates.theme);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // Version conflict - refresh and retry
          await fetchSettings();
          throw new Error('Settings were updated elsewhere. Please try again.');
        }
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [settings, setMode, fetchSettings, isMounted],
  );

  const updateTheme = useCallback(
    async (theme: 'light' | 'dark' | 'system') => {
      await updateSettings({ theme });
    },
    [updateSettings],
  );

  const updateProfile = useCallback(
    async (profile: UserSettings['profile']) => {
      await updateSettings({ profile });
    },
    [updateSettings],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    updateTheme,
    updateProfile,
    refresh: fetchSettings,
  };
}
