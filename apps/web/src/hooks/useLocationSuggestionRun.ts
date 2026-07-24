import { useState, useCallback } from 'react';
import type { LocationSuggestionRunDetail } from '../types/locationSuggestionRuns';
import { getLocationSuggestionRun as getLocationSuggestionRunApi } from '../services/locationSuggestionRuns';

interface UseLocationSuggestionRunResult {
  run: LocationSuggestionRunDetail | null;
  isLoading: boolean;
  error: string | null;
  fetchRun: (runId: string) => Promise<void>;
}

/**
 * Fetch a single location-suggestion run's detail. The caller can poll live
 * progress by invoking `fetchRun` on an interval (mirrors `useTrashEmptyRun`).
 */
export function useLocationSuggestionRun(): UseLocationSuggestionRunResult {
  const [run, setRun] = useState<LocationSuggestionRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRun = useCallback(async (runId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getLocationSuggestionRunApi(runId);
      setRun(response);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch location-suggestion run';
      setError(message);
      setRun(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { run, isLoading, error, fetchRun };
}
