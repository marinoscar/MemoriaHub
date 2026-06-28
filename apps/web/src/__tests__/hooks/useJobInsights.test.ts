/**
 * Unit tests for useJobInsights hook.
 *
 * Tests:
 *   - Calls getJobInsights once on mount (initial load)
 *   - Sets data and clears loading after successful fetch
 *   - Sets error when fetch rejects, clears after refresh
 *   - refresh() re-fetches without additional arguments when windowDays unchanged
 *   - Does NOT poll (fake timers advance without triggering extra calls)
 *   - Passes windowDays to getJobInsights when provided
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the jobInsights service — must be hoisted before hook import
// ---------------------------------------------------------------------------

vi.mock('../../services/jobInsights', () => ({
  getJobInsights: vi.fn(),
}));

import { useJobInsights } from '../../hooks/useJobInsights';
import * as jobInsightsService from '../../services/jobInsights';
import type { JobInsights } from '../../services/jobInsights';

const mockGetJobInsights = vi.mocked(jobInsightsService.getJobInsights);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleInsights: JobInsights = {
  computedAt: '2025-06-20T10:00:00.000Z',
  windowDays: 7,
  concurrency: 1,
  live: {
    total: 15,
    byStatus: { pending: 5, running: 2, succeeded: 7, failed: 1 },
    pending: 5,
    running: 2,
    failed: 1,
    scheduled: 0,
    rateLimited: 0,
    retried: 3,
    byType: [
      { type: 'face_detection', pending: 5, running: 2, succeeded: 7, failed: 1, total: 15 },
    ],
  },
  history: {
    overall: { samples: 100, avgMs: 2000, p50Ms: 1800, p95Ms: 4500, throughputPerMin: 1.5 },
    byType: [
      { type: 'face_detection', samples: 100, avgMs: 2000, p50Ms: 1800, p95Ms: 4500, throughputPerMin: 1.5 },
    ],
  },
  eta: {
    totalRemaining: 7,
    etaMs: 14000,
    basis: 'live',
    perType: [
      { type: 'face_detection', remaining: 7, avgMs: 2000, etcMs: 14000 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useJobInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJobInsights.mockResolvedValue(sampleInsights);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Initial load
  // =========================================================================

  describe('initial load', () => {
    it('starts with loading=true and data=null', () => {
      // Use a never-resolving promise to capture the initial state
      mockGetJobInsights.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useJobInsights());

      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeNull();
    });

    it('calls getJobInsights exactly once on mount', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockGetJobInsights).toHaveBeenCalledTimes(1);
    });

    it('sets data after a successful fetch', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.data).toEqual(sampleInsights);
      });
    });

    it('sets loading=false after a successful fetch', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('starts with error=null', () => {
      mockGetJobInsights.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useJobInsights());

      expect(result.current.error).toBeNull();
    });
  });

  // =========================================================================
  // windowDays
  // =========================================================================

  describe('windowDays parameter', () => {
    it('passes windowDays to getJobInsights when provided', async () => {
      const { result } = renderHook(() => useJobInsights(14));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockGetJobInsights).toHaveBeenCalledWith(14);
    });

    it('passes undefined to getJobInsights when windowDays is not provided', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockGetJobInsights).toHaveBeenCalledWith(undefined);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('sets error message when getJobInsights rejects with an Error', async () => {
      mockGetJobInsights.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });
    });

    it('sets generic error message for non-Error rejections', async () => {
      mockGetJobInsights.mockRejectedValue('something bad');

      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to load job insights');
      });
    });

    it('sets loading=false after rejection', async () => {
      mockGetJobInsights.mockRejectedValue(new Error('Server 500'));

      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('leaves data=null after a rejection', async () => {
      mockGetJobInsights.mockRejectedValue(new Error('Server 500'));

      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.data).toBeNull();
    });
  });

  // =========================================================================
  // refresh()
  // =========================================================================

  describe('refresh()', () => {
    it('calls getJobInsights again when refresh() is invoked', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const callsBefore = mockGetJobInsights.mock.calls.length;

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockGetJobInsights.mock.calls.length).toBe(callsBefore + 1);
    });

    it('updates data after refresh() succeeds', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.data).toEqual(sampleInsights);
      });

      const updatedInsights: JobInsights = {
        ...sampleInsights,
        computedAt: '2025-06-20T11:00:00.000Z',
        live: { ...sampleInsights.live, pending: 0, running: 0, total: 8 },
      };
      mockGetJobInsights.mockResolvedValue(updatedInsights);

      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.data?.computedAt).toBe('2025-06-20T11:00:00.000Z');
      });
    });

    it('clears error after a successful refresh', async () => {
      mockGetJobInsights.mockRejectedValueOnce(new Error('First error'));

      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('First error');
      });

      mockGetJobInsights.mockResolvedValue(sampleInsights);

      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });

    it('sets loading=true during refresh and false after', async () => {
      const { result } = renderHook(() => useJobInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      let resolveRefresh!: (v: JobInsights) => void;
      const pending = new Promise<JobInsights>((r) => { resolveRefresh = r; });
      mockGetJobInsights.mockReturnValue(pending);

      act(() => {
        void result.current.refresh();
      });

      // Should be loading while refresh is in flight
      expect(result.current.loading).toBe(true);

      await act(async () => {
        resolveRefresh(sampleInsights);
        await pending;
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });
  });

  // =========================================================================
  // No polling
  // =========================================================================

  describe('no polling', () => {
    it('does NOT call getJobInsights again after time passes (no interval)', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useJobInsights());

      // Let the mount fetch settle
      await act(async () => {
        await Promise.resolve();
      });

      const callsAfterMount = mockGetJobInsights.mock.calls.length;

      // Advance 60 seconds — no interval should trigger
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      expect(mockGetJobInsights.mock.calls.length).toBe(callsAfterMount);
    });

    it('does NOT call getJobInsights after unmount when timers advance', async () => {
      vi.useFakeTimers();

      const { unmount, result } = renderHook(() => useJobInsights());

      await act(async () => {
        await Promise.resolve();
      });

      const callsBeforeUnmount = mockGetJobInsights.mock.calls.length;

      unmount();

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      expect(mockGetJobInsights.mock.calls.length).toBe(callsBeforeUnmount);
    });
  });
});
