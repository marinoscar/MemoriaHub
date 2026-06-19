import { useState, useCallback } from 'react';
import {
  getAiSettings,
  putAiCredentials,
  deleteAiCredentials,
  testAiProvider,
  getAiModels,
  putAiSearchFeature,
  putAiTaggingFeature,
} from '../services/ai';
import type { AiSettingsResponse, AiTestResult } from '../services/ai';

export function useAiSettings() {
  const [settings, setSettings] = useState<AiSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAiSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveCredentials = useCallback(
    async (
      provider: string,
      body: { apiKey: string; baseUrl?: string; enabled?: boolean },
    ) => {
      await putAiCredentials(provider, body);
    },
    [],
  );

  const removeCredentials = useCallback(async (provider: string) => {
    await deleteAiCredentials(provider);
  }, []);

  const testProvider = useCallback(
    async (provider: string, model: string): Promise<AiTestResult> => {
      return testAiProvider({ provider, model });
    },
    [],
  );

  const getModels = useCallback(async (provider: string): Promise<string[]> => {
    return getAiModels(provider);
  }, []);

  const saveSearchFeature = useCallback(
    async (provider: string, model: string) => {
      await putAiSearchFeature({ provider, model });
    },
    [],
  );

  const saveTaggingFeature = useCallback(
    async (provider: string, model: string) => {
      await putAiTaggingFeature({ provider, model });
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
    saveSearchFeature,
    saveTaggingFeature,
  };
}
