import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { SystemSettings } from '../types';

interface UseSystemSettingsReturn {
  settings: SystemSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: Partial<SystemSettings>) => Promise<void>;
  replaceSettings: (settings: Omit<SystemSettings, 'updatedAt' | 'updatedBy' | 'version'>) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSystemSettings(): UseSystemSettingsReturn {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<SystemSettings>('/system-settings');
      setSettings(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('You do not have permission to view system settings');
      } else {
        const message = err instanceof ApiError ? err.message : 'Failed to load settings';
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: Partial<SystemSettings>) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<SystemSettings>('/system-settings', updates, {
          headers: {
            'If-Match': settings.version.toString(),
          },
        });

        setSettings(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await fetchSettings();
          throw new Error('Settings were updated elsewhere. Please review and try again.');
        }
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [settings, fetchSettings],
  );

  const replaceSettings = useCallback(
    async (newSettings: Omit<SystemSettings, 'updatedAt' | 'updatedBy' | 'version'>) => {
      try {
        setIsSaving(true);
        setError(null);

        const data = await api.put<SystemSettings>('/system-settings', newSettings);
        setSettings(data);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    replaceSettings,
    refresh: fetchSettings,
  };
}
