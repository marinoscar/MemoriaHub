import { useState, useCallback } from 'react';
import {
  getGeoSettings,
  putGeoCredentials,
  deleteGeoCredentials,
  testGeoProvider,
  putGeoReverseFeature,
} from '../services/geo';
import type { GeoSettingsResponse, GeoTestResult, GeoReverseProvider } from '../services/geo';

export function useGeoSettings() {
  const [settings, setSettings] = useState<GeoSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGeoSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load geo settings');
    } finally {
      setLoading(false);
    }
  }, []);

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
    settings,
    loading,
    error,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    saveReverseFeature,
  };
}
