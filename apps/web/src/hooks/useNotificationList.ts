/**
 * useNotificationList — the `/notifications` page's own paginated list (#250).
 *
 * WHY THIS IS NOT `useNotifications`
 * ----------------------------------
 * `useNotifications` (issue #249) is the module-level store behind the AppBar
 * bell and the sidebar badge. It holds exactly ONE page of at most
 * `NOTIFICATION_PANEL_PAGE_SIZE` rows and polls a single integer every 60s.
 * That is deliberately the wrong shape for a full inbox: this page needs
 * arbitrary pages, a `status` filter and an optional `circleId` filter.
 *
 * So the two coexist with a strict division of labour:
 *
 *   - the STORE owns the unread count and the mutations (so the badge stays
 *     correct no matter which surface fired the write) — and owns the ONLY
 *     polling timer in the app;
 *   - this hook owns the page's `items` + `meta`, fetched on demand.
 *
 * Nothing here polls. A page mutation calls the store's mutation (badge) and
 * then `reload()` here (rows) — one request each, on an actual user action.
 *
 * The fetch idiom is borrowed verbatim from `useEnhancements`: params are read
 * through a ref so an inline object literal from the caller cannot retrigger
 * the effect on every render — only a genuine VALUE change (via `paramsKey`)
 * does — and a SILENT reload never flashes the list into its skeleton under the
 * user's cursor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listNotifications } from '../services/notifications';
import { useIsMounted } from './useIsMounted';
import type {
  NotificationItem,
  NotificationListMeta,
  NotificationListParams,
} from '../types/notifications';

export interface UseNotificationListResult {
  items: NotificationItem[];
  meta: NotificationListMeta | null;
  isLoading: boolean;
  error: string | null;
  /** Re-fetch with a visible loading state (user-initiated refresh). */
  refresh: () => Promise<void>;
  /** Re-fetch silently — used after a mutation, so rows swap in place. */
  reload: () => Promise<void>;
}

/**
 * Fetch one page of notifications. Pass `null` to keep the hook inert.
 */
export function useNotificationList(
  params: NotificationListParams | null,
): UseNotificationListResult {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [meta, setMeta] = useState<NotificationListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramsKey = useMemo(() => (params ? JSON.stringify(params) : null), [params]);

  const isMounted = useIsMounted();

  const load = useCallback(
    async (silent: boolean) => {
      const current = paramsRef.current;
      if (!current) {
        setItems([]);
        setMeta(null);
        setError(null);
        return;
      }
      if (!silent) setIsLoading(true);
      try {
        const result = await listNotifications(current);
        if (!isMounted()) return;
        setItems(result.items ?? []);
        setMeta(result.meta ?? null);
        setError(null);
      } catch (err) {
        if (!isMounted()) return;
        setError(err instanceof Error ? err.message : 'Failed to load notifications');
      } finally {
        if (!silent && isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    void load(false);
  }, [paramsKey, load]);

  const refresh = useCallback(() => load(false), [load]);
  const reload = useCallback(() => load(true), [load]);

  return { items, meta, isLoading, error, refresh, reload };
}
