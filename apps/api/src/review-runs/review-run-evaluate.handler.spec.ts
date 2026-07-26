/**
 * Unit tests for ReviewRunEvaluateHandler — the shared evaluation handler
 * behind every bulk review-queue run (burst resolve/dismiss-by-threshold,
 * duplicate resolve/dismiss-by-threshold, location-suggestion bulk
 * accept/reject; issue #190).
 *
 * Covers:
 *   - No-ops: malformed payload (missing runId), run gone, run status not
 *     'evaluating' (already 'running' or terminal).
 *   - Multi-page keyset paging: a strategy returning 2 full pages then a
 *     short final page — reviewRunItem.createMany is called once per page
 *     with skipDuplicates: true, and matchedCount sums across all pages.
 *   - matchedCount === 0 -> run transitions straight to 'completed' with
 *     finishedAt set, WITHOUT calling enqueueExecuteBatches / enqueuing any
 *     review_run_execute_batch job.
 *   - Idempotent re-materialization: createMany is always called with
 *     skipDuplicates: true so a retried attempt re-materializing a page
 *     never double-counts (the DB-side partial unique indexes are what make
 *     this safe; this just asserts the flag is passed).
 *   - Retry-exhaustion guard: job.attempts >= ENRICHMENT_MAX_ATTEMPTS on a
 *     thrown error marks the run 'failed' with lastError set; an
 *     intermediate attempt (attempts < max) leaves the run 'evaluating' and
 *     rethrows without marking it failed.
 *   - A dedicated `describe` block asserts the REAL BurstGroupReviewStrategy
 *     and DuplicateGroupReviewStrategy's evaluatePage() builds a Prisma
 *     `where` with `confidence: { not: null, ... }` in BOTH the resolve and
 *     dismiss directions — the null-confidence exclusion is strategy-owned
 *     logic, not handler logic, so it's asserted against the real strategy
 *     rather than a stub.
 *
 * The handler is constructed directly (no Nest TestingModule) against a
 * mocked PrismaService, a mocked ReviewRunService (only enqueueExecuteBatches
 * is exercised), and a mocked ReviewRunSubjectRegistry whose get() returns a
 * fully-controllable stub strategy — the handler is subject-agnostic by
 * design, so driving it against a stub strategy is the correct isolation
 * boundary. Style mirrors trash-empty-evaluate.handler.spec.ts and the
 * preserved location-suggestion-run-evaluate.handler.spec.ts.old reference.
 */

import { EnrichmentJob, ReviewRunAction, ReviewRunStatus, ReviewRunSubject } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ReviewRunEvaluateHandler } from './review-run-evaluate.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewRunService } from './review-run.service';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import {
  ReviewRunCursor,
  ReviewRunEvaluatePage,
  ReviewRunSubjectStrategy,
} from './review-run-subject.strategy';
import { BurstGroupReviewStrategy } from './strategies/burst-group.strategy';
import { DuplicateGroupReviewStrategy } from './strategies/duplicate-group.strategy';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeJob(payload: Record<string, unknown>, attempts = 1): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'review_run_evaluate',
    mediaItemId: null,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 20,
    providerKey: null,
    modelVersion: null,
    payload,
    attempts,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: 'server',
  } as unknown as EnrichmentJob;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    circleId: CIRCLE_ID,
    subjectType: ReviewRunSubject.burst_group,
    action: ReviewRunAction.resolve_archive,
    threshold: 60,
    status: ReviewRunStatus.evaluating,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: randomUUID(),
    ...overrides,
  };
}

/** A fully stub strategy — evaluatePage is set per-test. */
function makeStubStrategy(
  overrides: Partial<ReviewRunSubjectStrategy> = {},
): jest.Mocked<Pick<ReviewRunSubjectStrategy, 'subjectColumn' | 'evaluatePage'>> {
  return {
    subjectColumn: 'burstGroupId' as const,
    evaluatePage: jest.fn(),
    ...overrides,
  } as any;
}

describe('ReviewRunEvaluateHandler', () => {
  let handler: ReviewRunEvaluateHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let runService: jest.Mocked<Pick<ReviewRunService, 'enqueueExecuteBatches'>>;
  let subjects: { get: jest.Mock };
  let stubStrategy: ReturnType<typeof makeStubStrategy>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    runService = { enqueueExecuteBatches: jest.fn().mockResolvedValue(undefined) };
    stubStrategy = makeStubStrategy();
    subjects = { get: jest.fn().mockReturnValue(stubStrategy) };

    handler = new ReviewRunEvaluateHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      runService as unknown as ReviewRunService,
      subjects as unknown as ReviewRunSubjectRegistry,
    );

    prisma.reviewRunItem.createMany.mockResolvedValue({ count: 0 } as any);
    prisma.reviewRun.update.mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['ENRICHMENT_MAX_ATTEMPTS'];
  });

  it('registers itself with the handler registry on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('has type === "review_run_evaluate"', () => {
    expect(handler.type).toBe('review_run_evaluate');
  });

  // ---------------------------------------------------------------------------
  // No-ops
  // ---------------------------------------------------------------------------

  describe('no-ops', () => {
    it('is a no-op when the payload is missing runId', async () => {
      await handler.process(makeJob({}));
      expect(prisma.reviewRun.findUnique).not.toHaveBeenCalled();
    });

    it('is a no-op when the run is gone', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(null);
      await handler.process(makeJob({ runId: RUN_ID }));
      expect(stubStrategy.evaluatePage).not.toHaveBeenCalled();
    });

    it('is a no-op when the run status is "running" (already past evaluation)', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun({ status: ReviewRunStatus.running }) as any);
      await handler.process(makeJob({ runId: RUN_ID }));
      expect(stubStrategy.evaluatePage).not.toHaveBeenCalled();
    });

    it('is a no-op when the run status is a terminal status', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun({ status: ReviewRunStatus.completed }) as any);
      await handler.process(makeJob({ runId: RUN_ID }));
      expect(stubStrategy.evaluatePage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-page keyset paging
  // ---------------------------------------------------------------------------

  describe('multi-page keyset paging', () => {
    it('materializes 2 full pages then a short final page via one createMany per page, and sums matchedCount', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      const PAGE_SIZE = 1000;
      const page1: ReviewRunEvaluatePage = {
        subjectIds: Array.from({ length: PAGE_SIZE }, (_, i) => `g-${i}`),
        nextCursor: { id: 'g-999' } as ReviewRunCursor,
      };
      const page2: ReviewRunEvaluatePage = {
        subjectIds: Array.from({ length: PAGE_SIZE }, (_, i) => `g-${PAGE_SIZE + i}`),
        nextCursor: { id: 'g-1999' } as ReviewRunCursor,
      };
      const page3: ReviewRunEvaluatePage = {
        subjectIds: ['g-final-1', 'g-final-2'],
        nextCursor: null,
      };
      stubStrategy.evaluatePage
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3);

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(prisma.reviewRunItem.createMany).toHaveBeenCalledTimes(3);
      const calls = (prisma.reviewRunItem.createMany as jest.Mock).mock.calls;
      expect(calls[0][0].data).toHaveLength(PAGE_SIZE);
      expect(calls[1][0].data).toHaveLength(PAGE_SIZE);
      expect(calls[2][0].data).toHaveLength(2);

      const matchedCountUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(matchedCountUpdate[0].data.matchedCount).toBe(2 * PAGE_SIZE + 2);
    });

    it('stops paging once a short page is returned even if nextCursor is non-null', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockResolvedValueOnce({
        subjectIds: ['g-1'],
        nextCursor: { id: 'g-1' } as ReviewRunCursor,
      });

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(stubStrategy.evaluatePage).toHaveBeenCalledTimes(1);
      expect(prisma.reviewRunItem.createMany).toHaveBeenCalledTimes(1);
    });

    it('writes each row with the strategy subjectColumn populated and status "matched"', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockResolvedValueOnce({
        subjectIds: ['g-1', 'g-2'],
        nextCursor: null,
      });

      await handler.process(makeJob({ runId: RUN_ID }));

      const call = (prisma.reviewRunItem.createMany as jest.Mock).mock.calls[0][0];
      expect(call.data).toEqual([
        { runId: RUN_ID, subjectType: ReviewRunSubject.burst_group, burstGroupId: 'g-1', status: 'matched' },
        { runId: RUN_ID, subjectType: ReviewRunSubject.burst_group, burstGroupId: 'g-2', status: 'matched' },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotent re-materialization
  // ---------------------------------------------------------------------------

  describe('idempotent re-materialization', () => {
    it('always calls createMany with skipDuplicates: true so a retried page never double-counts', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockResolvedValueOnce({ subjectIds: ['g-1'], nextCursor: null });

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(prisma.reviewRunItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------------

  describe('terminal transitions', () => {
    it('0 matches -> run transitions to completed with finishedAt, no execute-batch fan-out', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockResolvedValueOnce({ subjectIds: [], nextCursor: null });

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(ReviewRunStatus.completed);
      expect(statusUpdate[0].data.finishedAt).toEqual(expect.any(Date));
      expect(runService.enqueueExecuteBatches).not.toHaveBeenCalled();
    });

    it('matches > 0 -> run transitions to running (+startedAt) and enqueueExecuteBatches is called with (runId, circleId, subjectType)', async () => {
      const run = makeRun({ subjectType: ReviewRunSubject.duplicate_group });
      prisma.reviewRun.findUnique.mockResolvedValue(run as any);
      stubStrategy.evaluatePage.mockResolvedValueOnce({ subjectIds: ['g-1', 'g-2'], nextCursor: null });

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(ReviewRunStatus.running);
      expect(statusUpdate[0].data.startedAt).toEqual(expect.any(Date));
      expect(runService.enqueueExecuteBatches).toHaveBeenCalledWith(
        RUN_ID,
        CIRCLE_ID,
        ReviewRunSubject.duplicate_group,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Retry-exhaustion guard
  // ---------------------------------------------------------------------------

  describe('retry-exhaustion guard (attempts >= ENRICHMENT_MAX_ATTEMPTS)', () => {
    it('rethrows WITHOUT marking the run failed when attempts are still under budget', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockRejectedValue(new Error('DB connection lost'));

      await expect(handler.process(makeJob({ runId: RUN_ID }, 1))).rejects.toThrow(
        'DB connection lost',
      );

      const failedUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === ReviewRunStatus.failed,
      );
      expect(failedUpdate).toBeUndefined();
    });

    it('marks the run "failed" with lastError once attempts >= ENRICHMENT_MAX_ATTEMPTS, and still rethrows', async () => {
      process.env['ENRICHMENT_MAX_ATTEMPTS'] = '3';
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockRejectedValue(new Error('DB connection lost'));

      await expect(handler.process(makeJob({ runId: RUN_ID }, 3))).rejects.toThrow(
        'DB connection lost',
      );

      const failedUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === ReviewRunStatus.failed,
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.lastError).toBe('DB connection lost');
      expect(failedUpdate[0].data.finishedAt).toEqual(expect.any(Date));
    });

    it('never throws out of the failed-marking itself even if that update also fails (best-effort .catch)', async () => {
      process.env['ENRICHMENT_MAX_ATTEMPTS'] = '1';
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      stubStrategy.evaluatePage.mockRejectedValue(new Error('primary failure'));
      (prisma.reviewRun.update as jest.Mock).mockImplementation((args: any) => {
        if (args?.data?.status === ReviewRunStatus.failed) {
          return Promise.reject(new Error('update also failed'));
        }
        return Promise.resolve({});
      });

      await expect(handler.process(makeJob({ runId: RUN_ID }, 1))).rejects.toThrow(
        'primary failure',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Null-confidence exclusion in BOTH directions (real strategy, not a stub)
  // ---------------------------------------------------------------------------

  describe('null-confidence exclusion (real BurstGroupReviewStrategy / DuplicateGroupReviewStrategy)', () => {
    let strategyPrisma: MockPrismaService;

    beforeEach(() => {
      strategyPrisma = createMockPrismaService();
      (strategyPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);
      (strategyPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('BurstGroupReviewStrategy: a resolve run filters confidence { not: null, gte: floor }', async () => {
      const strategy = new BurstGroupReviewStrategy(
        strategyPrisma as unknown as PrismaService,
        {} as any,
      );
      const run = makeRun({ action: ReviewRunAction.resolve_archive, threshold: 60 });

      await strategy.evaluatePage(run as any, null, 1000);

      const where = (strategyPrisma.burstGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.confidence).toEqual({ not: null, gte: 0.6 });
    });

    it('BurstGroupReviewStrategy: a dismiss run filters confidence { not: null, lt: floor }', async () => {
      const strategy = new BurstGroupReviewStrategy(
        strategyPrisma as unknown as PrismaService,
        {} as any,
      );
      const run = makeRun({ action: ReviewRunAction.dismiss, threshold: 60 });

      await strategy.evaluatePage(run as any, null, 1000);

      const where = (strategyPrisma.burstGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.confidence).toEqual({ not: null, lt: 0.6 });
    });

    it('DuplicateGroupReviewStrategy: a resolve run filters confidence { not: null, gte: floor }', async () => {
      const strategy = new DuplicateGroupReviewStrategy(
        strategyPrisma as unknown as PrismaService,
        {} as any,
      );
      const run = makeRun({
        subjectType: ReviewRunSubject.duplicate_group,
        action: ReviewRunAction.resolve_trash,
        threshold: 75,
      });

      await strategy.evaluatePage(run as any, null, 1000);

      const where = (strategyPrisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.confidence).toEqual({ not: null, gte: 0.75 });
    });

    it('DuplicateGroupReviewStrategy: a dismiss run filters confidence { not: null, lt: floor }', async () => {
      const strategy = new DuplicateGroupReviewStrategy(
        strategyPrisma as unknown as PrismaService,
        {} as any,
      );
      const run = makeRun({
        subjectType: ReviewRunSubject.duplicate_group,
        action: ReviewRunAction.dismiss,
        threshold: 75,
      });

      await strategy.evaluatePage(run as any, null, 1000);

      const where = (strategyPrisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.confidence).toEqual({ not: null, lt: 0.75 });
    });
  });
});
