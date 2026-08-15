/**
 * Unit tests for EnhancementBatchesController (epic #420, issue #421).
 *
 * EnhancementBatchesController is a thin pass-through — list()/get()/cancel()
 * each delegate straight to MediaEnhancementService.{listBatches,getBatch,
 * cancelBatch}() — so the behavior worth testing (status derivation, counter
 * math, cancel semantics) lives in the SERVICE's tallyBatches/serializeBatch/
 * cancelBatch/loadBatch. This file wires the REAL MediaEnhancementService
 * behind the controller (only its I/O boundaries — PrismaService and
 * CircleMembershipService — are mocked), mirroring the mocking strategy in
 * media-enhancement.service.spec.ts, so what's under test is the actual
 * controller -> service call path with real derivation logic.
 *
 * The controller is instantiated directly (`new EnhancementBatchesController(
 * service)`, mirroring features.controller.spec.ts / db-backup.controller.spec.ts)
 * rather than through a compiled Nest TestingModule with `controllers: [...]`
 * — the latter eagerly resolves the `@Auth()` guard chain's constructor deps
 * (JwtAuthGuard -> PatService -> ...) even without an app instance, which this
 * module doesn't provide and doesn't need: guard/RBAC enforcement is exercised
 * separately by the real-HTTP-stack pattern in media-enhancement.controller.spec.ts.
 *

 * Covers:
 *   - Status derivation, table-driven over prisma.mediaEnhancement.groupBy
 *     fixtures: running / completed / completed_with_errors / cancelled
 *     (cancelledAt wins over everything, including still-pending rows).
 *   - The empty-batch case (zero rows -> completed, never a stuck running).
 *   - The cascade case: a batch whose row count has SHRUNK below
 *     requestedCount/queuedCount (a hard-deleted MediaItem cascades its
 *     MediaEnhancement row away) still reaches a terminal status, because
 *     serializeBatch keys off "no rows remain pending/processing", never off
 *     counter equality (schema.prisma:2036-2043 documents the same failure
 *     mode for review_runs).
 *   - The exact response field set (BaseRun contract + batch-specific extras)
 *     and the counter-derivation formulas.
 *   - Cancel semantics (pending rows + their pending jobs withdrawn;
 *     processing rows and running jobs left untouched), cancel-on-terminal
 *     400, cancel-by-non-collaborator 403, unknown id 404, viewer-can-GET-
 *     but-cannot-cancel.
 *   - List: paginated, newest-first, circle-scoped, one groupBy per page.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole, JobStatus, MediaEnhancementStatus } from '@prisma/client';
import { EnhancementBatchesController } from './enhancement-batches.controller';
import { MediaEnhancementService } from './media-enhancement.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

const USER: RequestUser = {
  id: 'user-1',
  email: 'user@example.com',
  roles: ['Contributor'],
  permissions: ['media:read', 'media:write'],
  isActive: true,
};

const CIRCLE_ID = 'circle-1';
const BATCH_ID = 'batch-1';

function makeBatch(overrides: Record<string, any> = {}) {
  return {
    id: BATCH_ID,
    circleId: CIRCLE_ID,
    requestedCount: 3,
    queuedCount: 3,
    skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 },
    params: {},
    source: 'selection',
    cancelledAt: null,
    lastError: null,
    createdById: USER.id,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:05:00Z'),
    ...overrides,
  };
}

/**
 * Builds the raw groupBy rows tallyBatches() consumes: one row per
 * (batchId, status) pair actually present, matching the shape of
 * `prisma.mediaEnhancement.groupBy({ by: ['batchId', 'status'], ... })`.
 */
function groupByRows(
  batchId: string,
  counts: Partial<Record<MediaEnhancementStatus, number>>,
  maxUpdatedAt: Date = new Date('2026-01-01T00:10:00Z'),
) {
  return Object.entries(counts)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([status, count]) => ({
      batchId,
      status: status as MediaEnhancementStatus,
      _count: { _all: count as number },
      _max: { updatedAt: maxUpdatedAt },
    }));
}

describe('EnhancementBatchesController', () => {
  let controller: EnhancementBatchesController;
  let mockPrisma: MockPrismaService;
  let mockMembership: { assertCircleAccess: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    mockMembership = {
      assertCircleAccess: jest
        .fn()
        .mockResolvedValue({ role: CircleRole.collaborator, isSuperAdmin: false }),
    };

    // listBatches runs findMany + count inside a `$transaction([...])` array
    // form — resolve it as Promise.all, mirroring media-enhancement.service.spec.ts.
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(mockPrisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaEnhancementService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: StorageProviderResolver, useValue: {} },
        { provide: StorageProcessingRecoveryService, useValue: {} },
        { provide: MediaMetadataSyncService, useValue: {} },
        { provide: MediaEnrichmentService, useValue: {} },
        { provide: MediaThumbnailService, useValue: {} },
        { provide: EnrichmentJobService, useValue: {} },
        { provide: SystemSettingsService, useValue: {} },
      ],
    }).compile();

    const service = module.get<MediaEnhancementService>(MediaEnhancementService);
    controller = new EnhancementBatchesController(service);
  });

  // ===========================================================================
  // GET /enhancement-batches/:id — status derivation (table-driven)
  // ===========================================================================

  describe('get() — status derivation', () => {
    it.each<[string, Partial<Record<MediaEnhancementStatus, number>>, Date | null, string]>([
      ['running: only pending rows', { pending: 2 }, null, 'running'],
      ['running: only processing rows', { processing: 1 }, null, 'running'],
      [
        'running: a pending row present alongside already-succeeded ones',
        { pending: 1, ready: 2 },
        null,
        'running',
      ],
      ['completed: all ready, none pending/processing/failed', { ready: 3 }, null, 'completed'],
      [
        'completed: every succeeded-alias status (ready/applied/discarded/expired), no failed',
        { ready: 1, applied: 1, discarded: 1, expired: 1 },
        null,
        'completed',
      ],
      [
        'completed_with_errors: a failed row present, none pending/processing',
        { ready: 1, failed: 2 },
        null,
        'completed_with_errors',
      ],
      ['completed_with_errors: every row failed', { failed: 3 }, null, 'completed_with_errors'],
      [
        'cancelled: cancelledAt set WINS even though a pending row is still present',
        { pending: 1, ready: 2 },
        new Date('2026-01-01T00:02:00Z'),
        'cancelled',
      ],
      [
        'cancelled: cancelledAt set with every row already terminal (cancelled)',
        { cancelled: 3 },
        new Date('2026-01-01T00:02:00Z'),
        'cancelled',
      ],
    ])('%s -> %s', async (_label, counts, cancelledAt, expectedStatus) => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(
        makeBatch({ cancelledAt }),
      );
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, counts),
      );

      const result = await controller.get(BATCH_ID, USER);

      expect(result.status).toBe(expectedStatus);
    });

    it('the empty-batch case: zero rows renders a terminal completed, never a stuck running', async () => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(
        makeBatch({ requestedCount: 0, queuedCount: 0 }),
      );
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await controller.get(BATCH_ID, USER);

      expect(result.status).toBe('completed');
      expect(result.matchedCount).toBe(0);
      expect(result.processedCount).toBe(0);
    });

    // -------------------------------------------------------------------------
    // THE CASCADE TEST — a hard-deleted MediaItem cascades its MediaEnhancement
    // row away (schema.prisma: `mediaItemId ... onDelete: Cascade`), so a
    // batch's row count can legitimately SHRINK below what was queued.
    // serializeBatch must key off "no rows remain pending/processing", never
    // off `processedCount === matchedCount` (or, transitively, off
    // queuedCount) — the exact failure documented for review_runs at
    // schema.prisma:2036-2043. Simulated here by a groupBy fixture whose
    // total row count (2) is below the batch's own requestedCount/queuedCount
    // (5): the "missing" 3 rows are gone, not merely unprocessed.
    // -------------------------------------------------------------------------

    it('CASCADE: a batch whose row count shrank below requestedCount/queuedCount (deleted media items) still reaches completed', async () => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(
        makeBatch({ requestedCount: 5, queuedCount: 5 }),
      );
      // Only 2 of the original 5 enhancement rows still exist; both succeeded.
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { ready: 1, applied: 1 }),
      );

      const result = await controller.get(BATCH_ID, USER);

      expect(result.matchedCount).toBe(2); // NOT 5 — the shrink is real
      expect(result.matchedCount).toBeLessThan(result.queuedCount);
      expect(result.status).toBe('completed'); // NOT stuck at 'running'
    });

    it('CASCADE: the shrunk set can also surface completed_with_errors when a failure is among the survivors', async () => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(
        makeBatch({ requestedCount: 10, queuedCount: 10 }),
      );
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { ready: 2, failed: 1 }), // 7 rows vanished via cascade
      );

      const result = await controller.get(BATCH_ID, USER);

      expect(result.matchedCount).toBe(3);
      expect(result.status).toBe('completed_with_errors');
    });
  });

  // ===========================================================================
  // GET /enhancement-batches/:id — exact response shape
  // ===========================================================================

  describe('get() — response shape', () => {
    beforeEach(() => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(
        makeBatch({ requestedCount: 6, queuedCount: 5 }),
      );
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, {
          pending: 1,
          processing: 1,
          ready: 1,
          applied: 1,
          failed: 1,
          cancelled: 1,
        }),
      );
    });

    it('emits every field of the shared BaseRun contract, correctly derived', async () => {
      const result = await controller.get(BATCH_ID, USER);

      expect(result).toMatchObject({
        id: BATCH_ID,
        circleId: CIRCLE_ID,
        status: 'running', // pending+processing still present
        matchedCount: 6, // 1+1+1+1+1+1
        processedCount: 4, // succeeded(2) + failed(1) + skipped(1)
        succeededCount: 2, // ready + applied
        failedCount: 1,
        skippedCount: 1, // cancelled
        startedById: USER.id, // == batch.createdById
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        startedAt: expect.any(Date), // == batch.createdAt (no evaluating phase)
        finishedAt: null, // still running
        lastError: null,
      });
    });

    it('the complete key set is EXACTLY the 14 BaseRun fields plus the 6 documented batch-specific extras (no more, no fewer)', async () => {
      const result = await controller.get(BATCH_ID, USER);

      // Deliberately more complete than "assert only the BaseRun subset" —
      // this catches a rename/removal of ANY field, base or extra, per the
      // code's own comment: "Batch-specific extras, outside the BaseRun
      // contract" (requestedCount, queuedCount, skipped, params, source,
      // cancelledAt).
      expect(Object.keys(result as Record<string, unknown>).sort()).toEqual(
        [
          // BaseRun contract (the RunProgressPanel / useRunPolling shape)
          'id',
          'circleId',
          'status',
          'matchedCount',
          'processedCount',
          'succeededCount',
          'failedCount',
          'skippedCount',
          'startedById',
          'createdAt',
          'updatedAt',
          'startedAt',
          'finishedAt',
          'lastError',
          // Batch-specific extras
          'requestedCount',
          'queuedCount',
          'skipped',
          'params',
          'source',
          'cancelledAt',
        ].sort(),
      );
    });

    it('finishedAt is null while running and set to the tally max updatedAt once terminal', async () => {
      const runningResult = await controller.get(BATCH_ID, USER);
      expect(runningResult.finishedAt).toBeNull();

      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { ready: 1 }, new Date('2026-01-01T00:09:00Z')),
      );
      const terminalResult = await controller.get(BATCH_ID, USER);
      expect(terminalResult.finishedAt).toEqual(new Date('2026-01-01T00:09:00Z'));
    });

    it('asserts circle access at the viewer level', async () => {
      await controller.get(BATCH_ID, USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.viewer,
      );
    });
  });

  // ===========================================================================
  // GET /enhancement-batches/:id — 404
  // ===========================================================================

  describe('get() — unknown id', () => {
    it('throws 404 when the batch does not exist', async () => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.get('missing-batch', USER)).rejects.toThrow(NotFoundException);
    });
  });

  // ===========================================================================
  // POST /enhancement-batches/:id/cancel
  // ===========================================================================

  describe('cancel()', () => {
    beforeEach(() => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(makeBatch());
      (mockPrisma.mediaEnhancementBatch.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.enrichmentJob.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.mediaEnhancement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    });

    it('asserts circle access at the collaborator level', async () => {
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { pending: 1 }),
      );
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);

      await controller.cancel(BATCH_ID, USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.collaborator,
      );
    });

    it('withdraws pending rows: deletes their PENDING job rows and marks them cancelled, leaving PROCESSING rows and jobs untouched', async () => {
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { pending: 2, processing: 1 }),
      );
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
        { id: 'enh-p1' },
        { id: 'enh-p2' },
      ]);
      (mockPrisma.mediaEnhancement.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await controller.cancel(BATCH_ID, USER);

      // The batch itself is stamped cancelled.
      expect(mockPrisma.mediaEnhancementBatch.update).toHaveBeenCalledWith({
        where: { id: BATCH_ID },
        data: { cancelledAt: expect.any(Date) },
      });

      // Only the still-PENDING rows were looked up for withdrawal.
      expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith({
        where: { batchId: BATCH_ID, status: MediaEnhancementStatus.pending },
        select: { id: true },
      });

      // Their job rows are deleted, scoped to status=pending — a running job
      // for the still-processing row can never match this filter.
      expect(mockPrisma.enrichmentJob.deleteMany).toHaveBeenCalledWith({
        where: {
          type: 'picture_enhancement',
          status: JobStatus.pending,
          OR: [
            { payload: { path: ['enhancementId'], equals: 'enh-p1' } },
            { payload: { path: ['enhancementId'], equals: 'enh-p2' } },
          ],
        },
      });

      // Only pending rows are flipped to cancelled — re-filtered on pending,
      // so a row that started processing between the read and the write is
      // never clobbered mid-render.
      expect(mockPrisma.mediaEnhancement.updateMany).toHaveBeenCalledWith({
        where: { batchId: BATCH_ID, status: MediaEnhancementStatus.pending },
        data: { status: MediaEnhancementStatus.cancelled },
      });

      expect(result).toEqual({ batchId: BATCH_ID, status: 'cancelled', cancelled: 2 });
    });

    it('does nothing to jobs/rows when there are no pending rows to withdraw (only processing remains)', async () => {
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { processing: 1 }),
      );
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);

      const result = await controller.cancel(BATCH_ID, USER);

      expect(mockPrisma.enrichmentJob.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.mediaEnhancement.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ batchId: BATCH_ID, status: 'cancelled', cancelled: 0 });
    });

    it('throws 400 ("Batch already finished") when the batch is already terminal, and never stamps cancelledAt', async () => {
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { ready: 3 }), // completed — no pending/processing
      );

      await expect(controller.cancel(BATCH_ID, USER)).rejects.toThrow(BadRequestException);
      await expect(controller.cancel(BATCH_ID, USER)).rejects.toThrow('Batch already finished');
      expect(mockPrisma.mediaEnhancementBatch.update).not.toHaveBeenCalled();
    });

    it('throws 400 when the batch was already cancelled', async () => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(
        makeBatch({ cancelledAt: new Date() }),
      );
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { cancelled: 3 }),
      );

      await expect(controller.cancel(BATCH_ID, USER)).rejects.toThrow('Batch already finished');
      expect(mockPrisma.mediaEnhancementBatch.update).not.toHaveBeenCalled();
    });

    it('throws 403 for a caller lacking the collaborator role', async () => {
      mockMembership.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('viewer cannot write'),
      );

      await expect(controller.cancel(BATCH_ID, USER)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.mediaEnhancementBatch.update).not.toHaveBeenCalled();
    });

    it('throws 404 for an unknown batch id', async () => {
      (mockPrisma.mediaEnhancementBatch.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(controller.cancel('missing-batch', USER)).rejects.toThrow(NotFoundException);
    });

    // -------------------------------------------------------------------------
    // Viewer CAN GET but cannot cancel — the two endpoints require different
    // per-circle roles (viewer for GET, collaborator for cancel).
    // -------------------------------------------------------------------------

    it('a viewer (below collaborator) can GET the batch but gets a 403 on cancel', async () => {
      mockMembership.assertCircleAccess.mockImplementation(
        async (_userId: string, _circleId: string, _perms: string[], role: CircleRole) => {
          if (role === CircleRole.collaborator) {
            throw new ForbiddenException('requires collaborator role');
          }
          return { role: CircleRole.viewer, isSuperAdmin: false };
        },
      );
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue(
        groupByRows(BATCH_ID, { pending: 1 }),
      );

      // GET succeeds (viewer-level check).
      await expect(controller.get(BATCH_ID, USER)).resolves.toMatchObject({ status: 'running' });

      // Cancel is rejected (collaborator-level check).
      await expect(controller.cancel(BATCH_ID, USER)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.mediaEnhancementBatch.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // GET /enhancement-batches — list
  // ===========================================================================

  describe('list()', () => {
    function makeQuery(overrides: Record<string, any> = {}) {
      return { circleId: CIRCLE_ID, page: 1, pageSize: 20, ...overrides };
    }

    beforeEach(() => {
      (mockPrisma.mediaEnhancementBatch.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaEnhancementBatch.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue([]);
    });

    it('asserts circle access at the viewer level', async () => {
      await controller.list(makeQuery() as any, USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.viewer,
      );
    });

    it('is circle-scoped: where:{circleId} on both findMany and count', async () => {
      await controller.list(makeQuery() as any, USER);

      expect(mockPrisma.mediaEnhancementBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { circleId: CIRCLE_ID } }),
      );
      expect(mockPrisma.mediaEnhancementBatch.count).toHaveBeenCalledWith({
        where: { circleId: CIRCLE_ID },
      });
    });

    it('orders newest first with an id tiebreaker: [{createdAt:desc},{id:desc}]', async () => {
      await controller.list(makeQuery() as any, USER);

      expect(mockPrisma.mediaEnhancementBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    it('derives skip/take from page/pageSize', async () => {
      await controller.list(makeQuery({ page: 3, pageSize: 10 }) as any, USER);

      expect(mockPrisma.mediaEnhancementBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('computes meta.totalPages by ceiling division', async () => {
      (mockPrisma.mediaEnhancementBatch.count as jest.Mock).mockResolvedValue(25);

      const result = await controller.list(makeQuery({ page: 1, pageSize: 10 }) as any, USER);

      expect(result.meta).toEqual({ page: 1, pageSize: 10, totalItems: 25, totalPages: 3 });
    });

    it('tallies every batch on the page with exactly ONE groupBy call, not one per batch', async () => {
      const batchA = makeBatch({ id: 'batch-a' });
      const batchB = makeBatch({ id: 'batch-b' });
      (mockPrisma.mediaEnhancementBatch.findMany as jest.Mock).mockResolvedValue([batchA, batchB]);
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue([
        ...groupByRows('batch-a', { ready: 2 }),
        ...groupByRows('batch-b', { pending: 1 }),
      ]);

      const result = await controller.list(makeQuery() as any, USER);

      expect(mockPrisma.mediaEnhancement.groupBy).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaEnhancement.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { batchId: { in: ['batch-a', 'batch-b'] } } }),
      );
      const byId = new Map(result.items.map((i: any) => [i.id, i]));
      expect(byId.get('batch-a').status).toBe('completed');
      expect(byId.get('batch-b').status).toBe('running');
    });

    it('a batch with no rows at all in the tally still serializes (EMPTY_TALLY fallback)', async () => {
      (mockPrisma.mediaEnhancementBatch.findMany as jest.Mock).mockResolvedValue([makeBatch()]);
      (mockPrisma.mediaEnhancement.groupBy as jest.Mock).mockResolvedValue([]); // nothing tallied

      const result = await controller.list(makeQuery() as any, USER);

      expect(result.items[0]).toMatchObject({ status: 'completed', matchedCount: 0 });
    });

    it('never calls groupBy for an empty page', async () => {
      (mockPrisma.mediaEnhancementBatch.findMany as jest.Mock).mockResolvedValue([]);

      await controller.list(makeQuery() as any, USER);

      expect(mockPrisma.mediaEnhancement.groupBy).not.toHaveBeenCalled();
    });
  });
});
