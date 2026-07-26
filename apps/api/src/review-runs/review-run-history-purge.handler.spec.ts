/**
 * Unit tests for ReviewRunHistoryPurgeHandler (issue #190).
 *
 * Verifies:
 *   - type constant / registry registration
 *   - retention purge deletes ONLY terminal runs, in bounded batches, using a
 *     cutoff derived from reviewRuns.runHistoryRetentionDays (read, not hardcoded)
 *   - non-terminal runs are never deletion candidates at ANY age
 *   - the stale-run sweep marks long-silent evaluating/running runs failed
 *   - trash_empty_runs is covered by BOTH halves of the sweep
 *
 * Style follows job-history-purge.handler.spec.ts.
 *
 * Notes: API tests not run against a real DB (Prisma engine download blocked);
 * these are pure unit tests over a mocked PrismaService.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ReviewRunStatus, TrashEmptyRunStatus } from '@prisma/client';
import type { EnrichmentJob } from '@prisma/client';
import { ReviewRunHistoryPurgeHandler } from './review-run-history-purge.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-review-purge-1',
    type: 'review_run_history_purge',
    mediaItemId: null,
    circleId: null,
    status: 'running' as any,
    reason: 'backfill' as any,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewRunHistoryPurgeHandler', () => {
  let handler: ReviewRunHistoryPurgeHandler;
  let mockRegistry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mockSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettingValue'>>;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockRegistry = { register: jest.fn() };
    mockSettings = { getSettingValue: jest.fn().mockResolvedValue(30) };
    mockPrisma = createMockPrismaService();

    // Default: nothing stale, nothing eligible for deletion.
    (mockPrisma.reviewRun.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.trashEmptyRun.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.reviewRun.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.trashEmptyRun.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.reviewRun.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.trashEmptyRun.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewRunHistoryPurgeHandler,
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: SystemSettingsService, useValue: mockSettings },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    handler = module.get<ReviewRunHistoryPurgeHandler>(ReviewRunHistoryPurgeHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type constant / registration
  // =========================================================================

  describe('type / registration', () => {
    it('has type === "review_run_history_purge"', () => {
      expect(handler.type).toBe('review_run_history_purge');
    });

    it('registers itself with the EnrichmentHandlerRegistry', () => {
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });

    it('is server-only — exposes no node-result pair', () => {
      expect((handler as any).nodeResultSchema).toBeUndefined();
      expect((handler as any).persistNodeResult).toBeUndefined();
    });
  });

  // =========================================================================
  // retention setting is READ, not hardcoded
  // =========================================================================

  describe('retention cutoff from settings', () => {
    it('reads the reviewRuns.runHistoryRetentionDays setting', async () => {
      await handler.process(makeJob());

      expect(mockSettings.getSettingValue).toHaveBeenCalledWith(
        'reviewRuns.runHistoryRetentionDays',
      );
    });

    it('derives the review-run cutoff from a custom retentionDays of 7', async () => {
      mockSettings.getSettingValue.mockResolvedValue(7);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const where = (mockPrisma.reviewRun.findMany as jest.Mock).mock.calls[0][0].where;
      const cutoff: Date = where.OR[0].finishedAt.lt;

      expect(cutoff.getTime()).toBeGreaterThan(before - 7 * DAY_MS - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - 7 * DAY_MS + 5000);
    });

    it('applies the SAME setting-derived cutoff to trash_empty_runs', async () => {
      mockSettings.getSettingValue.mockResolvedValue(7);

      await handler.process(makeJob());

      const reviewCutoff: Date = (mockPrisma.reviewRun.findMany as jest.Mock).mock.calls[0][0]
        .where.OR[0].finishedAt.lt;
      const trashCutoff: Date = (mockPrisma.trashEmptyRun.findMany as jest.Mock).mock.calls[0][0]
        .where.OR[0].finishedAt.lt;

      expect(trashCutoff.getTime()).toBe(reviewCutoff.getTime());
    });

    it('falls back to 30 days when the setting is undefined', async () => {
      mockSettings.getSettingValue.mockResolvedValue(undefined);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const cutoff: Date = (mockPrisma.reviewRun.findMany as jest.Mock).mock.calls[0][0].where
        .OR[0].finishedAt.lt;

      expect(cutoff.getTime()).toBeGreaterThan(before - 30 * DAY_MS - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - 30 * DAY_MS + 5000);
    });

    it('falls back to updatedAt when finishedAt is null', async () => {
      await handler.process(makeJob());

      const where = (mockPrisma.reviewRun.findMany as jest.Mock).mock.calls[0][0].where;

      expect(where.OR[1].finishedAt).toBeNull();
      expect(where.OR[1].updatedAt.lt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // retention purge — terminal only
  // =========================================================================

  describe('retention purge — terminal runs only', () => {
    it('selects ONLY the four terminal review-run statuses', async () => {
      await handler.process(makeJob());

      const where = (mockPrisma.reviewRun.findMany as jest.Mock).mock.calls[0][0].where;

      expect(where.status.in).toEqual([
        ReviewRunStatus.completed,
        ReviewRunStatus.completed_with_errors,
        ReviewRunStatus.failed,
        ReviewRunStatus.cancelled,
      ]);
    });

    it('never lists evaluating/running as deletion candidates, regardless of age', async () => {
      await handler.process(makeJob());

      const reviewStatuses = (mockPrisma.reviewRun.findMany as jest.Mock).mock.calls[0][0].where
        .status.in;
      const trashStatuses = (mockPrisma.trashEmptyRun.findMany as jest.Mock).mock.calls[0][0].where
        .status.in;

      expect(reviewStatuses).not.toContain(ReviewRunStatus.evaluating);
      expect(reviewStatuses).not.toContain(ReviewRunStatus.running);
      expect(trashStatuses).not.toContain(TrashEmptyRunStatus.evaluating);
      expect(trashStatuses).not.toContain(TrashEmptyRunStatus.running);
    });

    it('deletes the selected review-run ids', async () => {
      (mockPrisma.reviewRun.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'run-a' },
        { id: 'run-b' },
      ]);
      (mockPrisma.reviewRun.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });

      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['run-a', 'run-b'] } },
      });
    });

    it('does NOT delete run items directly — they cascade with the run', async () => {
      (mockPrisma.reviewRun.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'run-a' }]);
      (mockPrisma.reviewRun.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      expect(mockPrisma.reviewRunItem.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.trashEmptyRunItem.deleteMany).not.toHaveBeenCalled();
    });

    it('skips deleteMany entirely when nothing is eligible', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.trashEmptyRun.deleteMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // retention purge — batching
  // =========================================================================

  describe('retention purge — 5,000-row batching', () => {
    it('stops after a single short batch', async () => {
      (mockPrisma.reviewRun.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'run-a' }]);
      (mockPrisma.reviewRun.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.reviewRun.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('keeps batching while full 5,000-row batches come back', async () => {
      const fullBatch = Array.from({ length: 5000 }, (_, i) => ({ id: `run-${i}` }));
      (mockPrisma.reviewRun.findMany as jest.Mock)
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([{ id: 'run-last' }]);
      (mockPrisma.reviewRun.deleteMany as jest.Mock).mockResolvedValue({ count: 5000 });

      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.reviewRun.deleteMany).toHaveBeenCalledTimes(2);
    });

    it('bounds each select with take = 5000', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5000 }),
      );
      expect(mockPrisma.trashEmptyRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5000 }),
      );
    });
  });

  // =========================================================================
  // stale-run sweep
  // =========================================================================

  describe('stale-run sweep', () => {
    it('marks long-silent evaluating/running review runs failed', async () => {
      (mockPrisma.reviewRun.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [ReviewRunStatus.evaluating, ReviewRunStatus.running] },
          }),
          data: expect.objectContaining({ status: ReviewRunStatus.failed }),
        }),
      );
    });

    it('records an explanatory lastError on a swept run', async () => {
      await handler.process(makeJob());

      const data = (mockPrisma.reviewRun.updateMany as jest.Mock).mock.calls[0][0].data;

      expect(typeof data.lastError).toBe('string');
      expect(data.lastError).toMatch(/stale/i);
      expect(data.finishedAt).toBeInstanceOf(Date);
    });

    it('uses a 24h updatedAt-silence cutoff, independent of retentionDays', async () => {
      mockSettings.getSettingValue.mockResolvedValue(365);

      const before = Date.now();
      await handler.process(makeJob());
      const after = Date.now();

      const cutoff: Date = (mockPrisma.reviewRun.updateMany as jest.Mock).mock.calls[0][0].where
        .updatedAt.lt;

      expect(cutoff.getTime()).toBeGreaterThan(before - 24 * HOUR_MS - 5000);
      expect(cutoff.getTime()).toBeLessThan(after - 24 * HOUR_MS + 5000);
    });

    it('never sweeps a run that is already terminal', async () => {
      await handler.process(makeJob());

      const statuses = (mockPrisma.reviewRun.updateMany as jest.Mock).mock.calls[0][0].where.status
        .in;

      expect(statuses).not.toContain(ReviewRunStatus.completed);
      expect(statuses).not.toContain(ReviewRunStatus.failed);
      expect(statuses).not.toContain(ReviewRunStatus.cancelled);
    });

    it('sweeps BEFORE purging, so a just-failed old run is deletable in the same pass', async () => {
      const order: string[] = [];
      (mockPrisma.reviewRun.updateMany as jest.Mock).mockImplementation(async () => {
        order.push('sweep');
        return { count: 1 };
      });
      (mockPrisma.reviewRun.findMany as jest.Mock).mockImplementation(async () => {
        order.push('purge-select');
        return [];
      });

      await handler.process(makeJob());

      expect(order.indexOf('sweep')).toBeLessThan(order.indexOf('purge-select'));
    });
  });

  // =========================================================================
  // trash_empty_runs coverage — both halves
  // =========================================================================

  describe('trash_empty_runs coverage', () => {
    it('sweeps stale trash-empty runs to failed', async () => {
      (mockPrisma.trashEmptyRun.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      expect(mockPrisma.trashEmptyRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [TrashEmptyRunStatus.evaluating, TrashEmptyRunStatus.running] },
          }),
          data: expect.objectContaining({ status: TrashEmptyRunStatus.failed }),
        }),
      );
    });

    it('purges terminal trash-empty runs past retention', async () => {
      (mockPrisma.trashEmptyRun.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'trash-run-a' },
      ]);
      (mockPrisma.trashEmptyRun.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await handler.process(makeJob());

      expect(mockPrisma.trashEmptyRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: {
              in: [
                TrashEmptyRunStatus.completed,
                TrashEmptyRunStatus.completed_with_errors,
                TrashEmptyRunStatus.failed,
                TrashEmptyRunStatus.cancelled,
              ],
            },
          }),
        }),
      );
      expect(mockPrisma.trashEmptyRun.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['trash-run-a'] } },
      });
    });

    it('covers both tables in one pass', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.reviewRun.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.trashEmptyRun.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.reviewRun.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.trashEmptyRun.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // error propagation / global job shape
  // =========================================================================

  describe('error propagation', () => {
    it('propagates a failure from the stale sweep', async () => {
      (mockPrisma.reviewRun.updateMany as jest.Mock).mockRejectedValue(new Error('DB locked'));

      await expect(handler.process(makeJob())).rejects.toThrow('DB locked');
    });

    it('propagates a failure from the retention delete', async () => {
      (mockPrisma.reviewRun.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'run-a' }]);
      (mockPrisma.reviewRun.deleteMany as jest.Mock).mockRejectedValue(
        new Error('Connection lost'),
      );

      await expect(handler.process(makeJob())).rejects.toThrow('Connection lost');
    });

    it('runs as a global job with null mediaItemId and circleId', async () => {
      await expect(
        handler.process(makeJob({ mediaItemId: null, circleId: null })),
      ).resolves.toBeUndefined();
    });
  });
});
