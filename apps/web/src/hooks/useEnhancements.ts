import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listEnhancements } from '../services/enhance';
import type {
  EnhancementListItem,
  EnhancementListMeta,
  ListEnhancementsParams,
} from '../services/enhance';

/**
 * Poll cadence for the enhancements hub. Deliberately slower than the
 * per-item drawer's 2s (`useMediaEnhance`): this is a background inbox a user
 * leaves open, not a modal they are actively staring at, and each tick is a
 * paginated query rather than a single-row read.
 */
export const ENHANCEMENTS_POLL_MS = 5000;

/** Statuses that mean the row is still moving and the page needs re-polling. */
const LIVE_STATUSES = ['pending', 'processing'] as const;

function isLive(item: EnhancementListItem): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(item.status);
}

export interface UseEnhancementsResult {
  items: EnhancementListItem[];
  meta: EnhancementListMeta | null;
  isLoading: boolean;
  error: string | null;
  /** True while at least one row on the CURRENT page is pending/processing. */
  polling: boolean;
  /** Re-fetch with a visible loading state (user-initiated). */
  refresh: () => Promise<void>;
}

/**
 * List + poll the AI Enhancements hub (issue #201).
 *
 * Pass `null` to keep the hook inert (e.g. no active circle yet). Fetches
 * whenever the effective params change, then polls every
 * {@link ENHANCEMENTS_POLL_MS} for as long as any row on the page is `pending`
 * or `processing`, stopping once the page is all-terminal.
 *
 * Two borrowed idioms:
 *  - The refetch callback is held in a ref (`useRunPolling`) so re-creating it
 *    each render never re-arms the interval; only the params key and the
 *    live/all-terminal flag do.
 *  - Poll ticks are SILENT (`isLoading` stays false), so a 5s refresh never
 *    flashes the list into a skeleton under the user's cursor. Only the
 *    initial load and an explicit `refresh()` show the loading state.
 */
export function useEnhancements(
  params: ListEnhancementsParams | null,
): UseEnhancementsResult {
  const [items, setItems] = useState<EnhancementListItem[]>([]);
  const [meta, setMeta] = useState<EnhancementListMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Params are read through a ref inside `load`, so an inline object literal
  // from the caller cannot retrigger the fetch effect on every render — only a
  // genuine VALUE change (via `paramsKey`) does.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramsKey = useMemo(() => (params ? JSON.stringify(params) : null), [params]);

  const load = useCallback(async (silent: boolean) => {
    const current = paramsRef.current;
    if (!current) {
      setItems([]);
      setMeta(null);
      setError(null);
      return;
    }
    if (!silent) setIsLoading(true);
    try {
      const result = await listEnhancements(current);
      setItems(result.items);
      setMeta(result.meta);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load enhancements');
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [paramsKey, load]);

  const polling = items.some(isLive);

  // Keep the latest callback without re-arming the interval (useRunPolling).
  const onPollRef = useRef(load);
  useEffect(() => {
    onPollRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!paramsKey || !polling) return;
    const id = setInterval(() => {
      void onPollRef.current(true);
    }, ENHANCEMENTS_POLL_MS);
    return () => clearInterval(id);
  }, [paramsKey, polling]);

  const refresh = useCallback(() => load(false), [load]);

  return { items, meta, isLoading, error, polling, refresh };
}
