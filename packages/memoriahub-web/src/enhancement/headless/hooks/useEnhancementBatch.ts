import { useState, useCallback } from 'react';
import type { EnhancementBatch } from '../services/enhance.js';
import { getEnhancementBatch as getEnhancementBatchApi } from '../services/enhance.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * The state and loader {@link useEnhancementBatch} returns.
 *
 * @stability experimental
 */
export interface UseEnhancementBatchResult {
  batch: EnhancementBatch | null;
  isLoading: boolean;
  error: string | null;
  /** Loads (or reloads) the batch; poll it with `useRunPolling`. */
  fetchBatch: (batchId: string) => Promise<void>;
}

/**
 * Fetch a single bulk-enhancement batch's progress payload (epic #420, #423).
 *
 * Shaped exactly like `useTrashEmptyRun` — and for the same reason: the batch
 * endpoint serializes the shared `BaseRun` field set, so the caller pairs this
 * with `useRunPolling` + `RunProgressPanel` and no batch-specific progress
 * machinery exists anywhere.
 *
 * @stability experimental
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
