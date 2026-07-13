/**
 * Unit tests for useReviewInsights hook.
 *
 * Tests:
 *   - Does not fetch when circleId is null
 *   - Fetches on mount when a circleId is provided
 *   - Sets data and clears loading after a successful fetch
 *   - Sets an error message when the fetch rejects (Error vs. non-Error)
 *   - reload() re-fetches with the current circleId
 *   - Re-fetches when circleId changes (new effect dependency)
 *   - Clears a prior error on a successful reload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the reviewInsights service — must be hoisted before hook import
// ---------------------------------------------------------------------------

vi.mock('../../services/reviewInsights', () => ({
  getReviewInsights: vi.fn(),
}));

import { useReviewInsights } from '../../hooks/useReviewInsights';
import * as reviewInsightsService from '../../services/reviewInsights';
import type { ReviewInsights } from '../../services/reviewInsights';

const mockGetReviewInsights = vi.mocked(reviewInsightsService.getReviewInsights);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyMetrics = {
  identified: 0,
  pending: 0,
  resolved: 0,
  dismissed: 0,
  archivedGroups: 0,
  trashedGroups: 0,
  itemsKept: 0,
  itemsArchived: 0,
  itemsDeleted: 0,
};

const sampleInsights: ReviewInsights = {
  bursts: { ...emptyMetrics, identified: 10, pending: 4, resolved: 5, dismissed: 1 },
  duplicates: { ...emptyMetrics, identified: 3, pending: 3 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useReviewInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReviewInsights.mockResolvedValue(sampleInsights);
  });

  // =========================================================================
  // No circleId
  // =========================================================================

  describe('no circleId', () => {
    it('does not call getReviewInsights when circleId is null', async () => {
      const { result } = renderHook(() => useReviewInsights(null));

      // Give any stray effect a chance to run
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockGetReviewInsights).not.toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
    });
  });

  // =========================================================================
  // Initial load
  // =========================================================================

  describe('initial load', () => {
    it('calls getReviewInsights with the circleId on mount', async () => {
      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockGetReviewInsights).toHaveBeenCalledWith('circle-1');
    });

    it('starts with loading=true and data=null while the fetch is in flight', () => {
      mockGetReviewInsights.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeNull();
    });

    it('sets data after a successful fetch', async () => {
      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.data).toEqual(sampleInsights);
      });
    });

    it('starts with error=null', () => {
      mockGetReviewInsights.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      expect(result.current.error).toBeNull();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('sets the error message when getReviewInsights rejects with an Error', async () => {
      mockGetReviewInsights.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });
    });

    it('sets a generic error message for non-Error rejections', async () => {
      mockGetReviewInsights.mockRejectedValue('something bad');

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load review insights');
      });
    });

    it('sets loading=false after a rejection', async () => {
      mockGetReviewInsights.mockRejectedValue(new Error('Server 500'));

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('leaves data=null after a rejection', async () => {
      mockGetReviewInsights.mockRejectedValue(new Error('Server 500'));

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.data).toBeNull();
    });
  });

  // =========================================================================
  // reload()
  // =========================================================================

  describe('reload()', () => {
    it('calls getReviewInsights again when reload() is invoked', async () => {
      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const callsBefore = mockGetReviewInsights.mock.calls.length;

      await act(async () => {
        await result.current.reload();
      });

      expect(mockGetReviewInsights.mock.calls.length).toBe(callsBefore + 1);
    });

    it('clears a prior error after a successful reload', async () => {
      mockGetReviewInsights.mockRejectedValueOnce(new Error('First error'));

      const { result } = renderHook(() => useReviewInsights('circle-1'));

      await waitFor(() => {
        expect(result.current.error).toBe('First error');
      });

      mockGetReviewInsights.mockResolvedValue(sampleInsights);

      await act(async () => {
        await result.current.reload();
      });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual(sampleInsights);
      });
    });

    it('is a no-op when circleId is null', async () => {
      const { result } = renderHook(() => useReviewInsights(null));

      await act(async () => {
        await result.current.reload();
      });

      expect(mockGetReviewInsights).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // circleId changes
  // =========================================================================

  describe('circleId changes', () => {
    it('re-fetches with the new circleId when it changes', async () => {
      const { result, rerender } = renderHook(
        ({ circleId }: { circleId: string | null }) => useReviewInsights(circleId),
        { initialProps: { circleId: 'circle-1' } },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(mockGetReviewInsights).toHaveBeenLastCalledWith('circle-1');

      rerender({ circleId: 'circle-2' });

      await waitFor(() => {
        expect(mockGetReviewInsights).toHaveBeenLastCalledWith('circle-2');
      });
    });
  });
});
