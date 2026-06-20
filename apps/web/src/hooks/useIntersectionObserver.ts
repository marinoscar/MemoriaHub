import { useEffect, useRef, RefObject } from 'react';

interface UseIntersectionObserverOptions {
  /** rootMargin to trigger before reaching the sentinel (default: '200px') */
  rootMargin?: string;
  threshold?: number;
  /** Whether to disable the observer (e.g. when hasMore is false) */
  disabled?: boolean;
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
  const { rootMargin = '200px', threshold = 0, disabled = false } = options;
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
  }, [ref, rootMargin, threshold, disabled]);
}
