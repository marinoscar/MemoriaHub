import { useEffect, useMemo, useRef } from 'react';
import { getThumbnails } from '../services/media';
import { isThumbnailStuck } from '../utils/thumbnailTimeout';
import type { MediaItem } from '../types/media';

/**
 * usePendingThumbnails — background reconcile for media tiles whose optimized
 * server thumbnail is not yet ready.
 *
 * On upload the gallery shows a local object-URL preview instantly (see
 * `MediaPreviewContext`). This hook then polls `GET /api/media/thumbnails`
 * with a light exponential backoff until each pending item's `thumbnailUrl`
 * becomes available, at which point it hands the resolved URLs to
 * `onResolved` (which patches the tile and frees the local blob).
 *
 * Behaviour:
 *  - Pending = photo/video items with no `thumbnailUrl` that are not yet
 *    "stuck" (past the recovery window). Capped at the first 200.
 *  - Backoff starts at ~2.5s and grows ~1.6x up to a ~15s cap. It resets
 *    whenever the pending set changes (the effect re-keys on the id set).
 *  - Polling pauses while the tab is hidden and resumes on `visibilitychange`.
 *  - Overlapping in-flight requests are prevented with a guard flag.
 *  - Self-terminating: stops scheduling once nothing is pending.
 */

const INITIAL_BACKOFF_MS = 2500;
const BACKOFF_FACTOR = 1.6;
const MAX_BACKOFF_MS = 15000;
const MAX_PENDING = 200;

export function usePendingThumbnails(
  items: MediaItem[],
  circleId: string | undefined,
  onResolved: (updates: Array<{ id: string; thumbnailUrl: string }>) => void,
): void {
  // Pending ids for the current render, capped. Recomputed only when `items`
  // change; the joined key drives the effect so it re-keys when the set moves.
  const pendingIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of items) {
      if (
        (item.type === 'photo' || item.type === 'video') &&
        !item.thumbnailUrl &&
        !isThumbnailStuck(item.createdAt)
      ) {
        ids.push(item.id);
        if (ids.length >= MAX_PENDING) break;
      }
    }
    return ids;
  }, [items]);

  const pendingKey = pendingIds.join(',');

  // Latest values read inside the self-scheduling loop without re-keying it.
  const pendingIdsRef = useRef(pendingIds);
  pendingIdsRef.current = pendingIds;
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;

  useEffect(() => {
    if (!circleId || pendingKey === '') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let backoff = INITIAL_BACKOFF_MS;

    const schedule = (ms: number) => {
      timer = setTimeout(() => void runTick(), ms);
    };

    const runTick = async () => {
      if (cancelled) return;
      // Paused while hidden — the visibility handler resumes us.
      if (document.hidden) return;
      // Never overlap requests; try again after the current backoff.
      if (inFlight) {
        schedule(backoff);
        return;
      }

      const ids = pendingIdsRef.current;
      if (ids.length === 0) return; // self-terminate

      inFlight = true;
      try {
        const results = await getThumbnails(circleId, ids);
        if (!cancelled) {
          const updates = results
            .filter(
              (r): r is { id: string; thumbnailUrl: string } =>
                r.thumbnailUrl != null,
            )
            .map((r) => ({ id: r.id, thumbnailUrl: r.thumbnailUrl }));
          if (updates.length > 0) onResolvedRef.current(updates);
        }
      } catch {
        // Swallow — retry on the next tick with a longer backoff.
      } finally {
        inFlight = false;
      }

      if (cancelled) return;
      backoff = Math.min(backoff * BACKOFF_FACTOR, MAX_BACKOFF_MS);
      schedule(backoff);
    };

    const handleVisibility = () => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        schedule(0);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    schedule(INITIAL_BACKOFF_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [pendingKey, circleId]);
}
