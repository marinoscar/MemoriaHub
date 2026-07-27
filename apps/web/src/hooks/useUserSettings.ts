import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { UserSettings } from '../types';
import { useThemeContext } from '../contexts/ThemeContext';
import { useIsMounted } from './useIsMounted';

interface UseUserSettingsReturn {
  settings: UserSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;
  updateTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>;
  updateProfile: (profile: UserSettings['profile']) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useUserSettings(): UseUserSettingsReturn {
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
      // Sync theme with settings
      setMode(data.theme);
    } catch (err) {
      if (!isMounted()) return;
      const message = err instanceof ApiError ? err.message : 'Failed to load settings';
      setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [setMode, isMounted]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: Partial<UserSettings>) => {
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

          // Sync theme if changed
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
