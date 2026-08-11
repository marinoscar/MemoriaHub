import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReviewCountsResponse } from '../types/media';
import { getReviewCounts } from '../services/media';
import { useCircle } from './useCircle';
import { useIsMounted } from './useIsMounted';

// ---------------------------------------------------------------------------
// Module-level refresh signal
//
// WHY THE SIGNAL (issue #390, spec §4.5 requirement 1)
// ---------------------------------------------------
// More than one surface renders these counts at once: the Review hub's queue
// list and the sidebar's aggregate Review badge, on the same screen. State was
// per-instance, so refetching on the hub's mount would update the list while
// the badge kept showing the number it loaded when the app booted — **the badge
// and the list would disagree with each other in the same viewport**, which is
// worse than either being stale alone, because it reads as a bug rather than as
// lag.
//
// So "refresh the counts" is a module-level event rather than an instance
// method: `refreshReviewCounts()` bumps a revision every mounted hook observes,
// and every enabled instance refetches together.
//
// WHAT IS DELIBERATELY *NOT* SHARED
// ---------------------------------
// Only the signal. The data, the loading flag and the request itself stay
// per-instance, so a refresh with two consumers mounted issues two requests.
// That is accepted rather than deduped: `GET /api/media/review-counts` returns
// four integers, and both a response CACHE and an in-flight SLOT were tried and
// removed — each introduces module state that survives unmount, which buys one
// avoided request in exchange for staleness a consumer cannot bust (cache) or a
// slot a single hung request wedges shut (in-flight). Neither trade is worth it
// at this payload size.
//
// Keeping the state per-instance is also what preserves `enabled: false` ⇒ no
// request, `data: null`, which issue #204 depends on.
// ---------------------------------------------------------------------------

let revision = 0;
const listeners = new Set<() => void>();

function getRevision(): number {
  return revision;
}

function subscribeRevision(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Invalidate the review counts everywhere they are rendered.
 *
 * Every mounted `useReviewCounts` refetches, so the hub list and the sidebar
 * badge can never show two different numbers. Called on the Review hub's mount
 * (spec §4.5 requirement 1: returning after clearing four bursts must not show
 * a cached "4"), and by any caller's `refetch()`.
 */
export function refreshReviewCounts(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

/** Test hatch: the revision outlives React unmounts by design. */
export function __resetReviewCountsForTests(): void {
  revision = 0;
  listeners.clear();
}

interface UseReviewCountsOptions {
  /**
   * When false, the hook makes NO request and reports `data: null`.
   *
   * This exists because hooks cannot be called conditionally: a caller that
   * only needs these counts behind a feature gate (e.g. the Review hub's queue
   * list, gated on at least one review feature being enabled) must still call
   * the hook unconditionally. Passing `enabled: false` is how it opts out of
   * the network call without breaking the rules of hooks — see issue #204.
   *
   * Flipping this back to true (e.g. once a feature flag finishes loading)
   * triggers the fetch, since `enabled` participates in the effect deps.
   *
   * Default: true.
   */
  enabled?: boolean;
}

interface UseReviewCountsResult {
  data: ReviewCountsResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetch the four review-queue counts for the active circle.
 *
 * The lightweight counterpart to `useDashboard` for surfaces that only need a
 * pending-work number for a badge: `GET /api/media/review-counts` returns four
 * integers, where the dashboard also returns On This Day / recent / favorites
 * with a signed thumbnail URL per item.
 */
export function useReviewCounts(
  options: UseReviewCountsOptions = {},
): UseReviewCountsResult {
  const { enabled = true } = options;
  const { activeCircleId } = useCircle();
  const [data, setData] = useState<ReviewCountsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  // Participating in the shared revision is what makes every consumer refetch
  // together; it is read during render so it can be an effect dependency.
  const rev = useSyncExternalStore(subscribeRevision, getRevision, getRevision);

  const fetch = useCallback(
    async (circleId: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await getReviewCounts(circleId);
        if (!isMounted()) return;
        setData(response);
      } catch (err) {
        if (!isMounted()) return;
        const message = err instanceof Error ? err.message : 'Failed to load review counts';
        setError(message);
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  // The instance's OWN lifecycle fetch: mount, and any change to what it is
  // fetching. Deliberately does NOT depend on `rev` — see the effect below.
  useEffect(() => {
    if (!enabled || !activeCircleId) {
      setData(null);
      setIsLoading(false);
      return;
    }
    void fetch(activeCircleId);
  }, [enabled, activeCircleId, fetch]);

  // The SHARED-SIGNAL fetch, split out and guarded so it fires only on a
  // GENUINE bump — never on this instance's first run.
  //
  // WHY (issue #392): `ReviewHubPage` calls `refreshReviewCounts()` from its own
  // mount effect, which is spec §4.5 requirement 1 — returning after clearing
  // four bursts must not show a cached "4". But with `rev` folded into the
  // effect above, one hub mount issued TWO identical requests: the instance's
  // own mount fetch, and then a second one when its own signal bumped the
  // revision a tick later. The signal exists to refetch OTHER already-mounted
  // instances (the rail's aggregate badge), which have already done their own
  // mount fetch; a freshly-mounting instance is by definition not stale.
  //
  // The ref is seeded from `rev` at first render rather than from a boolean
  // "have I run" flag, so an instance that mounts DURING someone else's bump
  // still compares against the revision it actually rendered with.
  const seenRevisionRef = useRef(rev);
  useEffect(() => {
    if (seenRevisionRef.current === rev) return;
    seenRevisionRef.current = rev;
    // A disabled instance still issues no request of its own (issue #204) —
    // the signal does not override the gate.
    if (!enabled || !activeCircleId) return;
    void fetch(activeCircleId);
  }, [rev, enabled, activeCircleId, fetch]);

  // Routed through the shared signal rather than fetching locally, so one
  // caller's refresh refreshes every consumer — see the header comment. A
  // disabled instance still issues no request of its own: its effect returns
  // early regardless of the revision.
  const refetch = useCallback(() => {
    refreshReviewCounts();
  }, []);

  return { data, isLoading, error, refetch };
}
