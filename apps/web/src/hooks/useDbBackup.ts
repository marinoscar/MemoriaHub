import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  cancelDbBackupRun,
  deleteDbBackupRun,
  getDbBackupConfig,
  getDbBackupDownloadUrl,
  getDbBackupRun,
  listDbBackupRuns,
  startDbBackupRun,
  updateDbBackupConfig,
} from '../services/dbBackup';
import type {
  DbBackupConfig,
  DbBackupConfigResponse,
  DbBackupRunDto,
  UpdateDbBackupConfigDto,
} from '../services/dbBackup';
import { useIsMounted } from './useIsMounted';

/**
 * Admin → Database Backup state (issue #345, epic #339).
 *
 * Shaped after `useNodeBackup` (useState/useCallback + `useIsMounted()` guard,
 * silent poll vs. spinner-refresh split), with two deliberate divergences:
 *
 *  1. **5s poll, matching `useJobs`, not `useNodeBackup`'s 15s.** A dump is a
 *     single long operation whose only sign of life is a rising byte count and
 *     a heartbeat; at 15s an admin watching a 40-minute run sees a number that
 *     looks frozen. The poll is only paid while a run is actually active.
 *  2. **The 409 refetches the config for `activeRunId`.** The API returns
 *     `{ message, activeRunId }` on a concurrent start, but the app-wide
 *     `HttpExceptionFilter` rebuilds the error body from `message`/`code`/
 *     `details` only — `activeRunId` never reaches the browser. Rather than
 *     show a dead-end "already running" string, a 409 triggers one
 *     `GET /config`, whose `activeRunId` is authoritative for exactly the same
 *     single-active-run slot the 409 was reporting.
 */

/** Progress poll cadence while a run is active. Matches `useJobs`. */
export const DB_BACKUP_POLL_INTERVAL_MS = 5000;

export interface UseDbBackupResult {
  config: DbBackupConfig | null;
  /** Server-computed next fire time (ISO 8601); null when disabled. */
  nextRunAt: string | null;
  /** Run currently holding the single-active-run slot, if any. */
  activeRunId: string | null;
  /** Detail of the active run, refreshed every 5s while one is in flight. */
  activeRun: DbBackupRunDto | null;
  /** True once the first config fetch resolved. */
  configLoaded: boolean;

  runs: DbBackupRunDto[];
  total: number;
  page: number;
  pageSize: number;

  loading: boolean;
  saving: boolean;
  starting: boolean;
  error: string | null;
  /** Set when a start attempt lost the single-active-run race (HTTP 409). */
  conflictRunId: string | null;

  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  refresh: () => Promise<void>;
  saveConfig: (dto: UpdateDbBackupConfigDto) => Promise<DbBackupConfigResponse>;
  startRun: () => Promise<void>;
  cancelRun: (id: string) => Promise<void>;
  deleteRun: (id: string) => Promise<void>;
  downloadRun: (id: string) => Promise<string>;
  clearConflict: () => void;
}

export function useDbBackup(): UseDbBackupResult {
  const [config, setConfig] = useState<DbBackupConfig | null>(null);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<DbBackupRunDto | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  const [runs, setRuns] = useState<DbBackupRunDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(20);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictRunId, setConflictRunId] = useState<string | null>(null);

  const isMounted = useIsMounted();

  // Kept in a ref so the polling effect can read the latest paging without
  // being torn down and rebuilt (and thus resetting its interval) on a change.
  const pagingRef = useRef({ page, pageSize });
  pagingRef.current = { page, pageSize };

  /** Silent fetch of config + the current history page. No spinner. */
  const fetchAll = useCallback(async () => {
    try {
      const { page: p, pageSize: ps } = pagingRef.current;
      const [configResp, runsResp] = await Promise.all([
        getDbBackupConfig(),
        listDbBackupRuns({ page: p, pageSize: ps }),
      ]);
      if (!isMounted()) return;
      setConfig(configResp.config);
      setNextRunAt(configResp.nextRunAt);
      setActiveRunId(configResp.activeRunId);
      setConfigLoaded(true);
      setRuns(runsResp.items);
      setTotal(runsResp.meta.totalItems);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(
        err instanceof Error ? err.message : 'Failed to load database backup status',
      );
    }
  }, [isMounted]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetchAll();
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [fetchAll, isMounted]);

  // Initial load + reload on paging change.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  /**
   * Live progress poll — ONLY while a run holds the active slot.
   *
   * `GET /runs/:id` is the cheap detail read; `fetchAll` runs alongside it so
   * that the moment the run terminates, `activeRunId` goes null (stopping this
   * effect) and the finished row appears in history without a manual refresh.
   */
  useEffect(() => {
    if (!activeRunId) {
      setActiveRun(null);
      return;
    }

    let cancelled = false;
    const tick = async () => {
      try {
        const run = await getDbBackupRun(activeRunId);
        if (cancelled || !isMounted()) return;
        setActiveRun(run);
        // Terminal → resync config/history so the row lands in the table.
        if (run.status !== 'pending' && run.status !== 'running') {
          void fetchAll();
        }
      } catch {
        // A poll failure is transient by nature (the run may have just been
        // deleted, or the request raced a reload); the next tick recovers.
      }
    };

    void tick();
    const id = setInterval(() => void tick(), DB_BACKUP_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeRunId, fetchAll, isMounted]);

  const setPage = useCallback((next: number) => setPageState(next), []);
  const setPageSize = useCallback((next: number) => {
    setPageSizeState(next);
    setPageState(1);
  }, []);

  const saveConfig = useCallback(
    async (dto: UpdateDbBackupConfigDto) => {
      setSaving(true);
      try {
        const resp = await updateDbBackupConfig(dto);
        if (isMounted()) {
          setConfig(resp.config);
          setNextRunAt(resp.nextRunAt);
          setActiveRunId(resp.activeRunId);
          setConfigLoaded(true);
          setError(null);
        }
        return resp;
      } finally {
        if (isMounted()) setSaving(false);
      }
    },
    [isMounted],
  );

  const startRun = useCallback(async () => {
    setStarting(true);
    setConflictRunId(null);
    try {
      const { runId } = await startDbBackupRun();
      if (!isMounted()) return;
      setActiveRunId(runId);
      setError(null);
      void fetchAll();
    } catch (err) {
      if (!isMounted()) return;
      if (err instanceof ApiError && err.status === 409) {
        // See the header note: the filter strips `activeRunId` from the 409
        // body, so the id comes from the config read instead.
        try {
          const resp = await getDbBackupConfig();
          if (!isMounted()) return;
          setActiveRunId(resp.activeRunId);
          setConflictRunId(resp.activeRunId);
        } catch {
          setConflictRunId(null);
        }
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to start backup');
    } finally {
      if (isMounted()) setStarting(false);
    }
  }, [fetchAll, isMounted]);

  const cancelRun = useCallback(
    async (id: string) => {
      await cancelDbBackupRun(id);
      await fetchAll();
    },
    [fetchAll],
  );

  const deleteRun = useCallback(
    async (id: string) => {
      await deleteDbBackupRun(id);
      await fetchAll();
    },
    [fetchAll],
  );

  /** Resolve a signed URL; the caller decides how to open it. */
  const downloadRun = useCallback(async (id: string) => {
    const { url } = await getDbBackupDownloadUrl(id);
    return url;
  }, []);

  const clearConflict = useCallback(() => setConflictRunId(null), []);

  return {
    config,
    nextRunAt,
    activeRunId,
    activeRun,
    configLoaded,
    runs,
    total,
    page,
    pageSize,
    loading,
    saving,
    starting,
    error,
    conflictRunId,
    setPage,
    setPageSize,
    refresh,
    saveConfig,
    startRun,
    cancelRun,
    deleteRun,
    downloadRun,
    clearConflict,
  };
}
