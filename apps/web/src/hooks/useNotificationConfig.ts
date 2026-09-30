/**
 * This deployment's client-facing notification capabilities —
 * `GET /api/notifications/config` (issue #486, epic #481; ported from
 * EnterpriseAppBase).
 *
 * A plain fetch hook: fetch on mount, loading/error/data, no cache across
 * mounts. The config is small and per-deployment.
 *
 * `config` IS `null` UNTIL THE FIRST READ RESOLVES, and a caller must treat
 * that as "not known yet", NEVER as "disabled": `!config?.browserEnabled` would
 * read `true` during the loading window and flicker the admin-disabled state in
 * on every load. The correct reads are `config?.browserEnabled === false` and
 * `config?.pushEnabled === true`.
 */

import { useCallback, useEffect, useState } from 'react';
import { getNotificationConfig } from '../services/notifications';
import type { NotificationClientConfig } from '../types/notifications';
import { useIsMounted } from './useIsMounted';

export interface UseNotificationConfigResult {
  /** `null` until the first read resolves — see the file header. */
  config: NotificationClientConfig | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useNotificationConfig(): UseNotificationConfigResult {
  const [config, setConfig] = useState<NotificationClientConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getNotificationConfig();
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) {
        setError(err instanceof Error ? err.message : 'Failed to load notification config');
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  return { config, isLoading, error, refresh: fetchConfig };
}
