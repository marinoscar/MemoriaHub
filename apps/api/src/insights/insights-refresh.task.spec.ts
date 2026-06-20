/**
 * Unit tests for InsightsRefreshTask.
 *
 * Verifies the time-gate logic: recompute() is only called when the last
 * snapshot is stale (or absent). Tests the configurable interval and the
 * default of 4 hours.
 *
 * No database required — both InsightsService and SystemSettingsService
 * are fully mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightsRefreshTask', () => {
  let task: InsightsRefreshTask;
  let mockInsights: jest.Mocked<Pick<InsightsService, 'getLatest' | 'recompute'>>;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;

  beforeEach(async () => {
    mockInsights = {
      getLatest: jest.fn(),
      recompute: jest.fn().mockResolvedValue(makeSnapshot(new Date())),
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
  // Fresh snapshot — should skip
  // =========================================================================

  describe('when last snapshot is fresh', () => {
    it('does NOT call recompute when computedAt is within the configured interval', async () => {
      // 30 minutes ago — well within 4 hours
      const freshComputedAt = new Date(Date.now() - 30 * 60 * 1000);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(freshComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(4);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).not.toHaveBeenCalled();
    });

    it('does NOT call recompute when computedAt is exactly at the threshold minus 1 ms', async () => {
      // interval is 4 hours; snapshot is 4h-1ms old → still fresh
      const marginMs = 4 * 3_600_000 - 1;
      const recentComputedAt = new Date(Date.now() - marginMs);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(recentComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(4);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Stale snapshot — should recompute
  // =========================================================================

  describe('when last snapshot is stale', () => {
    it('calls recompute when computedAt exceeds the configured interval (5h ago, 4h interval)', async () => {
      const staleComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(4);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).toHaveBeenCalledTimes(1);
    });

    it('respects a custom interval: 2h interval with snapshot 3h old → recomputes', async () => {
      const staleComputedAt = new Date(Date.now() - 3 * 3_600_000);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(2);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).toHaveBeenCalledTimes(1);
    });

    it('respects a custom interval: 8h interval with snapshot 5h old → skips', async () => {
      const freshComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(freshComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(8);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // No snapshot — should recompute
  // =========================================================================

  describe('when no snapshot has ever been computed', () => {
    it('calls recompute when getLatest returns null', async () => {
      mockInsights.getLatest.mockResolvedValue(null);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).toHaveBeenCalledTimes(1);
    });

    it('calls recompute when latest snapshot has no computedAt (computing row)', async () => {
      const computingRow = makeSnapshot(null as unknown as Date);
      computingRow.computedAt = null as unknown as Date;
      mockInsights.getLatest.mockResolvedValue(computingRow as any);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Default interval fallback
  // =========================================================================

  describe('default interval', () => {
    it('uses 4 hours when getSettingValue returns undefined', async () => {
      // Snapshot 3h old — should be within the 4h default → skip
      const recentComputedAt = new Date(Date.now() - 3 * 3_600_000);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(recentComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(undefined);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).not.toHaveBeenCalled();
    });

    it('uses 4 hours when getSettingValue returns null', async () => {
      // Snapshot 5h old — stale under the 4h default → recompute
      const staleComputedAt = new Date(Date.now() - 5 * 3_600_000);
      mockInsights.getLatest.mockResolvedValue(makeSnapshot(staleComputedAt) as any);
      mockSettings.getSettingValue.mockResolvedValue(null);

      await task.handleScheduledRefresh();

      expect(mockInsights.recompute).toHaveBeenCalledTimes(1);
    });

    it('reads the interval from storage.insights.refreshIntervalHours', async () => {
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
    it('does not throw when recompute fails (errors are swallowed)', async () => {
      mockInsights.getLatest.mockResolvedValue(null);
      mockInsights.recompute.mockRejectedValue(new Error('compute error'));

      await expect(task.handleScheduledRefresh()).resolves.not.toThrow();
    });

    it('does not throw when getLatest fails', async () => {
      mockInsights.getLatest.mockRejectedValue(new Error('DB error'));

      await expect(task.handleScheduledRefresh()).resolves.not.toThrow();
    });
  });
});
