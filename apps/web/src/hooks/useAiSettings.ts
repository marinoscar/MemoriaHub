import { useState, useCallback } from 'react';
import {
  getAiSettings,
  putAiCredentials,
  deleteAiCredentials,
  testAiProvider,
  getAiModels,
  putAiSearchFeature,
  putAiTaggingFeature,
  putAiEmbeddingFeature,
  getAiEmbeddingModels,
  testAiEmbedding,
  putAiEnhanceFeature,
  putAiMemoriesFeature,
  getAiImageModels,
} from '../services/ai';
import { useIsMounted } from './useIsMounted';
import type { AiSettingsResponse, AiTestResult, AiEmbeddingTestResult } from '../services/ai';

export function useAiSettings() {
  const [settings, setSettings] = useState<AiSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAiSettings();
      if (!isMounted()) return;
      setSettings(data);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load AI settings');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted]);

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

  const saveEmbeddingFeature = useCallback(
    async (provider: string | null, model: string | null) => {
      await putAiEmbeddingFeature({ provider, model });
    },
    [],
  );

  const getEmbeddingModels = useCallback(async (provider: string): Promise<string[]> => {
    return getAiEmbeddingModels(provider);
  }, []);

  const testEmbedding = useCallback(
    async (provider?: string, model?: string): Promise<AiEmbeddingTestResult> => {
      return testAiEmbedding({ provider, model });
    },
    [],
  );

  const saveEnhanceFeature = useCallback(
    async (provider: string, model: string) => {
      await putAiEnhanceFeature({ provider, model });
    },
    [],
  );

  const getImageModels = useCallback(async (provider: string): Promise<string[]> => {
    return getAiImageModels(provider);
  }, []);

  /**
   * Memories title/subtitle/narrative model (epic #300). Nulls clear the
   * selection, which drops memories back to deterministic template titles.
   */
  const saveMemoriesFeature = useCallback(
    async (provider: string | null, model: string | null) => {
      await putAiMemoriesFeature({ provider, model });
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
    saveEmbeddingFeature,
    getEmbeddingModels,
    testEmbedding,
    saveEnhanceFeature,
    getImageModels,
    saveMemoriesFeature,
  };
}
