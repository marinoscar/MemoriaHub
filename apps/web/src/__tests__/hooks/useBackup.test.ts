import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// Mock the backup service module
vi.mock('../../services/backup', () => ({
  triggerBackup: vi.fn(),
  listBackupRuns: vi.fn(),
  getBackupRun: vi.fn(),
}));

import { useBackup } from '../../hooks/useBackup';
import * as backupService from '../../services/backup';
import type { BackupRun, BackupRunResult } from '../../services/backup';

const mockListBackupRuns = vi.mocked(backupService.listBackupRuns);
const mockTriggerBackup = vi.mocked(backupService.triggerBackup);

const sampleRun: BackupRun = {
  runId: 'run-abc',
  scope: 'all',
  copied: 10,
  skipped: 2,
  failed: 0,
  errors: [],
  startedAt: new Date('2024-01-15T10:00:00Z').toISOString(),
  completedAt: new Date('2024-01-15T10:01:00Z').toISOString(),
};

const sampleResult: BackupRunResult = {
  runId: 'run-abc',
  scope: 'all',
  copied: 10,
  skipped: 2,
  failed: 0,
  errors: [],
};

describe('useBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: list returns empty array
    mockListBackupRuns.mockResolvedValue([]);
    mockTriggerBackup.mockResolvedValue(sampleResult);
  });

  it('starts with empty runs and no error', () => {
    const { result } = renderHook(() => useBackup());

    expect(result.current.runs).toEqual([]);
    expect(result.current.runsLoading).toBe(false);
    expect(result.current.runsError).toBeNull();
    expect(result.current.running).toBe(false);
    expect(result.current.runResult).toBeNull();
    expect(result.current.runError).toBeNull();
  });

  describe('refreshRuns', () => {
    it('fetches runs from service and updates state', async () => {
      mockListBackupRuns.mockResolvedValue([sampleRun]);

      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.refreshRuns();
      });

      await waitFor(() => {
        expect(result.current.runs).toEqual([sampleRun]);
      });

      expect(mockListBackupRuns).toHaveBeenCalledTimes(1);
    });

    it('sets runsLoading to true during fetch and false after', async () => {
      let resolvePromise!: (value: BackupRun[]) => void;
      const pendingPromise = new Promise<BackupRun[]>((resolve) => {
        resolvePromise = resolve;
      });
      mockListBackupRuns.mockReturnValue(pendingPromise);

      const { result } = renderHook(() => useBackup());

      // Start the fetch without awaiting
      act(() => {
        void result.current.refreshRuns();
      });

      // Should be loading while promise is pending
      expect(result.current.runsLoading).toBe(true);

      // Resolve the promise
      await act(async () => {
        resolvePromise([sampleRun]);
        await pendingPromise;
      });

      await waitFor(() => {
        expect(result.current.runsLoading).toBe(false);
        expect(result.current.runs).toEqual([sampleRun]);
      });
    });

    it('sets runsError when fetch fails', async () => {
      mockListBackupRuns.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.refreshRuns();
      });

      await waitFor(() => {
        expect(result.current.runsError).toBe('Network error');
        expect(result.current.runsLoading).toBe(false);
      });
    });

    it('sets generic runsError for non-Error rejections', async () => {
      mockListBackupRuns.mockRejectedValue('something bad');

      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.refreshRuns();
      });

      await waitFor(() => {
        expect(result.current.runsError).toBe('Failed to load backup runs');
      });
    });
  });

  describe('triggerBackup', () => {
    it('calls triggerBackup service and then refreshes runs', async () => {
      mockListBackupRuns.mockResolvedValue([sampleRun]);

      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.triggerBackup({ all: true });
      });

      expect(mockTriggerBackup).toHaveBeenCalledWith({ all: true });
      // refreshRuns is called internally after trigger
      expect(mockListBackupRuns).toHaveBeenCalledTimes(1);
    });

    it('sets runResult after successful trigger', async () => {
      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.triggerBackup({ all: true });
      });

      await waitFor(() => {
        expect(result.current.runResult).toEqual(sampleResult);
        expect(result.current.running).toBe(false);
      });
    });

    it('sets running to true during execution and false after', async () => {
      let resolvePromise!: (value: BackupRunResult) => void;
      const pendingPromise = new Promise<BackupRunResult>((resolve) => {
        resolvePromise = resolve;
      });
      mockTriggerBackup.mockReturnValue(pendingPromise);

      const { result } = renderHook(() => useBackup());

      // Start without awaiting
      act(() => {
        void result.current.triggerBackup({ all: true });
      });

      expect(result.current.running).toBe(true);

      await act(async () => {
        resolvePromise(sampleResult);
        await pendingPromise;
      });

      await waitFor(() => {
        expect(result.current.running).toBe(false);
      });
    });

    it('sets runError when triggerBackup fails', async () => {
      mockTriggerBackup.mockRejectedValue(new Error('Backup connection refused'));

      const { result } = renderHook(() => useBackup());

      await act(async () => {
        try {
          await result.current.triggerBackup({ all: true });
        } catch {
          // the hook rethrows
        }
      });

      await waitFor(() => {
        expect(result.current.runError).toBe('Backup connection refused');
        expect(result.current.running).toBe(false);
        expect(result.current.runResult).toBeNull();
      });
    });

    it('sets generic runError for non-Error rejections', async () => {
      mockTriggerBackup.mockRejectedValue('unknown failure');

      const { result } = renderHook(() => useBackup());

      await act(async () => {
        try {
          await result.current.triggerBackup({ all: true });
        } catch {
          // the hook rethrows
        }
      });

      await waitFor(() => {
        expect(result.current.runError).toBe('Backup failed');
      });
    });

    it('clears previous runResult before starting a new trigger', async () => {
      // First successful run
      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.triggerBackup({ all: true });
      });

      expect(result.current.runResult).toEqual(sampleResult);

      // Now trigger a failing run
      mockTriggerBackup.mockRejectedValue(new Error('failed'));

      await act(async () => {
        try {
          await result.current.triggerBackup({ all: true });
        } catch {
          // expected
        }
      });

      // runResult should be cleared (set to null at start of trigger)
      await waitFor(() => {
        expect(result.current.runResult).toBeNull();
      });
    });

    it('passes circleId to service when scope is a specific circle', async () => {
      const { result } = renderHook(() => useBackup());

      await act(async () => {
        await result.current.triggerBackup({ circleId: 'circle-xyz' });
      });

      expect(mockTriggerBackup).toHaveBeenCalledWith({ circleId: 'circle-xyz' });
    });
  });
});
