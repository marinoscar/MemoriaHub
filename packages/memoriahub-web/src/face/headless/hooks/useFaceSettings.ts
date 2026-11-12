import { useState, useCallback } from 'react';
import {
  getFaceSettings,
  putFaceCredentials,
  deleteFaceCredentials,
  testFaceProvider,
  getFaceModels,
  putFaceDetectionFeature,
} from '../services/faceSettings.js';
import { useIsMounted } from '../../../core/headless/index.js';
import type { FaceSettingsResponse, FaceTestResult } from '../services/faceSettings.js';

/**
 * The state and actions {@link useFaceSettings} returns.
 *
 * @stability experimental
 */
export interface UseFaceSettingsResult {
  /** The settings, `null` until the first load. */
  settings: FaceSettingsResponse | null;
  /** True while the settings load. */
  loading: boolean;
  /** The load failure message, `null` when none. */
  error: string | null;
  /** Loads (or reloads) the settings. */
  fetchSettings: () => Promise<void>;
  /** Saves a provider's credentials. */
  saveCredentials: (
    provider: string,
    body: { apiKey?: string; baseUrl?: string; region?: string; enabled?: boolean },
  ) => Promise<void>;
  /** Removes a provider's credentials. */
  removeCredentials: (provider: string) => Promise<void>;
  /** Tests a provider (and optionally a model). */
  testProvider: (provider: string, model?: string) => Promise<FaceTestResult>;
  /** Lists a provider's models. */
  getModels: (provider: string) => Promise<string[]>;
  /** Selects the detection provider and model. */
  saveDetectionFeature: (provider: string, model: string) => Promise<void>;
}

/**
 * Loads the face settings and exposes the provider mutations the Face Settings page calls.
 *
 * @stability experimental
 */
export function useFaceSettings(): UseFaceSettingsResult {
  const [settings, setSettings] = useState<FaceSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getFaceSettings();
      if (!isMounted()) return;
      setSettings(data);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load face settings');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted]);

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
