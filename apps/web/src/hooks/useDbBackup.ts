import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../services/api';
import {
  RESTORE_ACTIVE_STATUSES,
  cancelDbBackupRun,
  deleteDbBackupRun,
  getDbBackupConfig,
  getDbBackupDownloadUrl,
  getDbBackupRun,
  listDbBackupRuns,
  rollbackDbRestore,
  startDbBackupRun,
  startDbRestore,
  updateDbBackupConfig,
} from '../services/dbBackup';
import type {
  DbBackupConfig,
  DbBackupConfigResponse,
  DbBackupRunDto,
  DbRollbackResult,
  StartDbRestoreResult,
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

/**
 * Poll cadence while a RESTORE is in flight (#344).
 *
 * Faster than the backup poll on purpose. A restore's second phase — the
 * database rename plus `process.exit(0)` — lasts seconds, and it is the one
 * moment an admin most wants the UI to move: at 5s the "restarting" state could
 * be missed entirely and the swap would look like a hang.
 */
export const DB_RESTORE_POLL_INTERVAL_MS = 3000;

/**
 * How the restore poll is currently faring.
 *
 * `restarting` is the load-bearing value. During the swap the API deliberately
 * renames the live database and exits, so `GET /runs/:id` MUST fail — that is
 * the design working, not an outage. Painting it as an error would tell an
 * admin their restore broke at the exact moment it was succeeding.
 */
export type DbRestorePollState = 'idle' | 'polling' | 'restarting';

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

  /** Run whose restore is in flight, if any — polled every 3s. */
  restoringRun: DbBackupRunDto | null;
  /** See `DbRestorePollState`; `restarting` is the expected phase-2 state. */
  restorePollState: DbRestorePollState;

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

  /** #344 — starts polling only when the result is `mode:'running'`. */
  startRestore: (
    id: string,
    opts?: { overrideSchemaCheck?: boolean },
  ) => Promise<StartDbRestoreResult>;
  rollbackRestore: (id: string) => Promise<DbRollbackResult>;
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

  const [restoringRunId, setRestoringRunId] = useState<string | null>(null);
  const [restoringRun, setRestoringRun] = useState<DbBackupRunDto | null>(null);
  const [restorePollState, setRestorePollState] =
    useState<DbRestorePollState>('idle');

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

  /**
   * Adopt an in-flight restore found in history.
   *
   * A restore outlives the tab that started it by hours, and — because the swap
   * ends in `process.exit(0)` — it very often outlives the SESSION too. Picking
   * the row up from the list on load is what makes a reload (or a different
   * admin's browser) show live restore progress instead of a silent table.
   */
  useEffect(() => {
    if (restoringRunId) return;
    const active = runs.find(
      (r) => r.restoreStatus && RESTORE_ACTIVE_STATUSES.includes(r.restoreStatus),
    );
    if (active) {
      setRestoringRunId(active.id);
      setRestoringRun(active);
    }
  }, [runs, restoringRunId]);

  /**
   * Restore progress poll.
   *
   * The `catch` is the whole point. Phase 2 renames the live database out from
   * under the API and exits the process, so these requests are SUPPOSED to fail
   * for as long as the restart takes. A failure therefore sets `restarting` and
   * keeps polling; the next success clears it. Only a terminal `restoreStatus`
   * stops the loop.
   */
  useEffect(() => {
    if (!restoringRunId) {
      setRestoringRun(null);
      setRestorePollState('idle');
      return;
    }

    let cancelled = false;
    setRestorePollState('polling');

    const tick = async () => {
      try {
        const run = await getDbBackupRun(restoringRunId);
        if (cancelled || !isMounted()) return;
        setRestoringRun(run);
        setRestorePollState('polling');
        const status = run.restoreStatus;
        if (!status || !RESTORE_ACTIVE_STATUSES.includes(status)) {
          // Terminal (completed / failed) — stop polling and resync history so
          // the rollback affordance and its expiry appear without a manual
          // refresh.
          setRestoringRunId(null);
          setRestorePollState('idle');
          void fetchAll();
        }
      } catch {
        if (cancelled || !isMounted()) return;
        // Expected during the swap; see the block comment above.
        setRestorePollState('restarting');
      }
    };

    void tick();
    const id = setInterval(() => void tick(), DB_RESTORE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [restoringRunId, fetchAll, isMounted]);

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

  /**
   * Start (or probe) a restore.
   *
   * Polling begins ONLY on `mode:'running'`. `guided` and `blocked` created
   * nothing, so adopting them as an "in-flight restore" would show progress for
   * work that never began — the caller renders them as results instead.
   */
  const startRestore = useCallback(
    async (id: string, opts: { overrideSchemaCheck?: boolean } = {}) => {
      const result = await startDbRestore(id, opts);
      if (isMounted() && result.mode === 'running') {
        setRestoringRunId(id);
        setRestorePollState('polling');
      }
      void fetchAll();
      return result;
    },
    [fetchAll, isMounted],
  );

  /**
   * Roll a completed restore back.
   *
   * `renamed` also ends in `process.exit(0)`, so the very next poll is expected
   * to fail — the same `restarting` treatment applies, which is why this adopts
   * the run for polling exactly as `startRestore` does.
   */
  const rollbackRestore = useCallback(
    async (id: string) => {
      const result = await rollbackDbRestore(id);
      if (isMounted() && result.mode !== 'unavailable') {
        setRestoringRunId(result.mode === 'restore_started' ? result.runId : id);
        setRestorePollState(result.mode === 'renamed' ? 'restarting' : 'polling');
      }
      void fetchAll();
      return result;
    },
    [fetchAll, isMounted],
  );

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
    restoringRun,
    restorePollState,
    startRestore,
    rollbackRestore,
  };
}
