import { useCallback, useEffect, useRef } from 'react';

/**
 * useIsMounted — returns a getter that reports whether the calling component is
 * still mounted.
 *
 * WHY THIS EXISTS (issue #196 — do not delete this as ceremony):
 *
 * Most data-loading hooks in this app follow the shape
 *
 *   setLoading(true);
 *   try   { setData(await getX(id)); }
 *   catch { setError(...); }
 *   finally { setLoading(false); }
 *
 * If the component unmounts while `getX` is still in flight, the `finally`
 * (and the `then`/`catch`) still runs — later, detached from any component.
 * Under Vitest that continuation can land AFTER the test file that started it
 * has finished and its jsdom environment has been torn down, so React's
 * `dispatchSetState → requestUpdateLane → resolveUpdatePriority` touches a
 * `window` global that no longer exists and throws
 *
 *   ReferenceError: window is not defined
 *
 * as an *unhandled rejection*, attributed to whatever unrelated test file
 * happens to be running in that worker. Every assertion still passes; only the
 * error count and the exit code change — which is exactly what made `apps/web`'s
 * CI gate flaky and untrustworthy on the first run.
 *
 * Guarding each post-`await` state setter with `isMounted()` keeps the
 * continuation from touching React at all once the component is gone. Behaviour
 * for a MOUNTED component is unchanged — this is purely "don't touch state
 * after teardown".
 *
 * Usage:
 *
 *   const isMounted = useIsMounted();
 *   ...
 *   try {
 *     const data = await getX(id);
 *     if (!isMounted()) return;
 *     setData(data);
 *   } catch (err) {
 *     if (!isMounted()) return;
 *     setError(...);
 *   } finally {
 *     if (isMounted()) setLoading(false);
 *   }
 *
 * StrictMode note: the ref is initialised to `true` (so a synchronous call made
 * during the first render pass, before effects flush, is not wrongly reported
 * as unmounted) AND re-set to `true` on every mount. React 18/19 StrictMode
 * mounts, unmounts, then remounts each component in development; the first
 * unmount runs the cleanup and flips the ref to `false`, so without the
 * re-assignment on mount the hook would permanently report "unmounted" for a
 * component that is very much alive.
 */
export function useIsMounted(): () => boolean {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return useCallback(() => mountedRef.current, []);
}
