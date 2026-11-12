import { useState, useCallback } from 'react';
import {
  getGeoSettings,
  putGeoCredentials,
  deleteGeoCredentials,
  testGeoProvider,
  putGeoReverseFeature,
} from '../services/geo.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { GeoSettingsResponse, GeoTestResult, GeoReverseProvider } from '../services/geo.js';

/**
 * Loads and edits the geo provider settings (admin only).
 *
 * @returns the settings, the loading and error state and the load, save, remove, test and choose-provider actions
 * @stability experimental
 */
export function useGeoSettings() {
  const [settings, setSettings] = useState<GeoSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGeoSettings();
      if (!isMounted()) return;
      setSettings(data);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load geo settings');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted]);

  const saveCredentials = useCallback(
    async (
      provider: string,
      body: { apiKey: string; baseUrl?: string; enabled?: boolean },
    ) => {
      await putGeoCredentials(provider, body);
    },
    [],
  );

  const removeCredentials = useCallback(async (provider: string) => {
    await deleteGeoCredentials(provider);
  }, []);

  const testProvider = useCallback(
    async (
      provider: GeoReverseProvider,
      opts?: { lat?: number; lng?: number },
    ): Promise<GeoTestResult> => {
      return testGeoProvider({ provider, ...opts });
    },
    [],
  );

  const saveReverseFeature = useCallback(async (provider: GeoReverseProvider) => {
    await putGeoReverseFeature({ provider });
  }, []);

  return {
    /** The settings document, `null` until loaded. */
    settings,
    /** True while a load is in flight. */
    loading,
    /** The failure message, `null` when none. */
    error,
    /** Reloads the settings. */
    fetchSettings,
    /** Stores a provider credential and reloads. */
    saveCredentials,
    /** Removes a provider credential and reloads. */
    removeCredentials,
    /** Tests a provider's connectivity. */
    testProvider,
    /** Chooses the active reverse provider and reloads. */
    saveReverseFeature,
  };
}
