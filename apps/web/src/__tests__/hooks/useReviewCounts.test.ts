import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useReviewCounts } from '../../hooks/useReviewCounts';
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
});
