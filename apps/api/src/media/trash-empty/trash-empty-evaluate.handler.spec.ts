/**
 * Unit tests for TrashEmptyEvaluateHandler (issue #165 — Empty Trash at scale).
 *
 * Covers:
 *   - Idempotent no-ops: run missing, or run not in 'evaluating' status.
 *   - Keyset pagination over the trashed-item scan: multiple pages (> the
 *     1000-row PAGE_SIZE) are all materialized via createMany.
 *   - Terminal transitions: 0 matches -> completed (no execute-batch fan-out);
 *     matches > 0 -> running + enqueueExecuteBatches called.
 *   - Retry-exhaustion guard: an exception during evaluation only marks the
 *     run 'failed' once job.attempts >= ENRICHMENT_MAX_ATTEMPTS; either way
 *     the job itself always rethrows so the queue's own retry/backoff applies.
 *
 * No database required — PrismaService and TrashEmptyRunService are mocked;
 * the handler is constructed directly (plain class, no other Nest wiring
 * needed), mirroring the workflow evaluate handler spec's style.
 */

import { EnrichmentJob, TrashEmptyRunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { TrashEmptyEvaluateHandler } from './trash-empty-evaluate.handler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { TrashEmptyRunService } from './trash-empty-run.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeJob(payload: Record<string, unknown>, attempts = 1): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'trash_empty_evaluate',
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
    status: TrashEmptyRunStatus.evaluating,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: randomUUID(),
    ...overrides,
  };
}

/** Rows shaped like the handler's { id, capturedAt } select. */
function rows(n: number, startIndex = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${startIndex + i}`,
    capturedAt: new Date(2024, 0, 1, 0, 0, startIndex + i),
  }));
}

describe('TrashEmptyEvaluateHandler', () => {
  let handler: TrashEmptyEvaluateHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let runService: jest.Mocked<Pick<TrashEmptyRunService, 'enqueueExecuteBatches'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    runService = { enqueueExecuteBatches: jest.fn().mockResolvedValue(undefined) };

    handler = new TrashEmptyEvaluateHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      runService as unknown as TrashEmptyRunService,
    );

    prisma.trashEmptyRunItem.createMany.mockResolvedValue({ count: 0 } as any);
    prisma.trashEmptyRun.update.mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['ENRICHMENT_MAX_ATTEMPTS'];
  });

  it('registers itself with the handler registry on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('is a no-op when the run is missing (idempotent — run deleted mid-flight)', async () => {
    prisma.trashEmptyRun.findUnique.mockResolvedValue(null);
    await handler.process(makeJob({ runId: RUN_ID }));
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is not in "evaluating" status (idempotent re-delivery)', async () => {
    prisma.trashEmptyRun.findUnique.mockResolvedValue(
      makeRun({ status: TrashEmptyRunStatus.running }) as any,
    );
    await handler.process(makeJob({ runId: RUN_ID }));
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the job payload is missing runId', async () => {
    await handler.process(makeJob({}));
    expect(prisma.trashEmptyRun.findUnique).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Keyset pagination
  // ---------------------------------------------------------------------------

  describe('keyset pagination over the trashed-item scan', () => {
    it('materializes all rows across multiple pages (> the 1000-row PAGE_SIZE) into trash_empty_run_items', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      const page1 = rows(1000, 0);
      const page2 = rows(500, 1000);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(page1 as any)
        .mockResolvedValueOnce(page2 as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      // Two createMany calls, one per non-empty page.
      expect(prisma.trashEmptyRunItem.createMany).toHaveBeenCalledTimes(2);
      const call1 = (prisma.trashEmptyRunItem.createMany as jest.Mock).mock.calls[0][0];
      const call2 = (prisma.trashEmptyRunItem.createMany as jest.Mock).mock.calls[1][0];
      expect(call1.data).toHaveLength(1000);
      expect(call2.data).toHaveLength(500);
      expect(call1.skipDuplicates).toBe(true);
      expect(call1.data[0]).toMatchObject({
        runId: RUN_ID,
        mediaItemId: 'item-0',
        status: 'matched',
      });

      const matchedCountUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(matchedCountUpdate[0].data.matchedCount).toBe(1500);
    });

    it('scopes the scan to circleId + deletedAt IS NOT NULL, ordered (capturedAt DESC NULLS LAST, id DESC)', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const [call] = (prisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toEqual({ circleId: CIRCLE_ID, deletedAt: { not: null } });
      expect(call[0].orderBy).toEqual([
        { capturedAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ]);
    });

    it('advances the cursor strictly after the last row of the prior page (no duplicate rows re-fetched)', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      // A full page (exactly PAGE_SIZE=1000) forces a second fetch; the second
      // page comes back empty, ending the loop.
      const page1 = rows(1000, 0);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(page1 as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(prisma.mediaItem.findMany).toHaveBeenCalledTimes(2);
      const secondCallWhere = (prisma.mediaItem.findMany as jest.Mock).mock.calls[1][0].where;
      // AND[baseWhere, afterCursor] — the cursor predicate references the last
      // row's id ('item-999') from page1.
      expect(secondCallWhere.AND).toBeDefined();
      expect(JSON.stringify(secondCallWhere)).toContain('item-999');
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------------

  describe('terminal run transitions', () => {
    it('0 matches -> run status completed, no execute-batch fan-out', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(TrashEmptyRunStatus.completed);
      expect(statusUpdate[0].data.finishedAt).toEqual(expect.any(Date));
      expect(runService.enqueueExecuteBatches).not.toHaveBeenCalled();
    });

    it('matches > 0 -> run transitions to running and enqueueExecuteBatches is called with (runId, circleId)', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany
        .mockResolvedValueOnce(rows(3) as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(TrashEmptyRunStatus.running);
      expect(statusUpdate[0].data.startedAt).toEqual(expect.any(Date));
      expect(runService.enqueueExecuteBatches).toHaveBeenCalledWith(RUN_ID, CIRCLE_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // Retry-exhaustion guard
  // ---------------------------------------------------------------------------

  describe('retry-exhaustion guard (attempts >= ENRICHMENT_MAX_ATTEMPTS)', () => {
    it('rethrows WITHOUT marking the run failed when attempts are still under budget', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        handler.process(makeJob({ runId: RUN_ID }, 1)), // attempts=1 < default max (3)
      ).rejects.toThrow('DB connection lost');

      const failedUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === TrashEmptyRunStatus.failed,
      );
      expect(failedUpdate).toBeUndefined();
    });

    it('marks the run "failed" with lastError once attempts >= ENRICHMENT_MAX_ATTEMPTS, and still rethrows', async () => {
      process.env['ENRICHMENT_MAX_ATTEMPTS'] = '3';
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        handler.process(makeJob({ runId: RUN_ID }, 3)), // attempts=3 >= max (3)
      ).rejects.toThrow('DB connection lost');

      const failedUpdate = (prisma.trashEmptyRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === TrashEmptyRunStatus.failed,
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.lastError).toBe('DB connection lost');
      expect(failedUpdate[0].data.finishedAt).toEqual(expect.any(Date));
    });

    it('never throws out of the failed-marking itself even if that update also fails (best-effort .catch)', async () => {
      process.env['ENRICHMENT_MAX_ATTEMPTS'] = '1';
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.mediaItem.findMany.mockRejectedValue(new Error('primary failure'));
      prisma.trashEmptyRun.update.mockRejectedValue(new Error('update also failed'));

      // The ORIGINAL error propagates, not the secondary update failure.
      await expect(handler.process(makeJob({ runId: RUN_ID }, 1))).rejects.toThrow(
        'primary failure',
      );
    });
  });
});
