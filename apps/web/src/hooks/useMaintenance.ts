import { useCallback, useEffect, useState } from 'react';
import {
  getMaintenanceState,
  updateMaintenanceState,
} from '../services/maintenance';
import type {
  MaintenanceState,
  UpdateMaintenanceRequest,
} from '../services/maintenance';
import { useIsMounted } from './useIsMounted';
import { usePermissions } from './usePermissions';

/**
 * Admin view of maintenance mode (issue #348) — the PERSISTED state read from
 * `GET /api/admin/maintenance`, not the client-observed 503 detection in
 * `useMaintenanceMode()`.
 *
 * The distinction matters for the banner: with `allowAdmins: true` (the
 * default) an admin's own requests are never 503ed, so the detection store
 * stays empty for them. Only this hook can tell an admin "the site is down for
 * everyone else" — which is the whole point of the banner, since leaving
 * maintenance on by accident is this feature's most likely real failure.
 *
 * @param pollMs When > 0, re-fetch on this interval so a toggle made in
 *   another tab (or by another admin) reaches this one. 0 disables polling.
 */
export function useMaintenance(pollMs = 0) {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('system_settings:read');
  const canWrite = hasPermission('system_settings:write');

  const [state, setState] = useState<MaintenanceState | null>(null);
  const [isLoading, setIsLoading] = useState(canRead);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!canRead) {
      setIsLoading(false);
      return;
    }
    try {
      const data = await getMaintenanceState();
      if (!isMounted()) return;
      setState(data);
      setError(null);
    } catch (err) {
      if (!isMounted()) return;
      setError(
        err instanceof Error ? err.message : 'Failed to load maintenance state',
      );
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [canRead, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canRead || pollMs <= 0) return;
    const id = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [canRead, pollMs, refresh]);

  const save = useCallback(
    async (body: UpdateMaintenanceRequest): Promise<MaintenanceState> => {
      setIsSaving(true);
      setError(null);
      try {
        const next = await updateMaintenanceState(body);
        if (isMounted()) setState(next);
        return next;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update maintenance mode';
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return { state, isLoading, isSaving, error, canRead, canWrite, refresh, save };
}
