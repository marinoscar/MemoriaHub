import { useState, useCallback, useEffect } from 'react';
import {
  getNodeBackupConfig,
  getNodeBackupRuns,
  updateNodeBackupConfig,
} from '../services/nodeBackup';
import type {
  NodeBackupConfigDto,
  NodeBackupRunDto,
  UpdateNodeBackupConfigDto,
} from '../services/nodeBackup';
import { useIsMounted } from './useIsMounted';

/**
 * Poll interval for the backup status/runs while the page is mounted.
 * Backup runs progress on the order of minutes, so 15s (vs. useWorkers' 5s)
 * is plenty and keeps the two per-node requests cheap.
 */
const POLL_INTERVAL_MS = 15000;

interface UseNodeBackupOptions {
  autoRefresh?: boolean;
}

export interface UseNodeBackupResult {
  /** null = backup never configured for this node (or not yet loaded). */
  config: NodeBackupConfigDto | null;
  /** True once the first config fetch has resolved (distinguishes "loading" from "unconfigured"). */
  configLoaded: boolean;
  runs: NodeBackupRunDto[];
  loading: boolean;
  saving: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  /**
   * PUT the config. Returns the server's post-save config (GET shape) and
   * stores it, so `nextRunAt` renders immediately from the PUT response.
   * Rethrows on failure so the caller can surface the server's 400 message
   * (invalid cron / timezone / circleIds) inline.
   */
  saveConfig: (dto: UpdateNodeBackupConfigDto) => Promise<NodeBackupConfigDto | null>;
}

/**
 * Config + run history for one worker node's backup, with a 15s silent poll
 * while mounted (silent-refresh vs. spinner pattern copied from useWorkers).
 */
export function useNodeBackup(
  nodeId: string | undefined,
  options: UseNodeBackupOptions = {},
): UseNodeBackupResult {
  const autoRefresh = options.autoRefresh ?? true;
  const [config, setConfig] = useState<NodeBackupConfigDto | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [runs, setRuns] = useState<NodeBackupRunDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  // Silent fetch (no loading spinner) — used by the polling interval.
  const fetchAll = useCallback(async () => {
    if (!nodeId) return;
    try {
      const [configResp, runsResp] = await Promise.all([
        getNodeBackupConfig(nodeId),
        getNodeBackupRuns(nodeId, 20),
      ]);
      if (!isMounted()) return;
      setConfig(configResp.config);
      setConfigLoaded(true);
      setRuns(runsResp.runs);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(err instanceof Error ? err.message : 'Failed to load backup status');
    }
  }, [nodeId, isMounted]);

  // Explicit refresh with a loading indicator.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetchAll();
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [fetchAll, isMounted]);

  // Initial load.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // Auto-refresh polling (silent — no spinner, table stays mounted).
  useEffect(() => {
    if (!autoRefresh || !nodeId) return;
    const id = setInterval(() => {
      void fetchAll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, nodeId, fetchAll]);

  const saveConfig = useCallback(
    async (dto: UpdateNodeBackupConfigDto) => {
      if (!nodeId) return null;
      setSaving(true);
      try {
        const resp = await updateNodeBackupConfig(nodeId, dto);
        if (isMounted()) {
          setConfig(resp.config);
          setConfigLoaded(true);
          setError(null);
        }
        return resp.config;
      } finally {
        if (isMounted()) setSaving(false);
      }
    },
    [nodeId, isMounted],
  );

  return { config, configLoaded, runs, loading, saving, error, refresh, saveConfig };
}
