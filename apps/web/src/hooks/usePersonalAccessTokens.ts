import { useState, useCallback, useEffect } from 'react';
import type { PersonalAccessToken, PatCreatedResponse, PatDurationUnit } from '../types';
import {
  getPersonalAccessTokens as fetchTokensApi,
  createPersonalAccessToken as createTokenApi,
  revokePersonalAccessToken as revokeTokenApi,
} from '../services/api';

interface UsePersonalAccessTokensResult {
  tokens: PersonalAccessToken[];
  isLoading: boolean;
  error: string | null;
  fetchTokens: () => Promise<void>;
  createToken: (data: {
    name: string;
    durationValue: number;
    durationUnit: PatDurationUnit;
  }) => Promise<PatCreatedResponse>;
  revokeToken: (id: string) => Promise<void>;
}

export function usePersonalAccessTokens(): UsePersonalAccessTokensResult {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchTokensApi();
      setTokens(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch tokens';
      setError(message);
      setTokens([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createToken = useCallback(
    async (data: {
      name: string;
      durationValue: number;
      durationUnit: PatDurationUnit;
    }): Promise<PatCreatedResponse> => {
      setError(null);
      try {
        const response = await createTokenApi(data);
        // Refresh the list
        await fetchTokens();
        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create token';
        setError(message);
        throw err;
      }
    },
    [fetchTokens],
  );

  const revokeToken = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await revokeTokenApi(id);
        // Refresh the list
        await fetchTokens();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to revoke token';
        setError(message);
        throw err;
      }
    },
    [fetchTokens],
  );

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  return {
    tokens,
    isLoading,
    error,
    fetchTokens,
    createToken,
    revokeToken,
  };
}
