import { useState, useCallback, useEffect, useRef } from 'react';
import {
  triggerMigration,
  listMigrationRuns,
  getMigrationRun,
  cancelMigration,
} from '../services/storage-providers';
import type { MigrationRun, MigrationStatus } from '../services/storage-providers';

const POLL_INTERVAL_MS = 5000;

const TERMINAL_STATUSES: MigrationStatus[] = ['completed', 'failed', 'cancelled'];

function isTerminal(status: MigrationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function useStorageMigration() {
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  // The run that is currently active (pending/running) and being polled
  const [activeRun, setActiveRun] = useState<MigrationRun | null>(null);
  const [starting, setStarting] = useState(false);

  // Keep ref to activeRun.id so interval callback is stable
  const activeRunIdRef = useRef<string | null>(null);
  activeRunIdRef.current = activeRun?.id ?? null;

  const fetchRuns = useCallback(async () => {
    try {
      const data = await listMigrationRuns();
      setRuns(data.items);
      setRunsError(null);
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'Failed to load migration runs');
    }
  }, []);

  const refresh = useCallback(async () => {
    setRunsLoading(true);
    try {
      await fetchRuns();
    } finally {
      setRunsLoading(false);
    }
  }, [fetchRuns]);

  // Silent background poll for active run status
  const silentPollActiveRun = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    try {
      const updated = await getMigrationRun(runId);
      setActiveRun(updated);
      // Also refresh the runs list so history stays up to date
      await fetchRuns();
      // If terminal, clear active run
      if (isTerminal(updated.status)) {
        setActiveRun(null);
      }
    } catch {
      // ignore poll errors
    }
  }, [fetchRuns]);

  // Initial load
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling interval — only active while there is an in-flight run
  useEffect(() => {
    if (!activeRun) return;
    if (isTerminal(activeRun.status)) {
      setActiveRun(null);
      return;
    }

    const id = setInterval(() => {
      void silentPollActiveRun();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [activeRun, silentPollActiveRun]);

  const startMigration = useCallback(
    async (sourceProvider: string, targetProvider: string): Promise<void> => {
      setStarting(true);
      try {
        const result = await triggerMigration({ sourceProvider, targetProvider });
        // Immediately fetch the full run object so we have status/counts
        const run = await getMigrationRun(result.runId);
        setActiveRun(run);
        await fetchRuns();
      } finally {
        setStarting(false);
      }
    },
    [fetchRuns],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (!activeRun) return;
    try {
      const updated = await cancelMigration(activeRun.id);
      setActiveRun(updated);
      await fetchRuns();
    } catch (err) {
      throw err;
    }
  }, [activeRun, fetchRuns]);

  return {
    runs,
    runsLoading,
    runsError,
    activeRun,
    starting,
    refresh,
    startMigration,
    cancel,
  };
}
