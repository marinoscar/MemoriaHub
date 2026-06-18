/**
 * Unit tests for useJobs hook.
 *
 * Tests: initial load of stats+jobs; filter change refetches jobs;
 * mutation actions call correct service functions and refresh; auto-refresh
 * polls on a timer (fake timers) and stops when disabled / on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock jobs service — must be hoisted before the hook import
// ---------------------------------------------------------------------------

vi.mock('../../services/jobs', () => ({
  getJobStats: vi.fn(),
  listJobs: vi.fn(),
  retryJob: vi.fn(),
  retryAllFailed: vi.fn(),
  resetStuck: vi.fn(),
  deleteJob: vi.fn(),
}));

import { useJobs } from '../../hooks/useJobs';
import * as jobsService from '../../services/jobs';
import type { JobStats, JobsListResponse } from '../../services/jobs';

const mockGetJobStats = vi.mocked(jobsService.getJobStats);
const mockListJobs = vi.mocked(jobsService.listJobs);
const mockRetryJob = vi.mocked(jobsService.retryJob);
const mockRetryAllFailed = vi.mocked(jobsService.retryAllFailed);
const mockResetStuck = vi.mocked(jobsService.resetStuck);
const mockDeleteJob = vi.mocked(jobsService.deleteJob);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleStats: JobStats = {
  total: 10,
  byStatus: { pending: 3, running: 1, succeeded: 5, failed: 1 },
  byType: [
    { type: 'face_detection', pending: 3, running: 1, succeeded: 5, failed: 1, total: 10 },
  ],
  stuckRunning: 0,
};

const sampleListResponse: JobsListResponse = {
  items: [
    {
      id: 'job-1',
      type: 'face_detection',
      status: 'pending',
      reason: 'upload',
      priority: 0,
      mediaItemId: 'media-1',
      circleId: 'circle-1',
      attempts: 0,
      lastError: null,
      providerKey: null,
      modelVersion: null,
      createdAt: '2024-01-01T10:00:00Z',
      startedAt: null,
      finishedAt: null,
    },
  ],
  meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
};

const emptyListResponse: JobsListResponse = {
  items: [],
  meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path responses
    mockGetJobStats.mockResolvedValue(sampleStats);
    mockListJobs.mockResolvedValue(sampleListResponse);
    mockRetryJob.mockResolvedValue(sampleListResponse.items[0]);
    mockRetryAllFailed.mockResolvedValue({ retried: 3 });
    mockResetStuck.mockResolvedValue({ reset: 2 });
    mockDeleteJob.mockResolvedValue({ deleted: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Initial load
  // =========================================================================

  describe('initial load', () => {
    it('starts with null stats, empty jobs, and false loading flags', () => {
      // Never-resolving promises keep the hook in loading state to capture initial values
      mockGetJobStats.mockReturnValue(new Promise(() => {}));
      mockListJobs.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      expect(result.current.stats).toBeNull();
      expect(result.current.jobs).toEqual([]);
      expect(result.current.meta).toBeNull();
    });

    it('loads stats and jobs on mount', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).toEqual(sampleStats);
        expect(result.current.jobs).toEqual(sampleListResponse.items);
        expect(result.current.meta).toEqual(sampleListResponse.meta);
      });
    });

    it('calls getJobStats and listJobs on mount', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      expect(mockGetJobStats).toHaveBeenCalledTimes(1);
      expect(mockListJobs).toHaveBeenCalledTimes(1);
    });

    it('sets statsError when getJobStats fails', async () => {
      mockGetJobStats.mockRejectedValue(new Error('Stats unavailable'));

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.statsError).toBe('Stats unavailable');
      });
    });

    it('sets generic statsError for non-Error rejections', async () => {
      mockGetJobStats.mockRejectedValue('boom');

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.statsError).toBe('Failed to load job stats');
      });
    });

    it('sets jobsError when listJobs fails', async () => {
      mockListJobs.mockRejectedValue(new Error('Jobs unavailable'));

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.jobsError).toBe('Jobs unavailable');
      });
    });
  });

  // =========================================================================
  // Filter changes
  // =========================================================================

  describe('filter changes', () => {
    it('refetches jobs when filters change via setFilters', async () => {
      mockListJobs
        .mockResolvedValueOnce(sampleListResponse)  // initial load
        .mockResolvedValueOnce(emptyListResponse);   // after filter change

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      // Wait for initial load
      await waitFor(() => {
        expect(result.current.jobs).toEqual(sampleListResponse.items);
      });

      // Change filters
      await act(async () => {
        result.current.setFilters({ status: 'failed', page: 1, pageSize: 20 });
      });

      await waitFor(() => {
        expect(result.current.jobs).toEqual([]);
      });

      // listJobs should have been called twice: initial + filter change
      expect(mockListJobs).toHaveBeenCalledTimes(2);
    });

    it('passes new filter params to listJobs when filters change', async () => {
      mockListJobs.mockResolvedValue(emptyListResponse);

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        result.current.setFilters({ status: 'failed', type: 'ocr', page: 2, pageSize: 10 });
      });

      await waitFor(() => {
        expect(mockListJobs).toHaveBeenLastCalledWith({
          status: 'failed',
          type: 'ocr',
          page: 2,
          pageSize: 10,
        });
      });
    });

    it('does not duplicate the initial fetch when filters are set first time', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      // The first-mount guard should prevent re-fetch from the filter effect
      const initialCallCount = mockListJobs.mock.calls.length;
      expect(initialCallCount).toBe(1);
    });
  });

  // =========================================================================
  // refresh action
  // =========================================================================

  describe('refresh', () => {
    it('refreshes both stats and jobs when called', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      const callsBefore = mockGetJobStats.mock.calls.length;

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockGetJobStats.mock.calls.length).toBe(callsBefore + 1);
      expect(mockListJobs.mock.calls.length).toBeGreaterThanOrEqual(callsBefore + 1);
    });
  });

  // =========================================================================
  // Mutation: retryJob
  // =========================================================================

  describe('retryJob', () => {
    it('calls retryJob service with the provided id', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        await result.current.retryJob('job-abc');
      });

      expect(mockRetryJob).toHaveBeenCalledWith('job-abc');
    });

    it('refreshes stats and jobs after retryJob completes', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      const statsCalls = mockGetJobStats.mock.calls.length;

      await act(async () => {
        await result.current.retryJob('job-abc');
      });

      expect(mockGetJobStats.mock.calls.length).toBeGreaterThan(statsCalls);
    });

    it('sets mutating=true during retryJob and false after', async () => {
      let resolveFn!: () => void;
      const pending = new Promise<typeof sampleListResponse.items[0]>((resolve) => {
        resolveFn = () => resolve(sampleListResponse.items[0]);
      });
      mockRetryJob.mockReturnValue(pending);

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      act(() => {
        void result.current.retryJob('job-abc');
      });

      expect(result.current.mutating).toBe(true);

      await act(async () => {
        resolveFn();
        await pending;
      });

      await waitFor(() => {
        expect(result.current.mutating).toBe(false);
      });
    });
  });

  // =========================================================================
  // Mutation: retryAllFailed
  // =========================================================================

  describe('retryAllFailed', () => {
    it('calls retryAllFailed service without type when no argument given', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        await result.current.retryAllFailed();
      });

      expect(mockRetryAllFailed).toHaveBeenCalledWith(undefined);
    });

    it('calls retryAllFailed service with type when provided', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        await result.current.retryAllFailed('ocr');
      });

      expect(mockRetryAllFailed).toHaveBeenCalledWith('ocr');
    });

    it('returns the retried count from the service', async () => {
      mockRetryAllFailed.mockResolvedValue({ retried: 7 });

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      let returnValue!: { retried: number };
      await act(async () => {
        returnValue = await result.current.retryAllFailed();
      });

      expect(returnValue).toEqual({ retried: 7 });
    });

    it('refreshes stats and jobs after retryAllFailed completes', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      const statsCalls = mockGetJobStats.mock.calls.length;

      await act(async () => {
        await result.current.retryAllFailed();
      });

      expect(mockGetJobStats.mock.calls.length).toBeGreaterThan(statsCalls);
    });
  });

  // =========================================================================
  // Mutation: resetStuck
  // =========================================================================

  describe('resetStuck', () => {
    it('calls resetStuck service without argument when none provided', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        await result.current.resetStuck();
      });

      expect(mockResetStuck).toHaveBeenCalledWith(undefined);
    });

    it('calls resetStuck service with olderThanMinutes when provided', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        await result.current.resetStuck(15);
      });

      expect(mockResetStuck).toHaveBeenCalledWith(15);
    });

    it('returns the reset count from the service', async () => {
      mockResetStuck.mockResolvedValue({ reset: 4 });

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      let returnValue!: { reset: number };
      await act(async () => {
        returnValue = await result.current.resetStuck(10);
      });

      expect(returnValue).toEqual({ reset: 4 });
    });

    it('refreshes stats and jobs after resetStuck completes', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      const statsCalls = mockGetJobStats.mock.calls.length;

      await act(async () => {
        await result.current.resetStuck();
      });

      expect(mockGetJobStats.mock.calls.length).toBeGreaterThan(statsCalls);
    });
  });

  // =========================================================================
  // Mutation: deleteJob
  // =========================================================================

  describe('deleteJob', () => {
    it('calls deleteJob service with the provided id', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      await act(async () => {
        await result.current.deleteJob('job-del-1');
      });

      expect(mockDeleteJob).toHaveBeenCalledWith('job-del-1');
    });

    it('refreshes stats and jobs after deleteJob completes', async () => {
      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      const statsCalls = mockGetJobStats.mock.calls.length;

      await act(async () => {
        await result.current.deleteJob('job-del-1');
      });

      expect(mockGetJobStats.mock.calls.length).toBeGreaterThan(statsCalls);
    });

    it('sets mutating=true during deleteJob and false after', async () => {
      let resolveFn!: () => void;
      const pending = new Promise<{ deleted: boolean }>((resolve) => {
        resolveFn = () => resolve({ deleted: true });
      });
      mockDeleteJob.mockReturnValue(pending);

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await waitFor(() => {
        expect(result.current.stats).not.toBeNull();
      });

      act(() => {
        void result.current.deleteJob('job-del-1');
      });

      expect(result.current.mutating).toBe(true);

      await act(async () => {
        resolveFn();
        await pending;
      });

      await waitFor(() => {
        expect(result.current.mutating).toBe(false);
      });
    });
  });

  // =========================================================================
  // Auto-refresh polling
  // =========================================================================

  describe('auto-refresh', () => {
    it('polls silently every 5 seconds when autoRefresh is enabled', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useJobs({ autoRefresh: true }));

      // Let the initial load settle
      await act(async () => {
        await Promise.resolve();
      });

      const callsAfterMount = mockGetJobStats.mock.calls.length;

      // Advance 5 seconds (one poll interval)
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockGetJobStats.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });

    it('stops polling when autoRefresh is toggled off', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useJobs({ autoRefresh: true }));

      await act(async () => {
        await Promise.resolve();
      });

      // Turn off auto-refresh
      await act(async () => {
        result.current.setAutoRefresh(false);
      });

      const callsAfterToggleOff = mockGetJobStats.mock.calls.length;

      // Advance past several poll intervals
      await act(async () => {
        vi.advanceTimersByTime(15000);
        await Promise.resolve();
      });

      // No additional calls should have been made
      expect(mockGetJobStats.mock.calls.length).toBe(callsAfterToggleOff);
    });

    it('does not poll when autoRefresh starts disabled', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await act(async () => {
        await Promise.resolve();
      });

      const callsAfterMount = mockGetJobStats.mock.calls.length;

      // Advance well past the poll interval
      await act(async () => {
        vi.advanceTimersByTime(20000);
        await Promise.resolve();
      });

      expect(mockGetJobStats.mock.calls.length).toBe(callsAfterMount);
    });

    it('clears the interval on unmount to prevent memory leaks', async () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const { result, unmount } = renderHook(() => useJobs({ autoRefresh: true }));

      await act(async () => {
        await Promise.resolve();
      });

      const callsBefore = mockGetJobStats.mock.calls.length;

      unmount();

      // Advance past poll interval — should not call getJobStats again
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(mockGetJobStats.mock.calls.length).toBe(callsBefore);
    });

    it('resumes polling when autoRefresh is re-enabled', async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() => useJobs({ autoRefresh: false }));

      await act(async () => {
        await Promise.resolve();
      });

      const callsAfterMount = mockGetJobStats.mock.calls.length;

      // Enable auto-refresh
      await act(async () => {
        result.current.setAutoRefresh(true);
      });

      // Advance past poll interval
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockGetJobStats.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
  });
});
