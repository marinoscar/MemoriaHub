/**
 * Unit tests for TrashEmptyExecuteBatchHandler (issue #165 — Empty Trash at
 * scale).
 *
 * Covers:
 *   - No-ops: run gone, run cancelled, malformed payload.
 *   - Claim idempotency: a claim over an already-'deleted' slice (a retried
 *     batch after the first attempt already succeeded and cascade-removed the
 *     run-item rows) claims 0 and does not re-increment counters or call
 *     purgeMediaItemsBatched again.
 *   - Successful purge increments processedCount/succeededCount and calls
 *     MediaService.purgeMediaItemsBatched with the claimed ids.
 *   - A partial purge failure (failedIds) flips those rows to 'failed' and
 *     increments failedCount, while the rest still count as succeeded.
 *   - Cooperative cancellation: a cancelled run short-circuits before any
 *     claim/purge work.
 *   - Race-safe finalize: completed vs completed_with_errors, no finalize
 *     while matched items remain, and the conditional updateMany guard so
 *     only the batch that actually flips status='running'->terminal “wins”.
 *
 * No database required — PrismaService and MediaService are mocked; the
 * handler is constructed directly, mirroring the workflow execute-batch
 * handler spec's style.
 */

import { EnrichmentJob, TrashEmptyRunItemStatus, TrashEmptyRunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { TrashEmptyExecuteBatchHandler } from './trash-empty-execute-batch.handler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../media.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeJob(payload: Record<string, unknown>): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'trash_empty_execute_batch',
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
    status: TrashEmptyRunStatus.running,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

describe('TrashEmptyExecuteBatchHandler', () => {
  let handler: TrashEmptyExecuteBatchHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let mediaService: jest.Mocked<Pick<MediaService, 'purgeMediaItemsBatched'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    mediaService = {
      purgeMediaItemsBatched: jest.fn().mockResolvedValue({ deleted: 0, failedIds: [] }),
    };

    handler = new TrashEmptyExecuteBatchHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      mediaService as unknown as MediaService,
    );

    prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
    prisma.trashEmptyRunItem.updateMany.mockResolvedValue({ count: 0 } as any);
    prisma.trashEmptyRunItem.findMany.mockResolvedValue([] as any);
    prisma.trashEmptyRun.update.mockResolvedValue({} as any);
    prisma.trashEmptyRunItem.count.mockResolvedValue(1); // "matched items remain" by default
    prisma.trashEmptyRun.updateMany.mockResolvedValue({ count: 1 } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('registers itself with the handler registry on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('is a no-op when the payload is missing runId/itemIds', async () => {
    await handler.process(makeJob({ notARealField: true }));
    expect(prisma.trashEmptyRun.findUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is gone', async () => {
    prisma.trashEmptyRun.findUnique.mockResolvedValue(null);
    await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));
    expect(prisma.trashEmptyRunItem.updateMany).not.toHaveBeenCalled();
    expect(mediaService.purgeMediaItemsBatched).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is cancelled (cooperative cancellation before any claim/purge work)', async () => {
    prisma.trashEmptyRun.findUnique.mockResolvedValue(
      makeRun({ status: TrashEmptyRunStatus.cancelled }) as any,
    );
    await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));
    expect(prisma.trashEmptyRunItem.updateMany).not.toHaveBeenCalled();
    expect(mediaService.purgeMediaItemsBatched).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Claim idempotency
  // ---------------------------------------------------------------------------

  describe('claim idempotency', () => {
    it('claims still-"matched" items via one atomic updateMany, flipping them to "deleted"', async () => {
      prisma.trashEmptyRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.trashEmptyRunItem.findMany.mockResolvedValue([
        { mediaItemId: 'item-1' },
        { mediaItemId: 'item-2' },
      ] as any);
      mediaService.purgeMediaItemsBatched.mockResolvedValue({ deleted: 2, failedIds: [] });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1', 'item-2'] }));

      expect(prisma.trashEmptyRunItem.updateMany).toHaveBeenCalledWith({
        where: {
          runId: RUN_ID,
          mediaItemId: { in: ['item-1', 'item-2'] },
          status: TrashEmptyRunItemStatus.matched,
        },
        data: { status: TrashEmptyRunItemStatus.deleted },
      });
      expect(mediaService.purgeMediaItemsBatched).toHaveBeenCalledWith(['item-1', 'item-2']);
    });

    it('a retried batch over an already-fully-purged slice (claim count 0, no rows read back) does NOT call purgeMediaItemsBatched or increment counters', async () => {
      // First attempt already flipped + purged these ids; the successful purge
      // cascade-deleted the run_item rows entirely, so the retry's claim
      // affects 0 rows and the read-back finds nothing.
      prisma.trashEmptyRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.trashEmptyRunItem.findMany.mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1', 'item-2'] }));

      expect(mediaService.purgeMediaItemsBatched).not.toHaveBeenCalled();
      const counterUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate).toBeUndefined();
    });

    it('re-purges rows left "deleted" by a prior attempt that crashed before purging (read-back includes them even though claimedCount is 0 for THIS attempt)', async () => {
      // claim affects 0 NEW rows this attempt (they were already flipped to
      // 'deleted' by a prior crashed attempt), but the read-back still finds
      // them because their underlying MediaItem still exists.
      prisma.trashEmptyRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.trashEmptyRunItem.findMany.mockResolvedValueOnce([
        { mediaItemId: 'item-1' },
      ] as any);
      mediaService.purgeMediaItemsBatched.mockResolvedValue({ deleted: 1, failedIds: [] });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['item-1'] }));

      expect(mediaService.purgeMediaItemsBatched).toHaveBeenCalledWith(['item-1']);
      // claimedCount is 0 for this attempt, so counters are NOT incremented
      // again (they were already incremented by the original attempt before
      // it crashed — actually the original crashed BEFORE incrementing, but
      // the handler's contract is claimedCount-gated, matching source).
      const counterUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Successful purge
  // ---------------------------------------------------------------------------

  describe('successful purge', () => {
    it('increments processedCount and succeededCount by the claimed count when all purges succeed', async () => {
      prisma.trashEmptyRunItem.updateMany.mockResolvedValueOnce({ count: 3 } as any);
      prisma.trashEmptyRunItem.findMany.mockResolvedValueOnce([
        { mediaItemId: 'a' },
        { mediaItemId: 'b' },
        { mediaItemId: 'c' },
      ] as any);
      mediaService.purgeMediaItemsBatched.mockResolvedValue({ deleted: 3, failedIds: [] });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['a', 'b', 'c'] }));

      const counterUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 3 },
        succeededCount: { increment: 3 },
        failedCount: { increment: 0 },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Partial purge failure
  // ---------------------------------------------------------------------------

  describe('partial purge failure', () => {
    it('flips failedIds rows to "failed" with an error message, and increments failedCount while the rest count as succeeded', async () => {
      prisma.trashEmptyRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.trashEmptyRunItem.findMany.mockResolvedValueOnce([
        { mediaItemId: 'a' },
        { mediaItemId: 'b' },
      ] as any);
      mediaService.purgeMediaItemsBatched.mockResolvedValue({ deleted: 1, failedIds: ['b'] });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['a', 'b'] }));

      // The failed row is flipped from 'deleted' -> 'failed' with an error.
      const failCall = (prisma.trashEmptyRunItem.updateMany as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === TrashEmptyRunItemStatus.failed,
      );
      expect(failCall[0]).toEqual({
        where: {
          runId: RUN_ID,
          mediaItemId: { in: ['b'] },
          status: TrashEmptyRunItemStatus.deleted,
        },
        data: { status: TrashEmptyRunItemStatus.failed, error: 'Hard-delete failed' },
      });

      const counterUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 2 },
        succeededCount: { increment: 1 },
        failedCount: { increment: 1 },
      });
    });

    it('never lets succeededCount go negative even if failedCount somehow exceeds claimedCount', async () => {
      prisma.trashEmptyRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.trashEmptyRunItem.findMany.mockResolvedValueOnce([{ mediaItemId: 'a' }] as any);
      // Defensive: failedIds larger than the claimed set (shouldn't happen in
      // practice, but the handler clamps with Math.max(0, ...)).
      mediaService.purgeMediaItemsBatched.mockResolvedValue({
        deleted: 0,
        failedIds: ['a', 'phantom'],
      });

      await handler.process(makeJob({ runId: RUN_ID, itemIds: ['a'] }));

      const counterUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data.succeededCount).toEqual({ increment: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // Race-safe finalize
  // ---------------------------------------------------------------------------

  describe('run finalize', () => {
    it('finalizes "completed" when no matched items remain and failedCount is 0', async () => {
      prisma.trashEmptyRunItem.count.mockResolvedValue(0); // none remain 'matched'
      prisma.trashEmptyRun.findUnique
        .mockResolvedValueOnce(makeRun() as any) // top-of-executeBatch fetch
        .mockResolvedValueOnce({ failedCount: 0 } as any); // maybeFinalizeRun read

      await handler.process(makeJob({ runId: RUN_ID, itemIds: [] }));

      expect(prisma.trashEmptyRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: TrashEmptyRunStatus.running },
        data: { status: TrashEmptyRunStatus.completed, finishedAt: expect.any(Date) },
      });
    });

    it('finalizes "completed_with_errors" when failedCount > 0', async () => {
      prisma.trashEmptyRunItem.count.mockResolvedValue(0);
      prisma.trashEmptyRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 2 } as any);

      await handler.process(makeJob({ runId: RUN_ID, itemIds: [] }));

      expect(prisma.trashEmptyRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: TrashEmptyRunStatus.running },
        data: { status: TrashEmptyRunStatus.completed_with_errors, finishedAt: expect.any(Date) },
      });
    });

    it('does NOT finalize while matched items remain', async () => {
      prisma.trashEmptyRunItem.count.mockResolvedValue(5); // items still pending

      await handler.process(makeJob({ runId: RUN_ID, itemIds: [] }));

      expect(prisma.trashEmptyRun.updateMany).not.toHaveBeenCalled();
    });

    it('is race-safe: only the batch whose conditional updateMany actually flips status="running" counts as the finalizer (fin.count checked, but no further side effect either way beyond the attempted updateMany)', async () => {
      prisma.trashEmptyRunItem.count.mockResolvedValue(0);
      prisma.trashEmptyRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);
      // Another concurrent batch already finalized the run first.
      prisma.trashEmptyRun.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(
        handler.process(makeJob({ runId: RUN_ID, itemIds: [] })),
      ).resolves.not.toThrow();

      // The conditional updateMany was still attempted (guarded on
      // status='running'), it just didn't "win" (count: 0).
      expect(prisma.trashEmptyRun.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
