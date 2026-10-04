import { useEffect, useRef, RefObject } from 'react';

interface UseIntersectionObserverOptions {
  /** rootMargin to trigger before reaching the sentinel (default: '200px') */
  rootMargin?: string;
  threshold?: number;
  /** Whether to disable the observer (e.g. when hasMore is false) */
  disabled?: boolean;
  /**
   * Re-arm key. Whenever this value changes the observer is torn down and
   * re-created. `IntersectionObserver.observe()` always delivers an initial
   * callback for the observed element, so a sentinel that is STILL inside the
   * root margin re-fires `onIntersect`.
   *
   * Why this exists: the observer only reports visibility *transitions*. If a
   * trigger is dropped (e.g. it fired while a fetch was already in flight) or
   * the content that arrived did not push the sentinel back out of the root
   * margin, no further transition ever occurs and infinite scroll stalls
   * (issue #548). Callers pass a value that changes only when a load has
   * COMPLETED (e.g. the loaded item count) — never one that flips when a load
   * starts, which would chain-load (issue #291).
   */
  rearmKey?: unknown;
}

/**
 * Calls `onIntersect` when the observed element enters the viewport.
 * Guards against firing while `disabled` is true (e.g. hasMore=false or isLoading).
 */
export function useIntersectionObserver(
  ref: RefObject<Element | null>,
  onIntersect: () => void,
  options: UseIntersectionObserverOptions = {},
): void {
  const { rootMargin = '200px', threshold = 0, disabled = false, rearmKey } = options;
  const callbackRef = useRef(onIntersect);
  callbackRef.current = onIntersect;

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          callbackRef.current();
        }
      },
      { rootMargin, threshold },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin, threshold, disabled, rearmKey]);
}
