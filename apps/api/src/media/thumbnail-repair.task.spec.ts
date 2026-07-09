/**
 * Unit tests for ThumbnailRepairTask.
 *
 * Verifies: env kill-switch short-circuits before any DB access; enqueue is
 * skipped when a thumbnail_repair job is already pending/running; enqueue
 * shape (type, reason, priority, null mediaItemId/circleId).
 *
 * Mirrors trash-purge.task.spec.ts. No database required — all dependencies
 * are fully mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, JobStatus } from '@prisma/client';
import { ThumbnailRepairTask } from './thumbnail-repair.task';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnrichmentJob(status: 'pending' | 'running') {
  return {
    id: 'job-thumb-repair-1',
    type: 'thumbnail_repair',
    status,
    mediaItemId: null,
    circleId: null,
    priority: 100,
    reason: JobReason.backfill,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThumbnailRepairTask', () => {
  let task: ThumbnailRepairTask;
  let mockEnrichmentJobService: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let mockPrisma: MockPrismaService;
  let originalEnabledEnv: string | undefined;

  beforeEach(async () => {
    originalEnabledEnv = process.env['THUMBNAIL_REPAIR_ENABLED'];
    delete process.env['THUMBNAIL_REPAIR_ENABLED'];

    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-new', status: JobStatus.pending }),
    };

    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThumbnailRepairTask,
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    task = module.get<ThumbnailRepairTask>(ThumbnailRepairTask);
  });

  afterEach(() => {
    if (originalEnabledEnv === undefined) {
      delete process.env['THUMBNAIL_REPAIR_ENABLED'];
    } else {
      process.env['THUMBNAIL_REPAIR_ENABLED'] = originalEnabledEnv;
    }
    jest.clearAllMocks();
  });

  // =========================================================================
  // Environment kill-switch
  // =========================================================================

  describe('when THUMBNAIL_REPAIR_ENABLED === "false"', () => {
    it('does nothing — no DB query, no enqueue', async () => {
      process.env['THUMBNAIL_REPAIR_ENABLED'] = 'false';

      await task.handleScheduledRepair();

      expect(mockPrisma.enrichmentJob.findFirst).not.toHaveBeenCalled();
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Already in flight — should skip
  // =========================================================================

  describe('when a thumbnail_repair job is already pending or running', () => {
    it('does NOT call enqueue when state is pending', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(makeEnrichmentJob('pending') as any);

      await task.handleScheduledRepair();

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT call enqueue when state is running', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(makeEnrichmentJob('running') as any);

      await task.handleScheduledRepair();

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('queries for thumbnail_repair jobs with status pending or running', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);

      await task.handleScheduledRepair();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'thumbnail_repair',
            status: { in: expect.arrayContaining([JobStatus.pending, JobStatus.running]) },
          }),
        }),
      );
    });
  });

  // =========================================================================
  // No in-flight job — should enqueue
  // =========================================================================

  describe('when no thumbnail_repair job is pending or running', () => {
    beforeEach(() => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);
    });

    it('calls enqueue once', async () => {
      await task.handleScheduledRepair();

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('enqueues with type thumbnail_repair, reason backfill, priority 100 (low), null mediaItemId and circleId', async () => {
      await task.handleScheduledRepair();

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'thumbnail_repair',
          reason: JobReason.backfill,
          priority: 100,
          mediaItemId: null,
          circleId: null,
        }),
      );
    });
  });

  // =========================================================================
  // Error handling — errors are swallowed (mirrors TrashPurgeTask)
  // =========================================================================

  describe('error handling', () => {
    it('does not throw when enqueue fails', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('enqueue error'));

      await expect(task.handleScheduledRepair()).resolves.not.toThrow();
    });

    it('does not throw when findFirst fails', async () => {
      mockPrisma.enrichmentJob.findFirst.mockRejectedValue(new Error('DB error'));

      await expect(task.handleScheduledRepair()).resolves.not.toThrow();
    });
  });
});
