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

  // Does THIS instance have a request in the air right now? Read only by guard
  // 2 below.
  //
  // A ref rather than the `isLoading` state it shadows, for two reasons: it
  // must not cause a render, and it must be readable SYNCHRONOUSLY inside an
  // effect that runs in the very same commit that started the fetch — a state
  // update would not have landed yet at that point, which is precisely the
  // moment the guard has to make its decision.
  //
  // Per-INSTANCE, which is why `__resetReviewCountsForTests` needs no addition
  // for it: it dies with the component that owns it.
  const inFlightRef = useRef(false);

  const fetch = useCallback(
    async (circleId: string) => {
      inFlightRef.current = true;
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
        // UNCONDITIONAL, and unlike the `isLoading` reset below it is NOT gated
        // on `isMounted()`. This is the property that makes the whole guard
        // safe: a rejected request, an aborted one, or one that resolves after
        // unmount can never leave the flag stuck true and the instance
        // permanently deaf to the shared signal. The failure mode is bounded to
        // one component AND it self-heals on the very next settle.
        inFlightRef.current = false;
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

  // The SHARED-SIGNAL fetch, split out of the lifecycle effect above and
  // protected by TWO guards. They defend against different things and neither
  // subsumes the other (issue #392).
  //
  // WHAT THE SIGNAL IS FOR, so the guards read as narrowing rather than as
  // undoing it: `refreshReviewCounts()` exists to update instances that are
  // ALREADY MOUNTED AND STALE — above all the navigation rail's aggregate
  // badge, which is mounted for the whole session and would otherwise still
  // show "4" after the user cleared four bursts (spec §4.5 requirement 1).
  // Both guards below only ever suppress a refetch for an instance that
  // demonstrably already holds fresh data, so that job is untouched.
  //
  // GUARD 1 — FIRST RUN (`seenRevisionRef`). Without it, a BARE MOUNT with no
  // concurrent signal at all fires twice: the effect above fetches, and this
  // effect's own first run fetches again because `rev` is one of its deps. That
  // is the common case — every review badge mount anywhere in the app — so
  // fixing it halves the request count on the far more frequent path. (It does
  // NOT by itself fix the Review hub, which is guard 2's job.) The ref is
  // seeded from `rev` at first render rather than from a boolean "have I run"
  // flag, so an instance mounting DURING someone else's bump still compares
  // against the revision it actually rendered with.
  //
  // GUARD 2 — IN FLIGHT (`inFlightRef`). `ReviewHubPage` mounts TWO consumers
  // of this hook (its own `useReviewQueues` call, plus the nested
  // `<ReviewQueueList>`), then calls `refreshReviewCounts()` from its mount
  // effect — which lands AFTER both have already started fetching, so it is a
  // genuine bump that guard 1 cannot catch, and the hub cost 4 requests where 2
  // would do. An instance with a request already in the air does not stack a
  // second one on top of it; the answer it is waiting for is the same answer
  // the bump would ask for. The rail's badge is idle at that moment, so it
  // refetches exactly as intended, which is the whole point of the signal.
  //
  // THE RULE IS "don't stack a refetch on a fetch already running for this
  // instance" — stated directly. An earlier revision approximated it with a
  // wall-clock "did I fetch within the last second" window, which was both
  // vaguer (it also suppressed genuine signals arriving shortly after an
  // instance had finished loading) and non-deterministic: it made the signal's
  // core contract — an older mounted instance still refetches — impossible to
  // assert without controlling the clock, since in a test "older" is ten
  // milliseconds. A guard that forces correct tests to fake time is telling you
  // something about the guard.
  //
  // Deliberately NOT a response cache and NOT a MODULE-LEVEL in-flight slot:
  // both were tried in issue #390 and removed. A cache introduces module state
  // that survives unmount and hands consumers staleness they cannot bust; a
  // shared slot is wedged shut GLOBALLY and permanently by one request that
  // never settles, taking every consumer down with it.
  //
  // A PER-INSTANCE flag is not the same mechanism, and this is the distinction
  // a future reader will trip over: it holds no data, so it cannot serve
  // anything stale; its blast radius is one component; it cannot outlive that
  // component; it is cleared in an unconditional `finally`, so even a rejected
  // or post-unmount fetch releases it; and an instance stuck mid-request is
  // already rendering its own loading state. Bounded and self-healing, rather
  // than global and permanent.
  const seenRevisionRef = useRef(rev);
  useEffect(() => {
    if (seenRevisionRef.current === rev) return;
    // Consumed even when the fetch is skipped below, so one bump can never be
    // acted on twice.
    seenRevisionRef.current = rev;
    // A disabled instance still issues no request of its own (issue #204) —
    // the signal does not override the gate.
    if (!enabled || !activeCircleId) return;
    if (inFlightRef.current) return;
    void fetch(activeCircleId);
  }, [rev, enabled, activeCircleId, fetch]);

  // `refetch()` fetches LOCALLY *and* raises the shared signal — it is not
  // merely a wrapper around the signal any more, and the difference matters.
  //
  // Guard 2 above is scoped to the SIGNAL, which is an ambient "someone,
  // somewhere, changed the data" broadcast that a busy instance can safely
  // ignore. `refetch()` is the opposite: an explicit, caller-initiated "get ME
  // the numbers again" on THIS instance. If it were still routed only through
  // the signal, guard 2 would silently swallow it whenever a fetch happened to
  // be in flight — so a "Refresh" button pressed while the page was still
  // settling would do nothing at all, and report success while doing it. The
  // local fetch is therefore unconditional.
  //
  // Ordering is deliberate: the local fetch runs FIRST so it raises
  // `inFlightRef`, and the bump that follows is then correctly ignored by this
  // instance's own revision effect while still reaching every OTHER mounted
  // consumer. One request here, one per sibling — never two for the caller.
  //
  // `enabled: false` still issues no request of its own (issue #204): the local
  // fetch is gated, and only the broadcast goes out.
  const refetch = useCallback(() => {
    if (enabled && activeCircleId) {
      void fetch(activeCircleId);
    }
    refreshReviewCounts();
  }, [enabled, activeCircleId, fetch]);

  return { data, isLoading, error, refetch };
}
