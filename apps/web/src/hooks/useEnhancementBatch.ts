import { useState, useCallback } from 'react';
import type { EnhancementBatch } from '../services/enhance';
import { getEnhancementBatch as getEnhancementBatchApi } from '../services/enhance';
import { useIsMounted } from './useIsMounted';

interface UseEnhancementBatchResult {
  batch: EnhancementBatch | null;
  isLoading: boolean;
  error: string | null;
  fetchBatch: (batchId: string) => Promise<void>;
}

/**
 * Fetch a single bulk-enhance batch's progress (epic #420, issue #423).
 *
 * Shaped exactly like `useTrashEmptyRun` — and deliberately so: the batch
 * payload is BaseRun-shaped, so the caller pairs this with the shared
 * `useRunPolling` for live progress and `RunProgressPanel` for the rendering.
 * Because the API reports a real terminal `RunStatus`, polling stops itself;
 * there is no bespoke termination logic here or in the page.
 */
export function useEnhancementBatch(): UseEnhancementBatchResult {
  const [batch, setBatch] = useState<EnhancementBatch | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchBatch = useCallback(async (batchId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getEnhancementBatchApi(batchId);
      if (!isMounted()) return;
      setBatch(response);
    } catch (err) {
      if (!isMounted()) return;
      const message =
        err instanceof Error ? err.message : 'Failed to fetch the enhancement batch';
      setError(message);
      setBatch(null);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  return { batch, isLoading, error, fetchBatch };
}
