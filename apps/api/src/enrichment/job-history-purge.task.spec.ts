/**
 * Unit tests for JobHistoryPurgeTask.handleScheduledPurge.
 *
 * Verifies:
 *   - Skips when jobs.history.purgeEnabled is false
 *   - Skips when a job_history_purge job is already pending or running
 *   - Enqueues a job with priority=100 and reason=backfill when enabled and no existing job
 *   - Does not throw when inner operations reject (error is caught internally)
 *
 * Notes: API tests not run (Prisma engine download blocked in this env).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, JobReason } from '@prisma/client';
import { JobHistoryPurgeTask } from './job-history-purge.task';
import { EnrichmentJobService } from './enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobHistoryPurgeTask', () => {
  let task: JobHistoryPurgeTask;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;
  let mockEnqueue: jest.Mock;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockSettings = {
      getSettingValue: jest.fn().mockResolvedValue(true), // purgeEnabled=true by default
    };

    mockEnqueue = jest.fn().mockResolvedValue({ id: 'new-job-id' });

    mockPrisma = createMockPrismaService();
    // Default: no existing pending/running job_history_purge
    mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobHistoryPurgeTask,
        {
          provide: EnrichmentJobService,
          useValue: { enqueue: mockEnqueue },
        },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSettings },
      ],
    }).compile();

    task = module.get<JobHistoryPurgeTask>(JobHistoryPurgeTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Disabled
  // =========================================================================

  describe('disabled (purgeEnabled=false)', () => {
    it('does NOT call findFirst when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await task.handleScheduledPurge();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('resolves without throwing when disabled', async () => {
      mockSettings.getSettingValue.mockResolvedValue(false);

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('treats undefined purgeEnabled as true (default) and proceeds', async () => {
      mockSettings.getSettingValue.mockResolvedValue(undefined); // undefined → ?? true

      await task.handleScheduledPurge();

      // Should proceed to check for existing jobs
      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Existing job present — skip
  // =========================================================================

  describe('existing job present', () => {
    it('does NOT enqueue when a pending job_history_purge already exists', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        type: 'job_history_purge',
        status: JobStatus.pending,
      } as any);

      await task.handleScheduledPurge();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when a running job_history_purge already exists', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        type: 'job_history_purge',
        status: JobStatus.running,
      } as any);

      await task.handleScheduledPurge();

      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('resolves without throwing when an existing job is present', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue({
        id: 'existing-job',
        type: 'job_history_purge',
        status: JobStatus.pending,
      } as any);

      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });

    it('queries findFirst with type=job_history_purge and status in pending/running', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'job_history_purge',
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
    it('calls enqueue when enabled and no existing job', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it('enqueues with type=job_history_purge', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'job_history_purge' }),
      );
    });

    it('enqueues with priority=100 (low-priority background)', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 100 }),
      );
    });

    it('enqueues with reason=backfill', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ reason: JobReason.backfill }),
      );
    });

    it('enqueues with mediaItemId=null (global job)', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ mediaItemId: null }),
      );
    });

    it('enqueues with circleId=null (global job)', async () => {
      await task.handleScheduledPurge();

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: null }),
      );
    });

    it('resolves without throwing on successful enqueue', async () => {
      await expect(task.handleScheduledPurge()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Error handling — errors are caught internally
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
  });
});
