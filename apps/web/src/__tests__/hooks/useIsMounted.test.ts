/**
 * Unit tests for useIsMounted (issue #196).
 *
 * useIsMounted returns a stable getter that reports whether the calling
 * component is currently mounted. Data-loading hooks call it after an
 * `await` to decide whether it's still safe to call a React state setter —
 * see `src/hooks/useIsMounted.ts`'s header comment for the full bug this
 * guards against (a post-teardown continuation throwing
 * "ReferenceError: window is not defined" deep inside React's
 * `dispatchSetState`, sometimes during a LATER, unrelated Vitest file).
 *
 * Covers:
 *   - returns true while the component is mounted
 *   - returns false after the component unmounts
 *   - the returned getter is referentially stable across re-renders (it's
 *     wrapped in useCallback with an empty dependency array, so a caller may
 *     safely capture it in a dependency array without causing effects to
 *     re-run on every render)
 *   - the StrictMode mount → unmount → remount cycle (React 18/19 double-
 *     invokes effects in development) must end up reporting `true`, not
 *     `false` — this is the specific subtlety the hook's mount-effect
 *     re-assignment (`mountedRef.current = true`) guards against. A naive
 *     `useRef(true)` + unmount-only cleanup would leave the ref permanently
 *     `false` after StrictMode's synthetic unmount, even though the
 *     component is still alive.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsMounted } from '../../hooks/useIsMounted';

describe('useIsMounted', () => {
  describe('while mounted', () => {
    it('returns true immediately after mount', () => {
      const { result } = renderHook(() => useIsMounted());

      expect(result.current()).toBe(true);
    });

    it('keeps returning true across re-renders while still mounted', () => {
      const { result, rerender } = renderHook(() => useIsMounted());

      expect(result.current()).toBe(true);

      rerender();

      expect(result.current()).toBe(true);
    });
  });

  describe('after unmount', () => {
    it('returns false once the component has unmounted', () => {
      const { result, unmount } = renderHook(() => useIsMounted());

      expect(result.current()).toBe(true);

      unmount();

      expect(result.current()).toBe(false);
    });
  });

  describe('referential stability', () => {
    it('returns the SAME function reference across re-renders', () => {
      const { result, rerender } = renderHook(() => useIsMounted());

      const firstGetter = result.current;

      rerender();

      expect(result.current).toBe(firstGetter);
    });

    it('keeps the same reference even across multiple re-renders', () => {
      const { result, rerender } = renderHook(() => useIsMounted());

      const firstGetter = result.current;
      rerender();
      rerender();
      rerender();

      expect(result.current).toBe(firstGetter);
      // And it still reports the live mounted state through that one stable
      // reference — a caller closing over it in a dependency array (e.g.
      // `useCallback(..., [isMounted])`) never sees it "go stale".
      expect(firstGetter()).toBe(true);
    });
  });

  describe('StrictMode mount/unmount/remount cycle', () => {
    // Passing `wrapper: <React.StrictMode>` does NOT reliably trigger React's
    // development-mode double-effect-invocation in this RTL/React 19 setup —
    // verified empirically (a throwaway counter hook's effect only fired
    // once through that path). RTL's dedicated `reactStrictMode` render
    // option is the one that actually drives the mount -> cleanup -> remount
    // cycle (confirmed the same way: the counter's effect fires twice with
    // a cleanup in between), so that's what these tests use.
    it('reports true after React 18/19 StrictMode double-invokes the mount effect', () => {
      // React's development-mode StrictMode intentionally mounts, unmounts,
      // then remounts every component once to surface effects that aren't
      // idempotent. That means by the time this render settles, the hook's
      // effect has already run: mount -> cleanup (simulated unmount, sets
      // the ref false) -> mount again. Without the fix's
      // `mountedRef.current = true` re-assignment inside the effect body
      // (relying solely on the initial `useRef(true)` instead), the ref
      // would be left permanently `false` here even though the component is
      // very much alive and none of its "real" unmount cleanup has run.
      const { result } = renderHook(() => useIsMounted(), {
        reactStrictMode: true,
      });

      expect(result.current()).toBe(true);
    });

    it('still returns false after a REAL unmount that follows the StrictMode cycle', () => {
      const { result, unmount } = renderHook(() => useIsMounted(), {
        reactStrictMode: true,
      });

      // Settles true after StrictMode's synthetic mount/unmount/remount.
      expect(result.current()).toBe(true);

      // A genuine unmount afterwards must still be honored.
      unmount();

      expect(result.current()).toBe(false);
    });
  });
});
