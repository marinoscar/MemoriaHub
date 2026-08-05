/**
 * Unit tests for NotificationPurgeTask.handleScheduledPurge (epic #240, issue #248).
 *
 * Mirrors JobHistoryPurgeTask's spec exactly (same dedup guard, same
 * never-throw error handling). Verifies:
 *   - Skips (does not enqueue) when notifications.purgeEnabled is false
 *   - Skips when a notification_purge job is already pending or running (dedup)
 *   - Enqueues a job with type=notification_purge, priority=100,
 *     reason=backfill, mediaItemId=null, circleId=null when enabled and no
 *     existing job
 *   - Does not throw when inner operations reject (error is caught internally)
 *     and a LATER tick still runs normally (the task does not get wedged by a
 *     throwing enqueue)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, JobReason } from '@prisma/client';
import { NotificationPurgeTask } from './notification-purge.task';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationPurgeTask', () => {
  let task: NotificationPurgeTask;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;
  let mockEnqueue: jest.Mock;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(true), // purgeEnabled=true by default
    };

    mockEnqueue = jest.fn().mockResolvedValue({ id: 'new-job-id' });

    mockPrisma = createMockPrismaService();
    // Default: no existing pending/running notification_purge
    mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationPurgeTask,
        {
          provide: EnrichmentJobService,
          useValue: { enqueue: mockEnqueue },
        },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSettings },
      ],
    }).compile();

    task = module.get<NotificationPurgeTask>(NotificationPurgeTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Disabled — notifications.purgeEnabled=false
  // =========================================================================

  describe('disabled (notifications.purgeEnabled=false)', () => {
    it('does NOT call findFirst when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).not.toHaveBeenCalled();
    });

    it('does NOT enqueue anything when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await task.handleScheduledPurge();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('resolves without throwing when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('reads notifications.purgeEnabled setting', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await task.handleScheduledPurge();

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith('notifications.purgeEnabled');
    });

    it('treats undefined purgeEnabled as true (default) and proceeds', async () => {
      mockSettings.getSettingValue.mockResolvedValue(undefined); // undefined → ?? true

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalled();
    });

    it('treats null purgeEnabled as true (default) and proceeds', async () => {
      mockSettings.getSettingValue.mockResolvedValue(null);

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Existing job present — dedup guard
  // =========================================================================

  describe('existing job present (dedup)', () => {
    it('does NOT enqueue when a pending notification_purge job already exists', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        type: 'notification_purge',
        status: JobStatus.pending,
      } as any);

      await task.handleScheduledPurge();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when a running notification_purge job already exists', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        type: 'notification_purge',
        status: JobStatus.running,
      } as any);

      await task.handleScheduledPurge();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('resolves without throwing when an existing job is present', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        type: 'notification_purge',
        status: JobStatus.pending,
      } as any);

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('queries findFirst with type=notification_purge and status in pending/running', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'notification_purge',
            status: { in: [JobStatus.pending, JobStatus.running] },
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Enabled + no existing job → enqueue
  // =========================================================================

  describe('enqueues when enabled and no existing job', () => {
    it('calls enqueue exactly once', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it('enqueues with type=notification_purge', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'notification_purge' }),
      );
    });

    it('enqueues with priority=100 (low-priority background)', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ priority: 100 }));
    });

    it('enqueues with reason=backfill', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ reason: JobReason.backfill }),
      );
    });

    it('enqueues with mediaItemId=null (global job)', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ mediaItemId: null }));
    });

    it('enqueues with circleId=null (global job)', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ circleId: null }));
    });

    it('resolves without throwing on successful enqueue', async () => {
      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Error handling — a throwing tick never wedges the task
  // =========================================================================

  describe('error handling', () => {
    it('does not throw when getSettingValue rejects', async () => {
      mockSettings.getSettingValue.mockRejectedValue(new Error('Settings DB error'));

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('does not throw when findFirst rejects', async () => {
      mockPrisma.enrichmentJob.findFirst.mockRejectedValue(new Error('DB error'));

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('does not throw when enqueue rejects', async () => {
      mockEnqueue.mockRejectedValue(new Error('Queue full'));

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('a throwing enqueue on one tick does not wedge the task — a LATER tick still enqueues normally', async () => {
      mockEnqueue.mockRejectedValueOnce(new Error('Queue full'));

      await task.handleScheduledPurge(); // first tick: enqueue rejects, caught internally
      expect(mockEnqueue).toHaveBeenCalledTimes(1);

      mockEnqueue.mockResolvedValueOnce({ id: 'second-job-id' });
      await task.handleScheduledPurge(); // second tick: runs normally

      expect(mockEnqueue).toHaveBeenCalledTimes(2);
    });

    it('a throwing findFirst on one tick does not wedge the task — a LATER tick still checks and enqueues normally', async () => {
      mockPrisma.enrichmentJob.findFirst.mockRejectedValueOnce(new Error('DB blip'));

      await task.handleScheduledPurge(); // first tick: findFirst rejects, caught internally
      expect(mockEnqueue).not.toHaveBeenCalled();

      mockPrisma.enrichmentJob.findFirst.mockResolvedValueOnce(null);
      await task.handleScheduledPurge(); // second tick: runs normally

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });
  });
});
