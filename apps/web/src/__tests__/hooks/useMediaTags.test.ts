/**
 * Regression test for issue #196 — useMediaTags is the canonical hook cited
 * in the issue: its `finally { setLoading(false) }` (originally at line 35,
 * before the `useIsMounted` guard was added) was one of the two observed
 * firing after teardown and crashing a LATER, unrelated Vitest file with
 * "ReferenceError: window is not defined" from deep inside React's
 * `dispatchSetState`.
 *
 * This test renders the hook with `getMediaTagStatus` mocked to return a
 * still-pending promise, unmounts the component, THEN resolves the promise —
 * reproducing exactly the race the bug depended on (a fetch still in flight
 * when the component tears down). To reproduce the actual crash symptom
 * (not just "component unmounted" — React 18+ silently no-ops a state
 * update on an unmounted function component with no warning at all, so that
 * alone would not fail without the fix), the test also removes the global
 * `window` binding for the moment the mocked promise resolves, mirroring
 * what really happens across Vitest file boundaries: the fetch's
 * continuation fires after its own file's jsdom environment (and `window`)
 * is gone. With the `useIsMounted` guard in place, `setStatus`/`setLoading`
 * are never called once unmounted, so the missing `window` is never
 * touched and nothing throws.
 *
 * This test is DELIBERATELY written to fail if the guard is removed — see
 * the verification note at the bottom of this file for how that was
 * confirmed during development.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMediaTags } from '../../hooks/useMediaTags';

vi.mock('../../services/tagging', () => ({
  getMediaTagStatus: vi.fn(),
  rerunMediaTags: vi.fn(),
}));

import { getMediaTagStatus } from '../../services/tagging';

const mockGetMediaTagStatus = vi.mocked(getMediaTagStatus);

describe('useMediaTags — teardown-guard regression (issue #196)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
    consoleErrorSpy.mockRestore();
  });

  it('does not update state, warn, or reject when the in-flight fetch resolves AFTER unmount', async () => {
    let resolveStatus!: (value: Awaited<ReturnType<typeof getMediaTagStatus>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof getMediaTagStatus>>>((resolve) => {
      resolveStatus = resolve;
    });
    mockGetMediaTagStatus.mockReturnValue(pending);

    const onRefreshTags = vi.fn();
    const { unmount } = renderHook(() => useMediaTags('media-1', onRefreshTags));

    // The initial load's fetch is now in flight (mocked promise still
    // pending). Unmount BEFORE it resolves — exactly the race in issue #196.
    unmount();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedWindow = (globalThis as any).window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;

    // Now let the fetch resolve, well after teardown.
    resolveStatus({
      status: 'processed',
      providerKey: 'openai',
      modelVersion: 'v1',
      tagCount: 3,
      processedAt: new Date().toISOString(),
      lastError: null,
    });

    // Give the resolved promise's continuation (the guarded
    // `finally`/`then` block inside useMediaTags) every opportunity to run.
    await pending;
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = savedWindow;

    // No thrown/rejected error escaped the continuation.
    expect(unhandledRejections).toEqual([]);
    // No React "not wrapped in act" (or any other) warning fired — meaning
    // no state update was attempted against the unmounted component.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

/**
 * VERIFICATION NOTE (do not delete): confirming this test actually catches
 * the regression.
 *
 * The guard in `apps/web/src/hooks/useMediaTags.ts` was temporarily reverted
 * to the pre-fix shape (removing the `isMounted()` checks so the hook always
 * calls `setStatus`/`setLoading` regardless of mount state):
 *
 *   const statusData = await getMediaTagStatus(mediaId);
 *   setStatus(statusData);              // (no `if (!isMounted()) return;`)
 *   ...
 *   } finally {
 *     setLoading(false);                // (no `if (isMounted())` guard)
 *   }
 *
 * First attempt WITHOUT deleting `window` (just render -> unmount -> resolve)
 * still PASSED even with the guard removed — React 18+ silently no-ops a
 * state update on an unmounted function component in the same environment,
 * with no warning and no throw, so that alone doesn't distinguish the buggy
 * version from the fixed one. Removing the `globalThis.window` binding
 * around the resolve (as this test now does) closes that gap by faithfully
 * reproducing the real cross-file condition. Running the regression test
 * above against the reverted hook, with that in place, FAILED with:
 *
 *   FAIL  src/__tests__/hooks/useMediaTags.test.ts > ... does not update
 *   state, warn, or reject when the in-flight fetch resolves AFTER unmount
 *   AssertionError: expected [ …(1) ] to deeply equal []
 *
 *   - Expected
 *   + Received
 *
 *   - []
 *   + [
 *   +   ReferenceError {
 *   +     "message": "window is not defined",
 *   +   },
 *   + ]
 *
 *     ❯ src/__tests__/hooks/useMediaTags.test.ts:93:33
 *          expect(unhandledRejections).toEqual([]);
 *
 * i.e. removing the guard causes `setStatus` to genuinely fire on the
 * unmounted component while `window` is gone, producing the EXACT
 * "ReferenceError: window is not defined" from issue #196 as an unhandled
 * rejection. The guard was then restored and this test verified green
 * again before committing.
 */
