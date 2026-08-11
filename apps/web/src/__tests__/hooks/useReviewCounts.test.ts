import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useReviewCounts,
  refreshReviewCounts,
  __resetReviewCountsForTests,
} from '../../hooks/useReviewCounts';
import type { ReviewCountsResponse } from '../../types/media';

// ---------------------------------------------------------------------------
// Mock getReviewCounts service
// ---------------------------------------------------------------------------
vi.mock('../../services/media', () => ({
  getReviewCounts: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock useCircle so we can control activeCircleId without CircleProvider
// ---------------------------------------------------------------------------
vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

import { getReviewCounts } from '../../services/media';
import { useCircle } from '../../hooks/useCircle';

const mockGetReviewCounts = vi.mocked(getReviewCounts);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const mockCounts: ReviewCountsResponse = {
  pendingBurstGroups: 2,
  pendingDuplicateGroups: 3,
  pendingLocationSuggestions: 4,
  pendingEnhancements: 5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setCircle(id: string | null) {
  mockUseCircle.mockReturnValue({
    circles: [],
    activeCircle: id
      ? {
          id,
          name: 'Test Circle',
          description: null,
          ownerId: 'test-user-id',
          isPersonal: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      : null,
    activeCircleId: id,
    activeCircleRole: id ? 'circle_admin' : null,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useReviewCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetReviewCountsForTests();
  });

  // -------------------------------------------------------------------------
  // No active circle
  // -------------------------------------------------------------------------
  describe('when activeCircleId is null', () => {
    beforeEach(() => {
      setCircle(null);
    });

    it('returns data: null immediately', () => {
      const { result } = renderHook(() => useReviewCounts());

      expect(result.current.data).toBeNull();
    });

    it('returns isLoading: false immediately', () => {
      const { result } = renderHook(() => useReviewCounts());

      expect(result.current.isLoading).toBe(false);
    });

    it('returns error: null', () => {
      const { result } = renderHook(() => useReviewCounts());

      expect(result.current.error).toBeNull();
    });

    it('does NOT call getReviewCounts', () => {
      renderHook(() => useReviewCounts());

      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });

    it('refetch is a no-op when there is no activeCircleId', () => {
      const { result } = renderHook(() => useReviewCounts());

      act(() => {
        result.current.refetch();
      });

      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Active circle — successful fetch (default: enabled)
  // -------------------------------------------------------------------------
  describe('when activeCircleId is set', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetReviewCounts.mockResolvedValue(mockCounts);
    });

    it('fetches by default, with no options argument at all', async () => {
      renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-abc');
      });
    });

    it('fetches when an empty options object is passed', async () => {
      renderHook(() => useReviewCounts({}));

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-abc');
      });
    });

    it('returns the counts after a successful fetch', async () => {
      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(result.current.data).toEqual(mockCounts);
      });
    });

    it('sets isLoading to true during fetch, then false when done', async () => {
      let resolvePromise: (value: ReviewCountsResponse) => void;
      const slowPromise = new Promise<ReviewCountsResponse>((resolve) => {
        resolvePromise = resolve;
      });
      mockGetReviewCounts.mockReturnValueOnce(slowPromise);

      const { result } = renderHook(() => useReviewCounts());

      // Should start loading immediately
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolvePromise!(mockCounts);
        await slowPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('error remains null after a successful fetch', async () => {
      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      expect(result.current.error).toBeNull();
    });

    it('refetches when the active circle changes', async () => {
      const { rerender } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-abc');
      });

      setCircle('circle-xyz');
      rerender();

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-xyz');
      });
    });
  });

  // -------------------------------------------------------------------------
  // The `enabled` gate — the reason this hook exists separately from
  // useDashboard (issue #204). Hooks cannot be called conditionally, so a
  // caller behind a feature gate opts out through this option instead.
  // -------------------------------------------------------------------------
  describe('enabled option', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetReviewCounts.mockResolvedValue(mockCounts);
    });

    it('makes NO request when enabled is false, even with an active circle', async () => {
      const { result } = renderHook(() => useReviewCounts({ enabled: false }));

      // Give any stray mount effect a chance to fire before asserting.
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGetReviewCounts).not.toHaveBeenCalled();
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('refetch is a no-op while disabled', async () => {
      const { result } = renderHook(() => useReviewCounts({ enabled: false }));

      act(() => {
        result.current.refetch();
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });

    it('starts fetching when enabled flips false -> true', async () => {
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useReviewCounts({ enabled }),
        { initialProps: { enabled: false } },
      );

      expect(mockGetReviewCounts).not.toHaveBeenCalled();

      rerender({ enabled: true });

      await waitFor(() => {
        expect(mockGetReviewCounts).toHaveBeenCalledWith('circle-abc');
      });
      await waitFor(() => {
        expect(result.current.data).toEqual(mockCounts);
      });
    });

    it('clears data and issues no further request when enabled flips true -> false', async () => {
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useReviewCounts({ enabled }),
        { initialProps: { enabled: true } },
      );

      await waitFor(() => {
        expect(result.current.data).toEqual(mockCounts);
      });
      const callsWhileEnabled = mockGetReviewCounts.mock.calls.length;

      rerender({ enabled: false });

      await waitFor(() => {
        expect(result.current.data).toBeNull();
      });
      expect(mockGetReviewCounts.mock.calls.length).toBe(callsWhileEnabled);
    });

    it('makes no request when enabled is true but there is no active circle', async () => {
      setCircle(null);

      const { result } = renderHook(() => useReviewCounts({ enabled: true }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('when getReviewCounts throws', () => {
    beforeEach(() => {
      setCircle('circle-abc');
    });

    it('returns an error string when getReviewCounts rejects with an Error', async () => {
      mockGetReviewCounts.mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(result.current.error).toBe('Network failure');
      });

      expect(result.current.data).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it('returns the fallback message when getReviewCounts rejects with a non-Error value', async () => {
      mockGetReviewCounts.mockRejectedValue('something bad');

      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load review counts');
      });
    });
  });

  // -------------------------------------------------------------------------
  // refetch
  // -------------------------------------------------------------------------
  describe('refetch', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetReviewCounts.mockResolvedValue(mockCounts);
    });

    it('re-calls getReviewCounts when refetch is invoked', async () => {
      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      const callCountBefore = mockGetReviewCounts.mock.calls.length;

      act(() => {
        result.current.refetch();
      });

      await waitFor(() => {
        expect(mockGetReviewCounts.mock.calls.length).toBe(callCountBefore + 1);
      });
    });

    it('updates data after refetch resolves with new counts', async () => {
      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => {
        expect(result.current.data).toEqual(mockCounts);
      });

      mockGetReviewCounts.mockResolvedValueOnce({
        ...mockCounts,
        pendingEnhancements: 42,
      });

      act(() => {
        result.current.refetch();
      });

      await waitFor(() => {
        expect(result.current.data?.pendingEnhancements).toBe(42);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Shared refresh signal (issue #390, spec §4.5 requirement 1).
  //
  // More than one surface renders these counts at once — the Review hub's
  // queue list and the sidebar's aggregate badge. `refreshReviewCounts()` is
  // what keeps them from disagreeing: it bumps a module-level revision every
  // mounted `useReviewCounts` instance observes, so a refresh triggered by ONE
  // consumer refetches ALL of them together.
  // -------------------------------------------------------------------------
  describe('shared refresh signal', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetReviewCounts.mockResolvedValue(mockCounts);
    });

    it('refreshReviewCounts() triggers a refetch on a mounted, enabled instance', async () => {
      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => expect(result.current.data).not.toBeNull());
      const callsBefore = mockGetReviewCounts.mock.calls.length;

      act(() => {
        refreshReviewCounts();
      });

      await waitFor(() => {
        expect(mockGetReviewCounts.mock.calls.length).toBe(callsBefore + 1);
      });
    });

    it('a single refreshReviewCounts() call refetches EVERY mounted instance, not just one', async () => {
      const first = renderHook(() => useReviewCounts());
      const second = renderHook(() => useReviewCounts());

      await waitFor(() => expect(first.result.current.data).not.toBeNull());
      await waitFor(() => expect(second.result.current.data).not.toBeNull());
      const callsBefore = mockGetReviewCounts.mock.calls.length;

      act(() => {
        refreshReviewCounts();
      });

      // Both instances issued their own request — the shared piece is only
      // the SIGNAL, not the data or the request itself (see the hook's header
      // comment on what is deliberately not shared).
      await waitFor(() => {
        expect(mockGetReviewCounts.mock.calls.length).toBe(callsBefore + 2);
      });
    });

    it('both instances converge on a value changed between the two fetches', async () => {
      const a = renderHook(() => useReviewCounts());
      const b = renderHook(() => useReviewCounts());

      await waitFor(() => expect(a.result.current.data).toEqual(mockCounts));
      await waitFor(() => expect(b.result.current.data).toEqual(mockCounts));

      const updated = { ...mockCounts, pendingEnhancements: 99 };
      mockGetReviewCounts.mockResolvedValue(updated);

      act(() => {
        refreshReviewCounts();
      });

      await waitFor(() => expect(a.result.current.data).toEqual(updated));
      await waitFor(() => expect(b.result.current.data).toEqual(updated));
    });

    it('does NOT refetch a disabled instance — enabled: false still issues no request on a shared refresh', async () => {
      const { result } = renderHook(() => useReviewCounts({ enabled: false }));

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(mockGetReviewCounts).not.toHaveBeenCalled();

      act(() => {
        refreshReviewCounts();
      });

      // Give any stray effect a chance to fire before asserting the negative.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockGetReviewCounts).not.toHaveBeenCalled();
      expect(result.current.data).toBeNull();
    });

    it('a disabled instance ignores the signal even while an enabled sibling instance refetches', async () => {
      const enabled = renderHook(() => useReviewCounts({ enabled: true }));
      const disabled = renderHook(() => useReviewCounts({ enabled: false }));

      await waitFor(() => expect(enabled.result.current.data).not.toBeNull());
      const callsBefore = mockGetReviewCounts.mock.calls.length;

      act(() => {
        refreshReviewCounts();
      });

      await waitFor(() => {
        expect(mockGetReviewCounts.mock.calls.length).toBe(callsBefore + 1);
      });
      expect(disabled.result.current.data).toBeNull();
    });

    it('__resetReviewCountsForTests() leaves the hook in a normal working state for the next test', async () => {
      // Bump the revision a few times, then reset — a subsequent mount must
      // still fetch exactly once on its own, with no residual pending signal
      // from before the reset.
      act(() => {
        refreshReviewCounts();
        refreshReviewCounts();
      });
      __resetReviewCountsForTests();
      mockGetReviewCounts.mockClear();

      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => expect(result.current.data).toEqual(mockCounts));
      expect(mockGetReviewCounts).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // The revision effect's "skip on first run" guard (issue #392) — the
  // double-fetch fix.
  //
  // Before this fix, the hook fetched off a SINGLE effect with `rev` folded
  // directly into its dependency array (`[enabled, activeCircleId, fetch,
  // rev]`). Splitting that into two effects — an unconditional mount-lifecycle
  // fetch, plus a signal-driven fetch — is only correct if the SECOND effect
  // is guarded to do nothing on ITS OWN first run: an unguarded version would
  // ALSO fire (unconditionally, on mount, exactly like any other effect) the
  // moment it exists, which would double every mount's request even with NO
  // `refreshReviewCounts()` call in sight — the "instance's own mount fetch,
  // and then a second one" scenario the current code's comment describes.
  // `seenRevisionRef = useRef(rev)` is what prevents that: it seeds the
  // guard's baseline from whatever revision was ALREADY current when this
  // instance first rendered, so the effect's first run is always a no-op.
  // ---------------------------------------------------------------------------
  describe('the revision effect skips its own first run (double-fetch fix)', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetReviewCounts.mockResolvedValue(mockCounts);
    });

    it('a bare mount with no external refreshReviewCounts() call issues exactly ONE request, not two', async () => {
      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => expect(result.current.data).toEqual(mockCounts));
      // Give a stray second effect run a chance to fire before asserting the
      // count is final — the bug this guards against would show up here as a
      // SECOND call arriving shortly after the first.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockGetReviewCounts).toHaveBeenCalledTimes(1);
    });

    it('mounting while the shared revision is ALREADY non-zero (settled prior activity, no concurrent bump) still issues exactly one request', async () => {
      // Elevate the shared revision via unrelated prior activity, fully
      // settled before this instance ever mounts.
      act(() => {
        refreshReviewCounts();
        refreshReviewCounts();
      });

      const { result } = renderHook(() => useReviewCounts());

      await waitFor(() => expect(result.current.data).toEqual(mockCounts));
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The freshly-mounted instance's own baseline is seeded from the
      // CURRENT (already-elevated) revision, so its first run is a no-op —
      // it never mistakes "the revision happens to be non-zero" for "someone
      // just bumped it".
      expect(mockGetReviewCounts).toHaveBeenCalledTimes(1);
    });
  });
});
