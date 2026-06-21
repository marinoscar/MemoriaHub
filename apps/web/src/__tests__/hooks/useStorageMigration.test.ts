import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock the service module BEFORE importing the hook
// ---------------------------------------------------------------------------

vi.mock('../../services/storage-providers', () => ({
  triggerMigration: vi.fn(),
  listMigrationRuns: vi.fn(),
  getMigrationRun: vi.fn(),
  cancelMigration: vi.fn(),
  // other exports the hook doesn't use
  getStorageSettings: vi.fn(),
  getStorageProviderDescriptors: vi.fn(),
  putStorageCredentials: vi.fn(),
  deleteStorageCredentials: vi.fn(),
  testStorageProvider: vi.fn(),
  setActiveStorageProvider: vi.fn(),
}));

import { useStorageMigration } from '../../hooks/useStorageMigration';
import * as storageService from '../../services/storage-providers';
import type { MigrationRun } from '../../services/storage-providers';

const mockTriggerMigration = vi.mocked(storageService.triggerMigration);
const mockListMigrationRuns = vi.mocked(storageService.listMigrationRuns);
const mockGetMigrationRun = vi.mocked(storageService.getMigrationRun);
const mockCancelMigration = vi.mocked(storageService.cancelMigration);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeMigrationRun(overrides: Partial<MigrationRun> = {}): MigrationRun {
  return {
    id: 'run-1',
    sourceProvider: 's3',
    targetProvider: 'r2',
    status: 'running',
    totalCount: 100,
    migratedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedAt: '2024-01-01T00:00:00Z',
    finishedAt: null,
    lastError: null,
    ...overrides,
  };
}

const emptyRunsResponse = { items: [], meta: { page: 1, pageSize: 20, total: 0 } };

// ---------------------------------------------------------------------------

describe('useStorageMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: list returns empty
    mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts with empty runs, no error, no active run', async () => {
      const { result } = renderHook(() => useStorageMigration());

      // Wait for initial load (refresh fires on mount)
      await waitFor(() => {
        expect(mockListMigrationRuns).toHaveBeenCalledTimes(1);
      });

      expect(result.current.runs).toEqual([]);
      expect(result.current.runsError).toBeNull();
      expect(result.current.activeRun).toBeNull();
      expect(result.current.starting).toBe(false);
    });

    it('exposes all action functions', () => {
      const { result } = renderHook(() => useStorageMigration());

      expect(typeof result.current.startMigration).toBe('function');
      expect(typeof result.current.cancel).toBe('function');
      expect(typeof result.current.refresh).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  describe('startMigration', () => {
    it('sets activeRun after triggering and fetching the run', async () => {
      const run = makeMigrationRun();
      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun.mockResolvedValue(run);
      mockListMigrationRuns
        .mockResolvedValueOnce(emptyRunsResponse)  // initial load
        .mockResolvedValue({ items: [run], meta: { page: 1, pageSize: 20, total: 1 } });

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      expect(mockTriggerMigration).toHaveBeenCalledWith({ sourceProvider: 's3', targetProvider: 'r2' });
      expect(mockGetMigrationRun).toHaveBeenCalledWith('run-1');
      expect(result.current.activeRun).toEqual(run);
    });

    it('sets starting to true while in-flight and false after', async () => {
      let resolveTrigger!: (v: { runId: string; totalCount: number }) => void;
      const pendingTrigger = new Promise<{ runId: string; totalCount: number }>((res) => {
        resolveTrigger = res;
      });
      mockTriggerMigration.mockReturnValue(pendingTrigger);
      mockGetMigrationRun.mockResolvedValue(makeMigrationRun());
      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      act(() => {
        void result.current.startMigration('s3', 'r2');
      });

      expect(result.current.starting).toBe(true);

      await act(async () => {
        resolveTrigger({ runId: 'run-1', totalCount: 100 });
        await pendingTrigger;
      });

      await waitFor(() => {
        expect(result.current.starting).toBe(false);
      });
    });

    it('populates runs list after starting', async () => {
      const run = makeMigrationRun();
      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun.mockResolvedValue(run);
      mockListMigrationRuns
        .mockResolvedValueOnce(emptyRunsResponse)
        .mockResolvedValue({ items: [run], meta: { page: 1, pageSize: 20, total: 1 } });

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      expect(result.current.runs).toHaveLength(1);
      expect(result.current.runs[0].id).toBe('run-1');
    });
  });

  // -------------------------------------------------------------------------
  describe('polling behaviour (fake timers)', () => {
    it('calls getMigrationRun every 5 seconds while activeRun is in-flight', async () => {
      vi.useFakeTimers();

      const runningRun = makeMigrationRun({ status: 'running' });
      const updatedRun = makeMigrationRun({ status: 'running', migratedCount: 25 });

      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      // First getMigrationRun from startMigration; subsequent ones from the poll
      mockGetMigrationRun
        .mockResolvedValueOnce(runningRun)   // called in startMigration
        .mockResolvedValue(updatedRun);       // called by poll

      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      // Wait for initial load
      await act(async () => {
        await Promise.resolve();
      });

      // Start migration
      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      expect(result.current.activeRun?.status).toBe('running');
      const callsAfterStart = mockGetMigrationRun.mock.calls.length;

      // Advance 5 seconds → one poll
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockGetMigrationRun.mock.calls.length).toBeGreaterThan(callsAfterStart);
    });

    it('stops polling when status becomes completed and clears activeRun', async () => {
      vi.useFakeTimers();

      const runningRun = makeMigrationRun({ status: 'running' });
      const completedRun = makeMigrationRun({ status: 'completed', migratedCount: 100, finishedAt: '2024-01-01T01:00:00Z' });

      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun
        .mockResolvedValueOnce(runningRun)  // startMigration's immediate fetch
        .mockResolvedValue(completedRun);    // poll → terminal

      mockListMigrationRuns.mockResolvedValue({ items: [completedRun], meta: { page: 1, pageSize: 20, total: 1 } });

      const { result } = renderHook(() => useStorageMigration());

      // Flush initial refresh
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Start migration
      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      expect(result.current.activeRun?.status).toBe('running');
      const callsAfterStart = mockGetMigrationRun.mock.calls.length;

      // Advance exactly 5s — triggers the interval callback once, then flushes the async chain
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // Completed is terminal → hook clears activeRun
      expect(result.current.activeRun).toBeNull();

      const callCountAfterTerminal = mockGetMigrationRun.mock.calls.length;
      expect(callCountAfterTerminal).toBeGreaterThan(callsAfterStart);

      // Advance another 5s — interval was cleared because activeRun became null
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockGetMigrationRun.mock.calls.length).toBe(callCountAfterTerminal);
    });

    it('stops polling when status becomes failed', async () => {
      vi.useFakeTimers();

      const runningRun = makeMigrationRun({ status: 'running' });
      const failedRun = makeMigrationRun({ status: 'failed', lastError: 'S3 error' });

      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun
        .mockResolvedValueOnce(runningRun)
        .mockResolvedValue(failedRun);

      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      expect(result.current.activeRun?.status).toBe('running');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(result.current.activeRun).toBeNull();

      const callCount = mockGetMigrationRun.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockGetMigrationRun.mock.calls.length).toBe(callCount);
    });

    it('stops polling when status becomes cancelled', async () => {
      vi.useFakeTimers();

      const runningRun = makeMigrationRun({ status: 'running' });
      const cancelledRun = makeMigrationRun({ status: 'cancelled' });

      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun
        .mockResolvedValueOnce(runningRun)
        .mockResolvedValue(cancelledRun);

      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      expect(result.current.activeRun?.status).toBe('running');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(result.current.activeRun).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('cancel()', () => {
    it('calls cancelMigration with the active run ID', async () => {
      const runningRun = makeMigrationRun({ status: 'running' });
      const cancelledRun = makeMigrationRun({ status: 'cancelled' });

      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun.mockResolvedValue(runningRun);
      mockCancelMigration.mockResolvedValue(cancelledRun);
      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      await act(async () => {
        await result.current.cancel();
      });

      expect(mockCancelMigration).toHaveBeenCalledWith('run-1');
    });

    it('clears activeRun after cancellation (cancelled is a terminal status)', async () => {
      const runningRun = makeMigrationRun({ status: 'running' });
      const cancelledRun = makeMigrationRun({ status: 'cancelled' });

      mockTriggerMigration.mockResolvedValue({ runId: 'run-1', totalCount: 100 });
      mockGetMigrationRun.mockResolvedValue(runningRun);
      mockCancelMigration.mockResolvedValue(cancelledRun);
      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.startMigration('s3', 'r2');
      });

      await act(async () => {
        await result.current.cancel();
      });

      // The hook sets activeRun = cancelledRun, then the polling useEffect sees
      // a terminal status and immediately calls setActiveRun(null). Either the
      // transient cancelled state or null is correct here — wait for the final null.
      await waitFor(() => {
        expect(result.current.activeRun).toBeNull();
      });
    });

    it('is a no-op when there is no active run', async () => {
      mockListMigrationRuns.mockResolvedValue(emptyRunsResponse);

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.cancel();
      });

      expect(mockCancelMigration).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('refresh()', () => {
    it('fetches run list and updates state', async () => {
      const run = makeMigrationRun({ status: 'completed' });
      mockListMigrationRuns
        .mockResolvedValueOnce(emptyRunsResponse)   // initial load
        .mockResolvedValueOnce({ items: [run], meta: { page: 1, pageSize: 20, total: 1 } });

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.runs).toHaveLength(1);
      expect(result.current.runs[0].status).toBe('completed');
    });

    it('sets runsError on failure', async () => {
      mockListMigrationRuns
        .mockResolvedValueOnce(emptyRunsResponse)
        .mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useStorageMigration());

      await waitFor(() => expect(mockListMigrationRuns).toHaveBeenCalledTimes(1));

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.runsError).toBe('Network error');
    });
  });
});
