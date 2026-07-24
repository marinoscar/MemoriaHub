/**
 * Unit tests for LocationSuggestionRunEvaluateHandler (bulk accept/reject
 * async run engine for the Location Inference review queue, mirroring
 * TrashEmptyEvaluateHandler / issue #165's precedent).
 *
 * Covers:
 *   - Idempotent no-ops: missing payload, run missing, or run not in
 *     'evaluating' status.
 *   - THE KEY CORRECTNESS CASE: the confidence-filter direction depends on
 *     the run's action — an accept run matches `confidence >= floor`
 *     (threshold/100), a reject run matches `confidence < floor`. Asserted
 *     directly against the Prisma `where` clause passed to
 *     locationSuggestion.findMany, not just against fixture data, so the
 *     comparator direction itself is pinned.
 *   - Keyset pagination over the pending-suggestion scan: multiple pages
 *     (> the 1000-row PAGE_SIZE) are all materialized via createMany.
 *   - Terminal transitions: 0 matches -> completed (no execute-batch
 *     fan-out); matches > 0 -> running + enqueueExecuteBatches called.
 *   - Retry-exhaustion guard: an exception during evaluation only marks the
 *     run 'failed' once job.attempts >= ENRICHMENT_MAX_ATTEMPTS; either way
 *     the job itself always rethrows so the queue's own retry/backoff
 *     applies.
 *
 * No database required — PrismaService and LocationSuggestionRunService are
 * mocked; the handler is constructed directly (plain class, no other Nest
 * wiring needed), mirroring the trash-empty evaluate handler spec's style.
 */

import { EnrichmentJob, LocationSuggestionRunAction, LocationSuggestionRunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LocationSuggestionRunEvaluateHandler } from './location-suggestion-run-evaluate.handler';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationSuggestionRunService } from './location-suggestion-run.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const RUN_ID = randomUUID();
const CIRCLE_ID = randomUUID();

function makeJob(payload: Record<string, unknown>, attempts = 1): EnrichmentJob {
  return {
    id: randomUUID(),
    type: 'location_suggestion_run_evaluate',
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
    action: LocationSuggestionRunAction.accept,
    threshold: 80,
    status: LocationSuggestionRunStatus.evaluating,
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedById: randomUUID(),
    ...overrides,
  };
}

/** Rows shaped like the handler's { id, createdAt } select. */
function rows(n: number, startIndex = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `sugg-${startIndex + i}`,
    createdAt: new Date(2024, 0, 1, 0, 0, startIndex + i),
  }));
}

describe('LocationSuggestionRunEvaluateHandler', () => {
  let handler: LocationSuggestionRunEvaluateHandler;
  let prisma: MockPrismaService;
  let registry: jest.Mocked<Pick<EnrichmentHandlerRegistry, 'register'>>;
  let runService: jest.Mocked<Pick<LocationSuggestionRunService, 'enqueueExecuteBatches'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    registry = { register: jest.fn() };
    runService = { enqueueExecuteBatches: jest.fn().mockResolvedValue(undefined) };

    handler = new LocationSuggestionRunEvaluateHandler(
      registry as unknown as EnrichmentHandlerRegistry,
      prisma as unknown as PrismaService,
      runService as unknown as LocationSuggestionRunService,
    );

    prisma.locationSuggestionRunItem.createMany.mockResolvedValue({ count: 0 } as any);
    prisma.locationSuggestionRun.update.mockResolvedValue({} as any);
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
    prisma.locationSuggestionRun.findUnique.mockResolvedValue(null);
    await handler.process(makeJob({ runId: RUN_ID }));
    expect(prisma.locationSuggestion.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the run is not in "evaluating" status (idempotent re-delivery)', async () => {
    prisma.locationSuggestionRun.findUnique.mockResolvedValue(
      makeRun({ status: LocationSuggestionRunStatus.running }) as any,
    );
    await handler.process(makeJob({ runId: RUN_ID }));
    expect(prisma.locationSuggestion.findMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the job payload is missing runId', async () => {
    await handler.process(makeJob({}));
    expect(prisma.locationSuggestionRun.findUnique).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Confidence-filter direction (the load-bearing correctness case)
  // ---------------------------------------------------------------------------

  describe('confidence-filter direction by action', () => {
    it('an ACCEPT run filters confidence >= threshold/100 (high-confidence suggestions)', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.accept, threshold: 80 }) as any,
      );
      prisma.locationSuggestion.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const [call] = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toEqual({
        circleId: CIRCLE_ID,
        status: 'pending',
        confidence: { gte: 0.8 },
      });
    });

    it('a REJECT run filters confidence < threshold/100 (low-confidence noise) — NOT gte, NOT lte', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.reject, threshold: 80 }) as any,
      );
      prisma.locationSuggestion.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const [call] = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toEqual({
        circleId: CIRCLE_ID,
        status: 'pending',
        confidence: { lt: 0.8 },
      });
      // Explicitly guard against the inverted/accept-shaped filter leaking in.
      expect(call[0].where.confidence).not.toHaveProperty('gte');
      expect(call[0].where.confidence).not.toHaveProperty('lte');
    });

    it('only materializes suggestions returned by the (correctly-directed) query — reject run does not include an accept-matching row', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.reject, threshold: 50 }) as any,
      );
      // Simulate the DB already having applied the `lt 0.5` filter server-side —
      // only low-confidence rows come back.
      prisma.locationSuggestion.findMany
        .mockResolvedValueOnce([{ id: 'low-conf-sugg', createdAt: new Date() }] as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(prisma.locationSuggestionRunItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [{ runId: RUN_ID, suggestionId: 'low-conf-sugg', status: 'matched' }],
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Keyset pagination
  // ---------------------------------------------------------------------------

  describe('keyset pagination over the pending-suggestion scan', () => {
    it('materializes all rows across multiple pages (> the 1000-row PAGE_SIZE) into location_suggestion_run_items', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      const page1 = rows(1000, 0);
      const page2 = rows(500, 1000);
      prisma.locationSuggestion.findMany
        .mockResolvedValueOnce(page1 as any)
        .mockResolvedValueOnce(page2 as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(prisma.locationSuggestionRunItem.createMany).toHaveBeenCalledTimes(2);
      const call1 = (prisma.locationSuggestionRunItem.createMany as jest.Mock).mock.calls[0][0];
      const call2 = (prisma.locationSuggestionRunItem.createMany as jest.Mock).mock.calls[1][0];
      expect(call1.data).toHaveLength(1000);
      expect(call2.data).toHaveLength(500);
      expect(call1.skipDuplicates).toBe(true);
      expect(call1.data[0]).toMatchObject({
        runId: RUN_ID,
        suggestionId: 'sugg-0',
        status: 'matched',
      });

      const matchedCountUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => 'matchedCount' in (c[0].data ?? {}),
      );
      expect(matchedCountUpdate[0].data.matchedCount).toBe(1500);
    });

    it('orders by (createdAt DESC, id DESC)', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestion.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const [call] = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls;
      expect(call[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('advances the cursor strictly after the last row of the prior page (no duplicate rows re-fetched)', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      const page1 = rows(1000, 0);
      prisma.locationSuggestion.findMany
        .mockResolvedValueOnce(page1 as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      expect(prisma.locationSuggestion.findMany).toHaveBeenCalledTimes(2);
      const secondCallWhere = (prisma.locationSuggestion.findMany as jest.Mock).mock.calls[1][0]
        .where;
      expect(secondCallWhere.AND).toBeDefined();
      expect(JSON.stringify(secondCallWhere)).toContain('sugg-999');
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------------

  describe('terminal run transitions', () => {
    it('0 matches -> run status completed, no execute-batch fan-out', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestion.findMany.mockResolvedValue([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(LocationSuggestionRunStatus.completed);
      expect(statusUpdate[0].data.finishedAt).toEqual(expect.any(Date));
      expect(runService.enqueueExecuteBatches).not.toHaveBeenCalled();
    });

    it('matches > 0 -> run transitions to running and enqueueExecuteBatches is called with (runId, circleId)', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestion.findMany
        .mockResolvedValueOnce(rows(3) as any)
        .mockResolvedValueOnce([] as any);

      await handler.process(makeJob({ runId: RUN_ID }));

      const statusUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status,
      );
      expect(statusUpdate[0].data.status).toBe(LocationSuggestionRunStatus.running);
      expect(statusUpdate[0].data.startedAt).toEqual(expect.any(Date));
      expect(runService.enqueueExecuteBatches).toHaveBeenCalledWith(RUN_ID, CIRCLE_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // Retry-exhaustion guard
  // ---------------------------------------------------------------------------

  describe('retry-exhaustion guard (attempts >= ENRICHMENT_MAX_ATTEMPTS)', () => {
    it('rethrows WITHOUT marking the run failed when attempts are still under budget', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestion.findMany.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        handler.process(makeJob({ runId: RUN_ID }, 1)), // attempts=1 < default max (3)
      ).rejects.toThrow('DB connection lost');

      const failedUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === LocationSuggestionRunStatus.failed,
      );
      expect(failedUpdate).toBeUndefined();
    });

    it('marks the run "failed" with lastError once attempts >= ENRICHMENT_MAX_ATTEMPTS, and still rethrows', async () => {
      process.env['ENRICHMENT_MAX_ATTEMPTS'] = '3';
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestion.findMany.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        handler.process(makeJob({ runId: RUN_ID }, 3)), // attempts=3 >= max (3)
      ).rejects.toThrow('DB connection lost');

      const failedUpdate = (prisma.locationSuggestionRun.update as jest.Mock).mock.calls.find(
        (c) => c[0].data?.status === LocationSuggestionRunStatus.failed,
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.lastError).toBe('DB connection lost');
      expect(failedUpdate[0].data.finishedAt).toEqual(expect.any(Date));
    });

    it('never throws out of the failed-marking itself even if that update also fails (best-effort .catch)', async () => {
      process.env['ENRICHMENT_MAX_ATTEMPTS'] = '1';
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestion.findMany.mockRejectedValue(new Error('primary failure'));
      prisma.locationSuggestionRun.update.mockRejectedValue(new Error('update also failed'));

      await expect(handler.process(makeJob({ runId: RUN_ID }, 1))).rejects.toThrow(
        'primary failure',
      );
    });
  });
});
