/**
 * Unit tests for LocationSuggestionRunExecuteBatchHandler (bulk accept/reject
 * async run engine for the Location Inference review queue, mirroring
 * TrashEmptyExecuteBatchHandler / issue #165's precedent, adapted for
 * accept/reject rather than hard-delete).
 *
 * Covers:
 *   - No-ops: malformed payload, run gone, run cancelled.
 *   - Claim: still-'matched' items flip to 'processing' via one atomic
 *     updateMany; the work set is read back from rows now 'processing'
 *     (crash-safe — includes rows left 'processing' by a prior crashed
 *     attempt).
 *   - ACCEPT: writes MediaItem.takenLat/takenLng + coordSource='inferred',
 *     marks the LocationSuggestion 'accepted', marks the run-item 'applied',
 *     all inside one $transaction — AND enqueues a 'geocode' job AFTER the
 *     transaction commits (not inside it).
 *   - REJECT: marks the LocationSuggestion 'rejected', marks the run-item
 *     'applied' — and asserts NO geocode job is enqueued and NO coord write
 *     happens.
 *   - A suggestion no longer 'pending' (resolved individually since
 *     evaluation, or gone) -> run-item 'skipped', no clobber of the manual
 *     decision.
 *   - A per-item error -> run-item 'failed' with the error message; doesn't
 *     abort the rest of the batch.
 *   - Atomic counters ({ increment }) reflect THIS ATTEMPT's tallies only.
 *   - Cooperative cancellation: a cancelled run returns early before any
 *     claim/tx work.
 *   - Race-safe finalize: completed vs completed_with_errors; no finalize
 *     while matched/processing items remain; the conditional updateMany
 *     guard so only the batch that actually flips status='running' "wins".
 *   - Crash-safety: a retry over an already-fully-applied slice (claim count
 *     0, work-set empty) does not double-count or re-run per-item logic.
 *
 * No database required — PrismaService and EnrichmentJobService are mocked;
 * the handler is constructed directly, mirroring the trash-empty
 * execute-batch handler spec's style.
 */

import {
  EnrichmentJob,
  LocationSuggestionRunAction,
  LocationSuggestionRunItemStatus,
  LocationSuggestionRunStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { LocationSuggestionRunExecuteBatchHandler } from './location-suggestion-run-execute-batch.handler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();
const STARTED_BY_ID = randomUUID();

function makeJob(payload: Record<string, unknown>): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'location_suggestion_run_execute_batch',
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
    action: LocationSuggestionRunAction.accept,
    threshold: 80,
    status: LocationSuggestionRunStatus.running,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: STARTED_BY_ID,
    ...overrides,
  };
}

function makeSuggestion(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    mediaItemId: randomUUID(),
    circleId: CIRCLE_ID,
    lat: 10.5,
    lng: -20.1,
    status: 'pending',
    ...overrides,
  };
}

describe('LocationSuggestionRunExecuteBatchHandler', () => {
  let handler: LocationSuggestionRunExecuteBatchHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    enrichmentJobs = { enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }) };

    handler = new LocationSuggestionRunExecuteBatchHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      enrichmentJobs as unknown as EnrichmentJobService,
    );

    prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
    prisma.locationSuggestionRunItem.updateMany.mockResolvedValue({ count: 0 } as any);
    prisma.locationSuggestionRunItem.findMany.mockResolvedValue([] as any);
    prisma.locationSuggestion.findMany.mockResolvedValue([] as any);
    prisma.locationSuggestionRunItem.update.mockResolvedValue({} as any);
    prisma.locationSuggestionRun.update.mockResolvedValue({} as any);
    prisma.locationSuggestionRunItem.count.mockResolvedValue(1); // "matched/processing items remain" by default
    prisma.locationSuggestionRun.updateMany.mockResolvedValue({ count: 1 } as any);
    // $transaction([...]) — sequential array form, mirrors the real Prisma
    // client's behavior for the tuple-of-promises call the handler makes.
    prisma.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') return arg(prisma);
      return arg;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('registers itself with the handler registry on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('is a no-op when the payload is missing runId/suggestionIds', async () => {
    await handler.process(makeJob({ notARealField: true }));
    expect(prisma.locationSuggestionRun.findUnique).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is gone', async () => {
    prisma.locationSuggestionRun.findUnique.mockResolvedValue(null);
    await handler.process(makeJob({ runId: RUN_ID, suggestionIds: ['s-1'] }));
    expect(prisma.locationSuggestionRunItem.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is cancelled (cooperative cancellation before any claim/tx work)', async () => {
    prisma.locationSuggestionRun.findUnique.mockResolvedValue(
      makeRun({ status: LocationSuggestionRunStatus.cancelled }) as any,
    );
    await handler.process(makeJob({ runId: RUN_ID, suggestionIds: ['s-1'] }));
    expect(prisma.locationSuggestionRunItem.updateMany).not.toHaveBeenCalled();
    expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------

  describe('claim', () => {
    it('claims still-"matched" items via one atomic updateMany, flipping them to "processing"', async () => {
      const s1 = randomUUID();
      const s2 = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId: s1 },
        { id: 'ri-2', suggestionId: s2 },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(s1),
        makeSuggestion(s2),
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [s1, s2] }));

      expect(prisma.locationSuggestionRunItem.updateMany).toHaveBeenCalledWith({
        where: {
          runId: RUN_ID,
          suggestionId: { in: [s1, s2] },
          status: LocationSuggestionRunItemStatus.matched,
        },
        data: { status: LocationSuggestionRunItemStatus.processing },
      });
    });

    it('reads back every row now "processing" as the work set (a retry re-processes rows left "processing" by a prior crashed attempt)', async () => {
      const s1 = randomUUID();
      // This attempt's claim affects 0 NEW rows (already flipped by a prior
      // crashed attempt), but the read-back still finds them still 'processing'.
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId: s1 },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([makeSuggestion(s1)] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [s1] }));

      expect(prisma.locationSuggestionRunItem.findMany).toHaveBeenCalledWith({
        where: {
          runId: RUN_ID,
          suggestionId: { in: [s1] },
          status: LocationSuggestionRunItemStatus.processing,
        },
        select: { id: true, suggestionId: true },
      });
      // Still does the accept work for the re-read row.
      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: LocationSuggestionRunItemStatus.applied },
      });
    });

    it('a retry over an already-fully-drained slice (claim 0, work set empty) does NOT touch suggestions, counters, or geocode', async () => {
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 0 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: ['s-1', 's-2'] }));

      expect(prisma.locationSuggestion.findMany).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
      const counterUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // ACCEPT
  // ---------------------------------------------------------------------------

  describe('accept action', () => {
    it('writes MediaItem coords + coordSource "inferred", marks the suggestion accepted, marks the run-item applied — all in one $transaction', async () => {
      const suggestionId = randomUUID();
      const mediaItemId = randomUUID();
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.accept }) as any,
      );
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId, { mediaItemId, lat: 12.34, lng: 56.78 }),
      ] as any);
      prisma.mediaItem.update.mockResolvedValue({} as any);
      prisma.locationSuggestion.update.mockResolvedValue({} as any);
      prisma.locationSuggestionRunItem.update.mockResolvedValue({} as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: mediaItemId },
        data: { takenLat: 12.34, takenLng: 56.78, coordSource: 'inferred' },
      });
      expect(prisma.locationSuggestion.update).toHaveBeenCalledWith({
        where: { id: suggestionId },
        data: {
          status: 'accepted',
          resolvedById: STARTED_BY_ID,
          resolvedAt: expect.any(Date),
        },
      });
      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: LocationSuggestionRunItemStatus.applied },
      });
      // All three writes went through the same $transaction call.
      expect(prisma.$transaction).toHaveBeenCalledWith([
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ]);
    });

    it('enqueues a "geocode" job for the accepted item AFTER the transaction commits (dedup-safe, priority 100, reason backfill)', async () => {
      const suggestionId = randomUUID();
      const mediaItemId = randomUUID();
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.accept }) as any,
      );
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId, { mediaItemId }),
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith({
        type: 'geocode',
        mediaItemId,
        circleId: CIRCLE_ID,
        reason: 'backfill',
        priority: 100,
      });
      // No skipDedup — dedup-safe default, collapses with a pending geocode.
      const call = (enrichmentJobs.enqueue as jest.Mock).mock.calls[0][0];
      expect(call.skipDedup).toBeUndefined();
    });

    it('a geocode enqueue failure is swallowed (best-effort, logged) and does not fail the batch', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.accept }) as any,
      );
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId),
      ] as any);
      enrichmentJobs.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(
        handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] })),
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // REJECT
  // ---------------------------------------------------------------------------

  describe('reject action', () => {
    it('marks the suggestion rejected and the run-item applied — NO coord write, NO geocode enqueue', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.reject }) as any,
      );
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId),
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      expect(prisma.locationSuggestion.update).toHaveBeenCalledWith({
        where: { id: suggestionId },
        data: {
          status: 'rejected',
          resolvedById: STARTED_BY_ID,
          resolvedAt: expect.any(Date),
        },
      });
      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: LocationSuggestionRunItemStatus.applied },
      });
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('a reject $transaction has exactly two writes (no coord write step, unlike accept)', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.reject }) as any,
      );
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId),
      ] as any);
      prisma.locationSuggestion.update.mockResolvedValue({} as any);
      prisma.locationSuggestionRunItem.update.mockResolvedValue({} as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      const [txArg] = (prisma.$transaction as jest.Mock).mock.calls[0];
      expect(Array.isArray(txArg)).toBe(true);
      expect(txArg).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Skip: suggestion no longer pending / gone
  // ---------------------------------------------------------------------------

  describe('suggestion no longer pending (resolved individually since evaluation, or gone) -> skipped', () => {
    it('marks the run-item "skipped" and does NOT touch the suggestion or MediaItem (no clobbering a manual decision)', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId, { status: 'accepted' }), // already resolved individually
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: LocationSuggestionRunItemStatus.skipped },
      });
      expect(prisma.locationSuggestion.update).not.toHaveBeenCalled();
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('a suggestion row that vanished entirely (deleted) is also skipped', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([] as any); // gone

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: LocationSuggestionRunItemStatus.skipped },
      });
    });

    it('increments skippedCount and processedCount, not succeededCount', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId, { status: 'rejected' }),
      ] as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      const counterUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
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
  // Per-item error
  // ---------------------------------------------------------------------------

  describe('per-item error handling', () => {
    it('a transaction failure for one item marks its run-item "failed" with the error message and does not abort the rest of the batch', async () => {
      const s1 = randomUUID();
      const s2 = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 2 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId: s1 },
        { id: 'ri-2', suggestionId: s2 },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(s1),
        makeSuggestion(s2),
      ] as any);
      // First $transaction call (for s1) rejects; second (for s2) succeeds.
      let call = 0;
      prisma.$transaction.mockImplementation(async (arg: any) => {
        call++;
        if (call === 1) throw new Error('constraint violation');
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg;
      });

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [s1, s2] }));

      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-1' },
        data: { status: LocationSuggestionRunItemStatus.failed, error: 'constraint violation' },
      });
      expect(prisma.locationSuggestionRunItem.update).toHaveBeenCalledWith({
        where: { id: 'ri-2' },
        data: { status: LocationSuggestionRunItemStatus.applied },
      });
    });

    it('failed items increment failedCount and processedCount, not succeededCount', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId),
      ] as any);
      prisma.$transaction.mockRejectedValue(new Error('db down'));

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] }));

      const counterUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.processedCount,
      );
      expect(counterUpdate[0].data).toEqual({
        processedCount: { increment: 1 },
        succeededCount: { increment: 0 },
        skippedCount: { increment: 0 },
        failedCount: { increment: 1 },
      });
    });

    it('never lets the batch throw even if the per-item run-item failure update itself also fails (best-effort .catch)', async () => {
      const suggestionId = randomUUID();
      prisma.locationSuggestionRunItem.updateMany.mockResolvedValueOnce({ count: 1 } as any);
      prisma.locationSuggestionRunItem.findMany.mockResolvedValueOnce([
        { id: 'ri-1', suggestionId },
      ] as any);
      prisma.locationSuggestion.findMany.mockResolvedValueOnce([
        makeSuggestion(suggestionId),
      ] as any);
      prisma.$transaction.mockRejectedValue(new Error('db down'));
      // Only the catch-block's explicit "mark failed" call should reject — NOT
      // the eager `this.prisma.locationSuggestionRunItem.update(...)` call used
      // to build the (never-awaited, since $transaction rejects outright)
      // transaction array, or it would produce an unrelated unhandled rejection
      // unconnected to the behavior under test.
      (prisma.locationSuggestionRunItem.update as jest.Mock).mockImplementation((args: any) => {
        if (args?.data?.status === LocationSuggestionRunItemStatus.failed) {
          return Promise.reject(new Error('update also failed'));
        }
        return Promise.resolve({});
      });

      await expect(
        handler.process(makeJob({ runId: RUN_ID, suggestionIds: [suggestionId] })),
      ).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Race-safe finalize
  // ---------------------------------------------------------------------------

  describe('run finalize', () => {
    it('finalizes "completed" when no matched/processing items remain and failedCount is 0', async () => {
      prisma.locationSuggestionRunItem.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.findUnique
        .mockResolvedValueOnce(makeRun() as any) // top-of-executeBatch fetch
        .mockResolvedValueOnce({ failedCount: 0 } as any); // maybeFinalizeRun read

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [] }));

      expect(prisma.locationSuggestionRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: LocationSuggestionRunStatus.running },
        data: { status: LocationSuggestionRunStatus.completed, finishedAt: expect.any(Date) },
      });
    });

    it('finalizes "completed_with_errors" when failedCount > 0', async () => {
      prisma.locationSuggestionRunItem.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 2 } as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [] }));

      expect(prisma.locationSuggestionRun.updateMany).toHaveBeenCalledWith({
        where: { id: RUN_ID, status: LocationSuggestionRunStatus.running },
        data: {
          status: LocationSuggestionRunStatus.completed_with_errors,
          finishedAt: expect.any(Date),
        },
      });
    });

    it('checks remaining count against BOTH "matched" and "processing" statuses', async () => {
      prisma.locationSuggestionRunItem.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [] }));

      expect(prisma.locationSuggestionRunItem.count).toHaveBeenCalledWith({
        where: {
          runId: RUN_ID,
          status: {
            in: [LocationSuggestionRunItemStatus.matched, LocationSuggestionRunItemStatus.processing],
          },
        },
      });
    });

    it('does NOT finalize while matched/processing items remain', async () => {
      prisma.locationSuggestionRunItem.count.mockResolvedValue(5);

      await handler.process(makeJob({ runId: RUN_ID, suggestionIds: [] }));

      expect(prisma.locationSuggestionRun.updateMany).not.toHaveBeenCalled();
    });

    it('is race-safe: the conditional updateMany is attempted but a concurrent finalizer winning first (count: 0) does not throw', async () => {
      prisma.locationSuggestionRunItem.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.findUnique
        .mockResolvedValueOnce(makeRun() as any)
        .mockResolvedValueOnce({ failedCount: 0 } as any);
      prisma.locationSuggestionRun.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(
        handler.process(makeJob({ runId: RUN_ID, suggestionIds: [] })),
      ).resolves.not.toThrow();
      expect(prisma.locationSuggestionRun.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
