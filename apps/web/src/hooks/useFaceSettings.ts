import { useState, useCallback } from 'react';
import {
  getFaceSettings,
  putFaceCredentials,
  deleteFaceCredentials,
  testFaceProvider,
  getFaceModels,
  putFaceDetectionFeature,
} from '../services/face';
import type { FaceSettingsResponse, FaceTestResult } from '../services/face';

export function useFaceSettings() {
  const [settings, setSettings] = useState<FaceSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getFaceSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load face settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveCredentials = useCallback(
    async (
      provider: string,
      body: { apiKey?: string; baseUrl?: string; region?: string; enabled?: boolean },
    ) => {
      await putFaceCredentials(provider, body);
    },
    [],
  );

  const removeCredentials = useCallback(async (provider: string) => {
    await deleteFaceCredentials(provider);
  }, []);

  const testProvider = useCallback(
    async (provider: string, model?: string): Promise<FaceTestResult> => {
      return testFaceProvider({ provider, ...(model ? { model } : {}) });
    },
    [],
  );

  const getModels = useCallback(async (provider: string): Promise<string[]> => {
    return getFaceModels(provider);
  }, []);

  const saveDetectionFeature = useCallback(
    async (provider: string, model: string) => {
      await putFaceDetectionFeature({ provider, model });
    },
    [],
  );

  return {
    settings,
    loading,
    error,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    getModels,
    saveDetectionFeature,
  };
}
