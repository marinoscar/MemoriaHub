/**
 * Unit tests for ReviewRunExecuteBatchHandler — the shared batch-execution
 * handler behind every bulk review-queue run (burst resolve/dismiss-by-
 * threshold, duplicate resolve/dismiss-by-threshold, location-suggestion
 * bulk accept/reject; issue #190). This is the load-bearing correctness file
 * for the whole feature: claim idempotency, the cascade-mid-run interaction
 * between a deleted subject and its (also cascade-deleted) run-item row,
 * cooperative cancellation, atomic counters, and the race-safe finalize.
 *
 * Covers:
 *   - No-ops: malformed payload, run gone.
 *   - Cooperative cancellation: run.status === 'cancelled' -> return
 *     immediately, before any updateMany/findMany/strategy call.
 *   - Claim idempotency on retry: updateMany claims 0 NEW rows (already
 *     flipped to 'processing' by a crashed prior attempt) but findMany still
 *     reads back rows currently 'processing' — the work set — and they are
 *     processed normally, not skipped or double-counted.
 *   - Subject cascade-deleted mid-run: modeled by the work-set read-back
 *     (reviewRunItem.findMany) simply not returning a row whose underlying
 *     subject (and therefore its run-item row, via the DB CASCADE) is gone.
 *     processedCount increments only by the rows that WERE in the work set;
 *     the run still reaches a terminal status via maybeFinalizeRun's count
 *     check; processedCount legitimately ends up LOWER than matchedCount —
 *     asserted as success, not as a stuck/incomplete run (per the ReviewRun
 *     model's doc comment in schema.prisma).
 *   - A subject that still exists but is no longer eligible (strategy
 *     returns 'skipped') -> run-item -> skipped; skippedCount increments,
 *     not failedCount.
 *   - Counter increments reflect only THIS attempt's tallies.
 *   - completed vs completed_with_errors: maybeFinalizeRun's SECOND
 *     findUnique read (distinct from the top-of-executeBatch read) decides
 *     the final status from failedCount.
 *   - The conditional-updateMany-guarded-on-'running' finalize: a count: 0
 *     result (another batch already won) resolves without throwing.
 *   - strategy.deferredEffects is called once per batch AFTER all per-item
 *     work, is awaited, and a rejection from it is swallowed (logged, not
 *     thrown) — the batch must still complete/finalize normally.
 *   - A per-item executeItem throw -> run-item -> failed with error set;
 *     does not abort the rest of the batch.
 *
 * The handler is constructed directly against a mocked PrismaService and a
 * mocked ReviewRunSubjectRegistry whose get() returns a fully-controllable
 * stub strategy — the handler is subject-agnostic by design (per its own
 * doc comment), so testing it against a stub strategy is the correct
 * isolation boundary; the real strategies are covered separately in
 * strategies/*.strategy.spec.ts. Style mirrors
 * trash-empty-execute-batch.handler.spec.ts and the preserved
 * location-suggestion-run-execute-batch.handler.spec.ts.old reference.
 */

import { EnrichmentJob, ReviewRunItemStatus, ReviewRunStatus, ReviewRunSubject } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ReviewRunExecuteBatchHandler } from './review-run-execute-batch.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeJob(payload: Record<string, unknown>): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'review_run_execute_batch',
    mediaItemId: null,
    circleId: CIRCLE_ID,
    status: 'running',
    reason: 'rerun',
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload,
    attempts: 1,
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
    status: ReviewRunStatus.running,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: randomUUID(),
    ...overrides,
  };
}

/** A fully stub strategy — executeItem/deferredEffects are set per-test. */
function makeStubStrategy(overrides: Record<string, unknown> = {}): {
  subjectColumn: 'burstGroupId';
  executeItem: jest.Mock;
  deferredEffects: jest.Mock;
} {
  return {
    subjectColumn: 'burstGroupId' as const,
    executeItem: jest.fn().mockResolvedValue('applied'),
    deferredEffects: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ReviewRunExecuteBatchHandler', () => {
  let handler: ReviewRunExecuteBatchHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let subjects: { get: jest.Mock };
  let stubStrategy: ReturnType<typeof makeStubStrategy>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    stubStrategy = makeStubStrategy();
    subjects = { get: jest.fn().mockReturnValue(stubStrategy) };

    handler = new ReviewRunExecuteBatchHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      subjects as unknown as ReviewRunSubjectRegistry,
    );

    prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
    prisma.reviewRunItem.updateMany.mockResolvedValue({ count: 0 } as any);
    prisma.reviewRunItem.findMany.mockResolvedValue([] as any);
    prisma.reviewRunItem.update.mockResolvedValue({} as any);
    prisma.reviewRun.update.mockResolvedValue({} as any);
    prisma.reviewRunItem.count.mockResolvedValue(1); // "matched/processing items remain" by default
    prisma.reviewRun.updateMany.mockResolvedValue({ count: 1 } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('registers itself with the handler registry on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('has type === "review_run_execute_batch"', () => {
    expect(handler.type).toBe('review_run_execute_batch');
  });

  // ---------------------------------------------------------------------------
  // No-ops
  // ---------------------------------------------------------------------------

  describe('no-ops', () => {
    it('is a no-op when the payload is missing runId', async () => {
      await handler.process(makeJob({ subjectIds: ['g-1'] }));
      expect(prisma.reviewRun.findUnique).not.toHaveBeenCalled();
    });

    it('is a no-op when the payload is missing subjectIds (or it is not an array)', async () => {
      await handler.process(makeJob({ runId: RUN_ID }));
      expect(prisma.reviewRun.findUnique).not.toHaveBeenCalled();
    });

    it('is a no-op when the run is gone', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(null);
      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));
      expect(prisma.reviewRunItem.updateMany).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Cooperative cancellation
  // ---------------------------------------------------------------------------

  describe('cooperative cancellation', () => {
    it('returns immediately before any claim/read/strategy work when the run is cancelled', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun({ status: ReviewRunStatus.cancelled }) as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));

      expect(prisma.reviewRunItem.updateMany).not.toHaveBeenCalled();
      expect(prisma.reviewRunItem.findMany).not.toHaveBeenCalled();
      expect(stubStrategy.executeItem).not.toHaveBeenCalled();
      expect(prisma.reviewRun.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------

  describe('claim', () => {
    it('claims still-"matched" items via one atomic updateMany scoped by the strategy subjectColumn', async () => {
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));

      expect(prisma.reviewRunItem.updateMany).toHaveBeenCalledWith({
        where: { runId: RUN_ID, burstGroupId: { in: ['g-1'] }, status: ReviewRunItemStatus.matched },
        data: { status: ReviewRunItemStatus.processing },
      });
    });

    it('reads back every row now "processing" for the batch as the work set (crash-safe retry)', async () => {
      // Claim affects 0 NEW rows (already flipped by a prior crashed attempt),
      // but the read-back still finds them still 'processing'.
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));

      expect(prisma.reviewRunItem.findMany).toHaveBeenCalledWith({
        where: { runId: RUN_ID, burstGroupId: { in: ['g-1'] }, status: ReviewRunItemStatus.processing },
        select: { id: true, burstGroupId: true, duplicateGroupId: true, locationSuggestionId: true },
      });
      // Still does the work for the re-read row.
      expect(stubStrategy.executeItem).toHaveBeenCalledWith(expect.anything(), 'g-1', expect.anything());
    });

    it('a retry over an already-fully-drained slice (claim 0, work set empty) touches nothing beyond the finalize check', async () => {
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1', 'g-2'] }));

      expect(stubStrategy.executeItem).not.toHaveBeenCalled();
      expect(stubStrategy.deferredEffects).not.toHaveBeenCalled();
      const counterUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Subject cascade-deleted mid-run
  // ---------------------------------------------------------------------------

  describe('subject cascade-deleted mid-run (run-item row itself is gone)', () => {
    it('a smaller work set than the claim (cascade removed a row) still processes and finalizes normally, with processedCount legitimately below matchedCount', async () => {
      // Two ids were claimed, but only ONE run-item row is read back — the
      // other's underlying subject (and therefore its review_run_items row,
      // via ON DELETE CASCADE) was deleted between claim and read-back.
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);
      prisma.reviewRunItem.count.mockResolvedValue(0); // nothing left matched/processing
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun({ matchedCount: 2 }) as any) // top-of-executeBatch
        .mockResolvedValueOnce({ failedCount: 0 } as any); // maybeFinalizeRun read

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1', 'g-2'] }));

      // Only the surviving row was processed.
      expect(stubStrategy.executeItem).toHaveBeenCalledTimes(1);
      const counterUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data.processedCount).toEqual({ increment: 1 });

      // The run still finalizes successfully — not stuck, not "incomplete".
      expect(prisma.reviewRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: ReviewRunStatus.running },
        data: { status: ReviewRunStatus.completed, finishedAt: expect.any(Date) },
      });
    });

    it('finalize keys off "no rows remain in matched/processing", never off processedCount === matchedCount', async () => {
      // No claimed ids at all for this batch (the whole chunk vanished) —
      // the finalize check must still run and succeed.
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([] as any);
      prisma.reviewRunItem.count.mockResolvedValue(0);
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun({ matchedCount: 5 }) as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);

      await expect(
        handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] })),
      ).resolves.not.toThrow();

      expect(prisma.reviewRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: ReviewRunStatus.running },
        data: { status: ReviewRunStatus.completed, finishedAt: expect.any(Date) },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Subject still exists but no longer eligible -> skipped
  // ---------------------------------------------------------------------------

  describe('subject no longer eligible (strategy returns "skipped")', () => {
    it('marks the run-item skipped; increments skippedCount and processedCount, not succeededCount/failedCount', async () => {
      stubStrategy.executeItem.mockResolvedValue('skipped');
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));

      expect(prisma.reviewRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: ReviewRunItemStatus.skipped },
      });
      const counterUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 1 },
        succeededCount: { increment: 0 },
        skippedCount: { increment: 1 },
        failedCount: { increment: 0 },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Applied outcome
  // ---------------------------------------------------------------------------

  describe('applied outcome', () => {
    it('marks the run-item applied and increments succeededCount + processedCount only', async () => {
      stubStrategy.executeItem.mockResolvedValue('applied');
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));

      expect(prisma.reviewRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: ReviewRunItemStatus.applied },
      });
      const counterUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 1 },
        succeededCount: { increment: 1 },
        skippedCount: { increment: 0 },
        failedCount: { increment: 0 },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Per-item error
  // ---------------------------------------------------------------------------

  describe('per-item error handling', () => {
    it('a strategy throw for one item marks its run-item "failed" with the error message and does not abort the rest of the batch', async () => {
      let call = 0;
      stubStrategy.executeItem.mockImplementation(async () => {
        call++;
        if (call === 1) throw new Error('constraint violation');
        return 'applied';
      });
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
        { id: 'ri-2', burstGroupId: 'g-2', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1', 'g-2'] }));

      expect(prisma.reviewRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: ReviewRunItemStatus.failed, error: 'constraint violation' },
      });
      expect(prisma.reviewRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-2' },
        data: { status: ReviewRunItemStatus.applied },
      });
    });

    it('failed items increment failedCount and processedCount, not succeededCount', async () => {
      stubStrategy.executeItem.mockRejectedValue(new Error('db down'));
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] }));

      const counterUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 1 },
        succeededCount: { increment: 0 },
        skippedCount: { increment: 0 },
        failedCount: { increment: 1 },
      });
    });

    it('never lets the batch throw even if the failure-marking update itself also fails (best-effort .catch)', async () => {
      stubStrategy.executeItem.mockRejectedValue(new Error('db down'));
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);
      (prisma.reviewRunItem.update as jest.Mock).mockImplementation((args: any) => {
        if (args?.data?.status === ReviewRunItemStatus.failed) {
          return Promise.reject(new Error('update also failed'));
        }
        return Promise.resolve({});
      });

      await expect(
        handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] })),
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // deferredEffects
  // ---------------------------------------------------------------------------

  describe('deferredEffects', () => {
    it('is called exactly once per batch, AFTER all per-item work, and is awaited', async () => {
      const order: string[] = [];
      stubStrategy.executeItem.mockImplementation(async () => {
        order.push('executeItem');
        return 'applied';
      });
      stubStrategy.deferredEffects.mockImplementation(async () => {
        order.push('deferredEffects');
      });
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
        { id: 'ri-2', burstGroupId: 'g-2', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1', 'g-2'] }));

      expect(stubStrategy.deferredEffects).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['executeItem', 'executeItem', 'deferredEffects']);
    });

    it('a rejection from deferredEffects is swallowed — the batch still completes/finalizes normally', async () => {
      stubStrategy.deferredEffects.mockRejectedValue(new Error('geocode enqueue exploded'));
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);
      prisma.reviewRunItem.count.mockResolvedValue(0);
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);

      await expect(
        handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1'] })),
      ).resolves.not.toThrow();

      expect(prisma.reviewRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: ReviewRunStatus.running },
        data: { status: ReviewRunStatus.completed, finishedAt: expect.any(Date) },
      });
    });

    it('is not called at all when the strategy does not define one (optional per the interface)', async () => {
      // Location's own strategy DOES define deferredEffects, but the generic
      // handler must not assume every strategy does (duplicate's does not).
      subjects.get.mockReturnValue({
        subjectColumn: 'duplicateGroupId' as const,
        executeItem: jest.fn().mockResolvedValue('applied'),
        // no deferredEffects defined
      });
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: null, duplicateGroupId: 'd-1', locationSuggestionId: null },
      ] as any);

      await expect(
        handler.process(makeJob({ runId: RUN_ID, subjectIds: ['d-1'] })),
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Counter increments — only this attempt's tallies
  // ---------------------------------------------------------------------------

  describe('counter increments reflect only this attempt', () => {
    it('a mixed batch (1 applied, 1 skipped, 1 failed) increments each counter by exactly its own tally', async () => {
      let call = 0;
      stubStrategy.executeItem.mockImplementation(async () => {
        call++;
        if (call === 1) return 'applied';
        if (call === 2) return 'skipped';
        throw new Error('boom');
      });
      prisma.reviewRunItem.updateMany.mockResolvedValueOnce({ count: 3 } as any);
      prisma.reviewRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null },
        { id: 'ri-2', burstGroupId: 'g-2', duplicateGroupId: null, locationSuggestionId: null },
        { id: 'ri-3', burstGroupId: 'g-3', duplicateGroupId: null, locationSuggestionId: null },
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: ['g-1', 'g-2', 'g-3'] }));

      const counterUpdate = (prisma.reviewRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 3 },
        succeededCount: { increment: 1 },
        skippedCount: { increment: 1 },
        failedCount: { increment: 1 },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Race-safe finalize
  // ---------------------------------------------------------------------------

  describe('run finalize', () => {
    it('finalizes "completed" when no matched/processing items remain and failedCount is 0', async () => {
      prisma.reviewRunItem.count.mockResolvedValue(0);
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun() as any) // top-of-executeBatch fetch
        .mockResolvedValueOnce({ failedCount: 0 } as any); // maybeFinalizeRun read

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: [] }));

      expect(prisma.reviewRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: ReviewRunStatus.running },
        data: { status: ReviewRunStatus.completed, finishedAt: expect.any(Date) },
      });
    });

    it('finalizes "completed_with_errors" when failedCount > 0', async () => {
      prisma.reviewRunItem.count.mockResolvedValue(0);
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 2 } as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: [] }));

      expect(prisma.reviewRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: ReviewRunStatus.running },
        data: { status: ReviewRunStatus.completed_with_errors, finishedAt: expect.any(Date) },
      });
    });

    it('checks remaining count against BOTH "matched" and "processing" statuses', async () => {
      prisma.reviewRunItem.count.mockResolvedValue(0);
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: [] }));

      expect(prisma.reviewRunItem.count).toHaveBeenCalledWith({
        where: {
          runId: RUN_ID,
          status: { in: [ReviewRunItemStatus.matched, ReviewRunItemStatus.processing] },
        },
      });
    });

    it('does NOT finalize while matched/processing items remain', async () => {
      prisma.reviewRunItem.count.mockResolvedValue(5);

      await handler.process(makeJob({ runId: RUN_ID, subjectIds: [] }));

      expect(prisma.reviewRun.updateMany).not.toHaveBeenCalled();
    });

    it('is race-safe: the conditional updateMany is attempted but a concurrent finalizer winning first (count: 0) does not throw', async () => {
      prisma.reviewRunItem.count.mockResolvedValue(0);
      prisma.reviewRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);
      prisma.reviewRun.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(
        handler.process(makeJob({ runId: RUN_ID, subjectIds: [] })),
      ).resolves.not.toThrow();
      expect(prisma.reviewRun.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
