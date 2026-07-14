/**
 * Unit tests for InsightsRefreshTask.
 *
 * Verifies the time-gate logic: enqueueRefresh() is only called when the last
 * snapshot is stale (or absent) and no refresh is already in flight.
 * Tests the configurable interval, the default of 4 hours, and the early-exit
 * when a pending/running job already exists.
 *
 * No database required — both InsightsService and SystemSettingsService
 * are fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, JobReason } from '@prisma/client';
import { InsightsRefreshTask } from './insights-refresh.task';
import { InsightsService } from './insights.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(computedAt: Date) {
  return {
    id: 'snap-1',
    status: 'ready',
    metrics: null,
    computedAt,
    durationMs: 100,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeRefreshState(state: 'idle' | 'pending' | 'running' | 'failed') {
  return { state, jobId: state !== 'idle' ? 'job-1' : null, lastError: null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightsRefreshTask', () => {
  let task: InsightsRefreshTask;
  let mockInsights: jest.Mocked<Pick<InsightsService, 'getLatest' | 'enqueueRefresh' | 'getRefreshState'>>;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;

  beforeEach(async () => {
    mockInsights = {
      getLatest: jest.fn(),
      enqueueRefresh: jest.fn().mockResolvedValue({ id: 'job-new', status: JobStatus.pending }),
      getRefreshState: jest.fn().mockResolvedValue(makeRefreshState('idle')),
    };

    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(4),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsRefreshTask,
        { provide: InsightsService, useValue: mockInsights },
        { provide: SystemSettingsService, useValue: mockSettings },
      ],
    }).compile();

    task = module.get<InsightsRefreshTask>(InsightsRefreshTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Already in flight — should skip
  // =========================================================================

  describe('when a refresh is already pending or running', () => {
    it('does NOT call enqueueRefresh when state is pending', async () => {
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('pending'));

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).not.toHaveBeenCalled();
    });

    it('does NOT call enqueueRefresh when state is running', async () => {
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('running'));

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Fresh snapshot — should skip
  // =========================================================================

  describe('when last snapshot is fresh', () => {
    it('does NOT call enqueueRefresh when computedAt is within the configured interval', async () => {
      // 30 minutes ago — well within 4 hours
      const freshComputedAt = new Date(Date.now() - 30 * 60 * 1000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(freshComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(4);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).not.toHaveBeenCalled();
    });

    it('does NOT call enqueueRefresh when computedAt is exactly at the threshold minus 1 ms', async () => {
      const marginMs = 4 * 3_600_000 - 100;
      const recentComputedAt = new Date(Date.now() - marginMs);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(recentComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(4);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Stale snapshot — should enqueue
  // =========================================================================

  describe('when last snapshot is stale', () => {
    it('calls enqueueRefresh when computedAt exceeds the configured interval (5h ago, 4h interval)', async () => {
      const staleComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(4);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).toHaveBeenCalledTimes(1);
    });

    it('enqueues with backfill reason and low priority (100)', async () => {
      const staleComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).toHaveBeenCalledWith(JobReason.backfill, 100);
    });

    it('respects a custom interval: 2h interval with snapshot 3h old → enqueues', async () => {
      const staleComputedAt = new Date(Date.now() - 3 * 3_600_000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(2);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).toHaveBeenCalledTimes(1);
    });

    it('respects a custom interval: 8h interval with snapshot 5h old → skips', async () => {
      const freshComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(freshComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(8);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // No snapshot — should enqueue
  // =========================================================================

  describe('when no snapshot has ever been computed', () => {
    it('calls enqueueRefresh when getLatest returns null', async () => {
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(null);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).toHaveBeenCalledTimes(1);
    });

    it('calls enqueueRefresh when latest snapshot has no computedAt', async () => {
      const computingRow = makeSnapshot(null as unknown as Date);
      computingRow.computedAt = null as unknown as Date;
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(computingRow as any);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Default interval fallback
  // =========================================================================

  describe('default interval', () => {
    it('uses 4 hours when getSettingValue returns undefined', async () => {
      const recentComputedAt = new Date(Date.now() - 3 * 3_600_000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(recentComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(undefined);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).not.toHaveBeenCalled();
    });

    it('uses 4 hours when getSettingValue returns null', async () => {
      const staleComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(null);

      await task.handleScheduledRefresh();

      expect(mockInsights.enqueueRefresh).toHaveBeenCalledTimes(1);
    });

    it('reads the interval from storage.insights.refreshIntervalHours', async () => {
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(null);

      await task.handleScheduledRefresh();

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith(
        'storage.insights.refreshIntervalHours',
      );
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('does not throw when enqueueRefresh fails (errors are swallowed)', async () => {
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockResolvedValue(null);
      mockInsights.enqueueRefresh.mockRejectedValue(new Error('enqueue error'));

      await expect(task.handleScheduledRefresh()).resolves.not.toThrow();
    });

    it('does not throw when getLatest fails', async () => {
      mockInsights.getRefreshState.mockResolvedValue(makeRefreshState('idle'));
      mockInsights.getLatest.mockRejectedValue(new Error('DB error'));

      await expect(task.handleScheduledRefresh()).resolves.not.toThrow();
    });

    it('does not throw when getRefreshState fails', async () => {
      mockInsights.getRefreshState.mockRejectedValue(new Error('DB error'));

      await expect(task.handleScheduledRefresh()).resolves.not.toThrow();
    });
  });
});
