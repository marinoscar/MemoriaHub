import { useState, useCallback } from 'react';
import {
  getStorageSettings,
  putStorageCredentials,
  deleteStorageCredentials,
  testStorageProvider,
  setActiveStorageProvider,
} from '../services/storage-providers';
import { useIsMounted } from './useIsMounted';
import type {
  StorageSettingsResponse,
  StorageTestResult,
  StorageProviderRow,
} from '../services/storage-providers';

export function useStorageProviders() {
  const [settings, setSettings] = useState<StorageSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-provider test state
  const [testResults, setTestResults] = useState<Record<string, StorageTestResult | null>>({});
  const [testLoading, setTestLoading] = useState<Record<string, boolean>>({});
  const isMounted = useIsMounted();

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getStorageSettings();
      if (!isMounted()) return;
      setSettings(data);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load storage settings');
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted]);

  const saveCredentials = useCallback(
    async (
      provider: string,
      body: {
        accessKeyId?: string;
        secretAccessKey?: string;
        bucket?: string;
        region?: string;
        endpoint?: string;
        enabled?: boolean;
      },
    ): Promise<StorageProviderRow> => {
      return putStorageCredentials(provider, body);
    },
    [],
  );

  const removeCredentials = useCallback(async (provider: string): Promise<void> => {
    await deleteStorageCredentials(provider);
  }, []);

  const testProvider = useCallback(
    async (
      provider: string,
      overrides?: {
        accessKeyId?: string;
        secretAccessKey?: string;
        bucket?: string;
        region?: string;
        endpoint?: string;
      },
    ): Promise<StorageTestResult> => {
      setTestLoading((prev) => ({ ...prev, [provider]: true }));
      setTestResults((prev) => ({ ...prev, [provider]: null }));
      try {
        const result = await testStorageProvider({ provider, ...overrides });
        if (isMounted()) setTestResults((prev) => ({ ...prev, [provider]: result }));
        return result;
      } catch (err) {
        const result: StorageTestResult = {
          ok: false,
          error: err instanceof Error ? err.message : 'Test failed',
        };
        if (isMounted()) setTestResults((prev) => ({ ...prev, [provider]: result }));
        return result;
      } finally {
        if (isMounted()) setTestLoading((prev) => ({ ...prev, [provider]: false }));
      }
    },
    [isMounted],
  );

  const setActive = useCallback(
    async (provider: string): Promise<{ activeProvider: string }> => {
      return setActiveStorageProvider(provider);
    },
    [],
  );

  return {
    settings,
    loading,
    error,
    testResults,
    testLoading,
    fetchSettings,
    saveCredentials,
    removeCredentials,
    testProvider,
    setActive,
  };
}
