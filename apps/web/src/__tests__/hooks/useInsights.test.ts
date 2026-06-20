/**
 * Unit tests for the useInsights hook.
 *
 * Tests: initial load; auto-start polling when page opens with pending/running job;
 * manual refresh() enqueues then polls; polling stops when idle/failed;
 * failed state surfaces lastError; cleanup on unmount; error paths.
 *
 * services/insights is mocked — no HTTP needed.
 *
 * Strategy: real timers for all non-polling tests (safe with waitFor).
 * Polling-specific tests activate vi.useFakeTimers({ shouldAdvanceTime: true })
 * per-test so that waitFor's internal setInterval still ticks while we
 * deterministically control vi.advanceTimersByTime for the 2.5 s poll interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function makeSnapshot(overrides: Partial<InsightsSnapshot> = {}): InsightsSnapshot {
  return {
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
    refresh: { state: 'idle', jobId: null, lastError: null },
    ...overrides,
  };
}

const readySnapshot = makeSnapshot();

const emptySnapshot: InsightsSnapshot = {
  status: 'empty',
  metrics: null,
  computedAt: null,
  durationMs: null,
  refresh: { state: 'idle', jobId: null, lastError: null },
};

const pendingSnapshot = makeSnapshot({
  refresh: { state: 'pending', jobId: 'job-1', lastError: null },
});

const runningSnapshot = makeSnapshot({
  refresh: { state: 'running', jobId: 'job-1', lastError: null },
});

const freshSnapshot = makeSnapshot({
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
  refresh: { state: 'idle', jobId: null, lastError: null },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    mockGetInsights.mockResolvedValue(readySnapshot);
    mockRefreshInsights.mockResolvedValue({ jobId: 'job-1', state: 'pending' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Initial load
  // =========================================================================

  describe('initial load', () => {
    it('starts with null data before mount resolves', () => {
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
  // Auto-start polling on load when state is pending/running
  // =========================================================================

  describe('auto-start polling when initial load returns pending/running job', () => {
    it('starts polling when initial load returns state=pending', async () => {
      // shouldAdvanceTime=true: fake clock advances at real wall-clock rate,
      // so waitFor's internal setInterval still fires.
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockGetInsights
        .mockResolvedValueOnce(pendingSnapshot)
        .mockResolvedValueOnce(freshSnapshot);

      const { result } = renderHook(() => useInsights());

      // Let the initial load settle
      await act(async () => { await Promise.resolve(); });

      // Initial data is pending, polling has started
      await waitFor(() => {
        expect(result.current.data?.refresh.state).toBe('pending');
      });
      expect(result.current.refreshing).toBe(true);

      // Advance 2.5 s to fire the first poll tick
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });

      await waitFor(() => {
        expect(result.current.data).toEqual(freshSnapshot);
        expect(result.current.refreshing).toBe(false);
      });
    });

    it('starts polling when initial load returns state=running', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockGetInsights
        .mockResolvedValueOnce(runningSnapshot)
        .mockResolvedValueOnce(freshSnapshot);

      const { result } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });

      await waitFor(() => {
        expect(result.current.refreshing).toBe(true);
      });

      await act(async () => {
        vi.advanceTimersByTime(2500);
      });

      await waitFor(() => {
        expect(result.current.data).toEqual(freshSnapshot);
        expect(result.current.refreshing).toBe(false);
      });
    });

    it('does NOT start polling when initial load returns state=idle', async () => {
      // readySnapshot has state=idle; no polling should begin
      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      expect(result.current.refreshing).toBe(false);
      expect(mockGetInsights).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Manual load()
  // =========================================================================

  describe('load()', () => {
    it('can be called manually to reload data', async () => {
      // Use idle snapshot to prevent polling from running
      mockGetInsights.mockResolvedValue(readySnapshot);

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data?.refresh.state).toBe('idle');
      });

      mockGetInsights.mockResolvedValue(emptySnapshot);

      await act(async () => {
        await result.current.load();
      });

      expect(result.current.data?.status).toBe('empty');
      expect(mockGetInsights).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // refresh()
  // =========================================================================

  describe('refresh()', () => {
    it('calls refreshInsights (POST) then starts polling', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockGetInsights
        .mockResolvedValueOnce(readySnapshot)  // initial load
        .mockResolvedValueOnce(freshSnapshot); // first poll tick returns idle

      const { result } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });

      await waitFor(() => {
        expect(result.current.data).toEqual(readySnapshot);
      });

      // Trigger manual refresh
      act(() => { void result.current.refresh(); });

      await act(async () => { await Promise.resolve(); });

      expect(mockRefreshInsights).toHaveBeenCalledTimes(1);
      expect(result.current.refreshing).toBe(true);

      // Advance poll interval so the tick fires
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });

      await waitFor(() => {
        expect(result.current.data).toEqual(freshSnapshot);
        expect(result.current.refreshing).toBe(false);
      });
    });

    it('stays refreshing through multiple poll ticks until idle', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockGetInsights
        .mockResolvedValueOnce(readySnapshot)
        .mockResolvedValueOnce(pendingSnapshot) // first tick: still pending
        .mockResolvedValueOnce(freshSnapshot);  // second tick: idle

      const { result } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });
      await waitFor(() => { expect(result.current.data).not.toBeNull(); });

      act(() => { void result.current.refresh(); });
      await act(async () => { await Promise.resolve(); });

      expect(result.current.refreshing).toBe(true);

      // First tick — still pending
      await act(async () => { vi.advanceTimersByTime(2500); });
      await waitFor(() => {
        expect(result.current.data?.refresh.state).toBe('pending');
      });
      expect(result.current.refreshing).toBe(true);

      // Second tick — now idle
      await act(async () => { vi.advanceTimersByTime(2500); });
      await waitFor(() => {
        expect(result.current.refreshing).toBe(false);
        expect(result.current.data).toEqual(freshSnapshot);
      });
    });

    it('stops polling when state transitions to failed and surfaces lastError', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const failedSnapshot = makeSnapshot({
        refresh: { state: 'failed', jobId: 'job-1', lastError: 'DB connection lost' },
      });

      mockGetInsights
        .mockResolvedValueOnce(readySnapshot)
        .mockResolvedValueOnce(failedSnapshot);

      const { result } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });
      await waitFor(() => { expect(result.current.data).not.toBeNull(); });

      act(() => { void result.current.refresh(); });
      await act(async () => { await Promise.resolve(); });

      await act(async () => { vi.advanceTimersByTime(2500); });

      await waitFor(() => {
        expect(result.current.refreshing).toBe(false);
        expect(result.current.error).toBe('DB connection lost');
        expect(result.current.jobState).toBe('failed');
      });
    });

    it('sets error when refreshInsights (POST) rejects', async () => {
      mockRefreshInsights.mockRejectedValue(new Error('Refresh failed'));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Refresh failed');
        expect(result.current.refreshing).toBe(false);
      });
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

      await waitFor(() => {
        expect(result.current.error).toBe('Failed to start refresh');
      });
    });

    it('clears error before calling refreshInsights', async () => {
      // Cause an initial load error
      mockGetInsights.mockRejectedValueOnce(new Error('Initial load error'));
      // Make subsequent getInsights (for polling) succeed
      mockGetInsights.mockResolvedValue(freshSnapshot);

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.error).toBe('Initial load error');
      });

      // refresh() calls setError(null) immediately at entry
      act(() => { void result.current.refresh(); });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });
  });

  // =========================================================================
  // jobState derived value
  // =========================================================================

  describe('jobState', () => {
    it('returns "idle" when data is null', () => {
      mockGetInsights.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useInsights());

      expect(result.current.jobState).toBe('idle');
    });

    it('returns "idle" when data has refresh.state=idle', async () => {
      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      expect(result.current.jobState).toBe('idle');
    });

    it('returns "pending" when data has refresh.state=pending', async () => {
      // pendingSnapshot starts polling; use fake timers to freeze the interval
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockGetInsights.mockResolvedValue(pendingSnapshot);

      const { result } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });

      await waitFor(() => {
        expect(result.current.data).not.toBeNull();
      });

      expect(result.current.jobState).toBe('pending');
    });
  });

  // =========================================================================
  // Cleanup on unmount
  // =========================================================================

  describe('cleanup on unmount', () => {
    it('clears poll interval and safety timeout on unmount', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      mockGetInsights.mockResolvedValue(pendingSnapshot);

      const { unmount } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });
      await waitFor(() => expect(mockGetInsights).toHaveBeenCalledTimes(1));

      unmount();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('stops calling getInsights after unmount', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      mockGetInsights.mockResolvedValue(pendingSnapshot);

      const { unmount } = renderHook(() => useInsights());

      await act(async () => { await Promise.resolve(); });
      await waitFor(() => expect(mockGetInsights).toHaveBeenCalledTimes(1));

      const callsAtUnmount = mockGetInsights.mock.calls.length;
      unmount();

      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      expect(mockGetInsights.mock.calls.length).toBe(callsAtUnmount);
    });
  });
});
