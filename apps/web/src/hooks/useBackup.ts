import { useState, useCallback } from 'react';
import {
  triggerBackup as triggerBackupService,
  listBackupRuns,
} from '../services/backup';
import type { BackupRun, BackupRunRequest, BackupRunResult } from '../services/backup';

export function useBackup() {
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<BackupRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const data = await listBackupRuns();
      setRuns(data);
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'Failed to load backup runs');
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const triggerBackup = useCallback(
    async (dto: BackupRunRequest): Promise<BackupRunResult> => {
      setRunning(true);
      setRunResult(null);
      setRunError(null);
      try {
        const result = await triggerBackupService(dto);
        setRunResult(result);
        await refreshRuns();
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Backup failed';
        setRunError(message);
        throw err;
      } finally {
        setRunning(false);
      }
    },
    [refreshRuns],
  );

  return {
    runs,
    runsLoading,
    runsError,
    running,
    runResult,
    runError,
    triggerBackup,
    refreshRuns,
  };
}
