import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDashboard } from '../../hooks/useDashboard';
import type { DashboardResponse } from '../../types/media';

// ---------------------------------------------------------------------------
// Mock getDashboard service
// ---------------------------------------------------------------------------
vi.mock('../../services/media', () => ({
  getDashboard: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock useCircle so we can control activeCircleId without CircleProvider
// ---------------------------------------------------------------------------
vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

import { getDashboard } from '../../services/media';
import { useCircle } from '../../hooks/useCircle';

const mockGetDashboard = vi.mocked(getDashboard);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const mockDashboard: DashboardResponse = {
  onThisDay: [],
  recent: [],
  favorites: [],
  counts: { total: 10, unreviewed: 3, lowValue: 2, missingGeo: 1 },
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
describe('useDashboard', () => {
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
      const { result } = renderHook(() => useDashboard());

      expect(result.current.data).toBeNull();
    });

    it('returns isLoading: false immediately', () => {
      const { result } = renderHook(() => useDashboard());

      expect(result.current.isLoading).toBe(false);
    });

    it('returns error: null', () => {
      const { result } = renderHook(() => useDashboard());

      expect(result.current.error).toBeNull();
    });

    it('does NOT call getDashboard', () => {
      renderHook(() => useDashboard());

      expect(mockGetDashboard).not.toHaveBeenCalled();
    });

    it('refetch is a no-op when there is no activeCircleId', () => {
      const { result } = renderHook(() => useDashboard());

      act(() => {
        result.current.refetch();
      });

      expect(mockGetDashboard).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Active circle — successful fetch
  // -------------------------------------------------------------------------
  describe('when activeCircleId is set', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetDashboard.mockResolvedValue(mockDashboard);
    });

    it('calls getDashboard with the activeCircleId', async () => {
      renderHook(() => useDashboard());

      await waitFor(() => {
        expect(mockGetDashboard).toHaveBeenCalledWith('circle-abc');
      });
    });

    it('returns the dashboard data after a successful fetch', async () => {
      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.data).toEqual(mockDashboard);
      });
    });

    it('sets isLoading to true during fetch, then false when done', async () => {
      let resolvePromise: (value: DashboardResponse) => void;
      const slowPromise = new Promise<DashboardResponse>((resolve) => {
        resolvePromise = resolve;
      });
      mockGetDashboard.mockReturnValueOnce(slowPromise);

      const { result } = renderHook(() => useDashboard());

      // Should start loading immediately
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolvePromise!(mockDashboard);
        await slowPromise;
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('error remains null after a successful fetch', async () => {
      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      expect(result.current.error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('when getDashboard throws', () => {
    beforeEach(() => {
      setCircle('circle-abc');
    });

    it('returns an error string when getDashboard rejects with an Error', async () => {
      mockGetDashboard.mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.error).toBe('Network failure');
      });

      expect(result.current.data).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it('returns the fallback message when getDashboard rejects with a non-Error value', async () => {
      mockGetDashboard.mockRejectedValue('something bad');

      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load dashboard');
      });
    });
  });

  // -------------------------------------------------------------------------
  // refetch
  // -------------------------------------------------------------------------
  describe('refetch', () => {
    beforeEach(() => {
      setCircle('circle-abc');
      mockGetDashboard.mockResolvedValue(mockDashboard);
    });

    it('re-calls getDashboard when refetch is invoked', async () => {
      const { result } = renderHook(() => useDashboard());

      // Wait for initial fetch to finish
      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      const callCountBefore = mockGetDashboard.mock.calls.length;

      act(() => {
        result.current.refetch();
      });

      await waitFor(() => {
        expect(mockGetDashboard.mock.calls.length).toBe(callCountBefore + 1);
      });
    });

    it('updates data after refetch resolves with new data', async () => {
      const { result } = renderHook(() => useDashboard());

      await waitFor(() => {
        expect(result.current.data).toEqual(mockDashboard);
      });

      const updatedDashboard: DashboardResponse = {
        ...mockDashboard,
        counts: { total: 20, unreviewed: 5, lowValue: 3, missingGeo: 2 },
      };
      mockGetDashboard.mockResolvedValueOnce(updatedDashboard);

      act(() => {
        result.current.refetch();
      });

      await waitFor(() => {
        expect(result.current.data?.counts.total).toBe(20);
      });
    });
  });
});
