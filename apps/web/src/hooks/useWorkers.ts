import { useState, useCallback, useEffect } from 'react';
import {
  getWorkers,
  deleteWorker as deleteWorkerService,
} from '../services/workers';
import type { WorkerNodeDto } from '../services/workers';

const POLL_INTERVAL_MS = 5000;

interface UseWorkersOptions {
  autoRefresh?: boolean;
}

export interface UseWorkersResult {
  nodes: WorkerNodeDto[];
  loading: boolean;
  error: string | null;

  autoRefresh: boolean;
  setAutoRefresh: (enabled: boolean) => void;

  refresh: () => Promise<void>;
  deleteWorker: (id: string) => Promise<void>;
}

export function useWorkers(options: UseWorkersOptions = {}): UseWorkersResult {
  const [nodes, setNodes] = useState<WorkerNodeDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(options.autoRefresh ?? true);

  // Silent fetch (no loading spinner) — used by the polling interval.
  const fetchNodes = useCallback(async () => {
    try {
      const data = await getWorkers();
      setNodes(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load worker nodes');
    }
  }, []);

  // Explicit refresh with a loading indicator.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetchNodes();
    } finally {
      setLoading(false);
    }
  }, [fetchNodes]);

  // Initial load.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh polling.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void fetchNodes();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, fetchNodes]);

  const deleteWorker = useCallback(
    async (id: string) => {
      await deleteWorkerService(id);
      await fetchNodes();
    },
    [fetchNodes],
  );

  return {
    nodes,
    loading,
    error,
    autoRefresh,
    setAutoRefresh,
    refresh,
    deleteWorker,
  };
}

export type { WorkerNodeDto };
