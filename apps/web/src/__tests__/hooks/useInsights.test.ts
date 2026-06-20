/**
 * Unit tests for the useInsights hook.
 *
 * Tests: initial load sets data and clears loading; refresh() calls the POST
 * endpoint and updates data; error paths propagate to the error field.
 *
 * services/insights is mocked — no HTTP needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the insights service — must be hoisted before the hook import
// ---------------------------------------------------------------------------

vi.mock('../../services/insights', () => ({
  getInsights: vi.fn(),
  refreshInsights: vi.fn(),
}));

import { useInsights } from '../../hooks/useInsights';
import * as insightsService from '../../services/insights';
import type { InsightsSnapshot } from '../../services/insights';

const mockGetInsights = vi.mocked(insightsService.getInsights);
const mockRefreshInsights = vi.mocked(insightsService.refreshInsights);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const readySnapshot: InsightsSnapshot = {
  status: 'ready',
  metrics: {
    totalBytes: '1260000000',
    photoBytes: '472000000',
    videoBytes: '788000000',
    totalItems: 1000,
    photoCount: 800,
    videoCount: 200,
    totalFaces: 4217,
    taggedItems: 650,
  },
  computedAt: '2025-06-20T10:00:00.000Z',
  durationMs: 142,
};

const emptySnapshot: InsightsSnapshot = {
  status: 'empty',
  metrics: null,
  computedAt: null,
  durationMs: null,
};

const freshSnapshot: InsightsSnapshot = {
  status: 'ready',
  metrics: {
    totalBytes: '2000000000',
    photoBytes: '1000000000',
    videoBytes: '1000000000',
    totalItems: 2000,
    photoCount: 1500,
    videoCount: 500,
    totalFaces: 8000,
    taggedItems: 900,
  },
  computedAt: '2025-06-20T11:00:00.000Z',
  durationMs: 98,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    mockGetInsights.mockResolvedValue(readySnapshot);
    mockRefreshInsights.mockResolvedValue(freshSnapshot);
  });

  // =========================================================================
  // Initial load
  // =========================================================================

  describe('initial load', () => {
    it('starts with null data and loading=false before mount resolves', () => {
      // Never-resolving promise keeps the hook in the pending state
      mockGetInsights.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useInsights());

      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('sets data and clears loading after a successful load', async () => {
      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).toEqual(readySnapshot);
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('calls getInsights once on mount', async () => {
      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      expect(mockGetInsights).toHaveBeenCalledTimes(1);
    });

    it('sets error and clears loading when getInsights rejects', async () => {
      mockGetInsights.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeNull();
    });

    it('sets a generic error message for non-Error rejections', async () => {
      mockGetInsights.mockRejectedValue('something went wrong');

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load insights');
      });
    });

    it('handles an empty-state snapshot (status: empty)', async () => {
      mockGetInsights.mockResolvedValue(emptySnapshot);

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).toEqual(emptySnapshot);
      });

      expect(result.current.error).toBeNull();
    });
  });

  // =========================================================================
  // Manual load()
  // =========================================================================

  describe('load()', () => {
    it('can be called manually to reload data', async () => {
      const { result } = renderHook(() => useInsights());

      // Wait for initial load
      await waitFor(() => {
        expect(result.current.data).toEqual(readySnapshot);
      });

      // Change what the service returns for the second call
      mockGetInsights.mockResolvedValue(emptySnapshot);

      await act(async () => {
        await result.current.load();
      });

      expect(result.current.data).toEqual(emptySnapshot);
      expect(mockGetInsights).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // refresh()
  // =========================================================================

  describe('refresh()', () => {
    it('calls refreshInsights (POST) and updates data with the returned snapshot', async () => {
      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockRefreshInsights).toHaveBeenCalledTimes(1);
      expect(result.current.data).toEqual(freshSnapshot);
    });

    it('sets refreshing=true during the POST and false after', async () => {
      let resolveRefresh!: (v: InsightsSnapshot) => void;
      const pending = new Promise<InsightsSnapshot>((resolve) => {
        resolveRefresh = resolve;
      });
      mockRefreshInsights.mockReturnValue(pending);

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      // Kick off refresh without awaiting
      act(() => {
        void result.current.refresh();
      });

      expect(result.current.refreshing).toBe(true);

      await act(async () => {
        resolveRefresh(freshSnapshot);
        await pending;
      });

      await waitFor(() => {
        expect(result.current.refreshing).toBe(false);
      });
    });

    it('does NOT call getInsights on refresh (uses POST response directly)', async () => {
      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      const callsBeforeRefresh = mockGetInsights.mock.calls.length;

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockGetInsights.mock.calls.length).toBe(callsBeforeRefresh);
    });

    it('sets error when refreshInsights rejects', async () => {
      mockRefreshInsights.mockRejectedValue(new Error('Refresh failed'));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBe('Refresh failed');
      expect(result.current.refreshing).toBe(false);
    });

    it('sets a generic error message for non-Error refresh rejections', async () => {
      mockRefreshInsights.mockRejectedValue('unknown failure');

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBe('Failed to refresh insights');
    });

    it('clears previous error before a successful refresh', async () => {
      // First, cause an error
      mockGetInsights.mockRejectedValueOnce(new Error('Initial load error'));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('Initial load error');
      });

      // Now refresh successfully
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.data).toEqual(freshSnapshot);
    });
  });
});
