/**
 * Unit tests for TrashPurgeTask.
 *
 * Verifies: enqueue is called when no pending/running job exists;
 * skips when one already exists.
 *
 * Mirrors InsightsRefreshTask spec. No database required —
 * all dependencies are fully mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { JobReason, JobStatus } from '@prisma/client';
import { TrashPurgeTask } from './trash-purge.task';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnrichmentJob(status: 'pending' | 'running') {
  return {
    id: 'job-purge-1',
    type: 'trash_purge',
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

describe('TrashPurgeTask', () => {
  let task: TrashPurgeTask;
  let mockEnrichmentJobService: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-new', status: JobStatus.pending }),
    };

    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrashPurgeTask,
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    task = module.get<TrashPurgeTask>(TrashPurgeTask);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Already in flight — should skip
  // =========================================================================

  describe('when a trash_purge job is already pending or running', () => {
    it('does NOT call enqueue when state is pending', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(makeEnrichmentJob('pending') as any);

      await task.handleScheduledPurge();

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT call enqueue when state is running', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(makeEnrichmentJob('running') as any);

      await task.handleScheduledPurge();

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // No in-flight job — should enqueue
  // =========================================================================

  describe('when no trash_purge job is pending or running', () => {
    beforeEach(() => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);
    });

    it('calls enqueue once', async () => {
      await task.handleScheduledPurge();

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
    });

    it('enqueues with type trash_purge, reason backfill, priority 100 (low), null mediaItemId and circleId', async () => {
      await task.handleScheduledPurge();

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'trash_purge',
          reason: JobReason.backfill,
          priority: 100,
          mediaItemId: null,
          circleId: null,
        }),
      );
    });
  });

  // =========================================================================
  // findFirst query shape
  // =========================================================================

  describe('findFirst query for existing job', () => {
    it('queries for trash_purge jobs with status pending or running', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);

      await task.handleScheduledPurge();

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'trash_purge',
            status: { in: expect.arrayContaining([JobStatus.pending, JobStatus.running]) },
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Error handling — errors are swallowed (mirrors InsightsRefreshTask)
  // =========================================================================

  describe('error handling', () => {
    it('does not throw when enqueue fails', async () => {
      mockPrisma.enrichmentJob.findFirst.mockResolvedValue(null);
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('enqueue error'));

      await expect(task.handleScheduledPurge()).resolves.not.toThrow();
    });

    it('does not throw when findFirst fails', async () => {
      mockPrisma.enrichmentJob.findFirst.mockRejectedValue(new Error('DB error'));

      await expect(task.handleScheduledPurge()).resolves.not.toThrow();
    });
  });
});
