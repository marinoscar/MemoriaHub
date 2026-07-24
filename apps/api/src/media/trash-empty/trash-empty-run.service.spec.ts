/**
 * Unit tests for TrashEmptyRunService (issue #165 — Empty Trash at scale).
 *
 * Covers:
 *   - createRun: circle_admin auth enforced; per-circle concurrency guard
 *     (409 ConflictException) when an active {evaluating, running} run
 *     already exists; happy path creates an 'evaluating' run and enqueues
 *     trash_empty_evaluate at priority 20 with skipDedup + payload {runId}.
 *   - cancelRun: non-terminal -> cancelled; terminal run rejection; not-found.
 *   - getRunDetail: not-found; auth (viewer); shape (serialized run +
 *     itemStatusCounts derived from groupBy).
 *   - listRunItems: auth; pagination meta; signed-thumbnail merge, including
 *     the already-purged-item (null media/thumbnail) case.
 *   - enqueueExecuteBatches: chunking by BATCH_SIZE (200); no-op when there
 *     are no matched items.
 *
 * No database required — PrismaService, CircleMembershipService,
 * EnrichmentJobService, and MediaThumbnailService are all mocked.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CircleRole, TrashEmptyRunItemStatus, TrashEmptyRunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { TrashEmptyRunService } from './trash-empty-run.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const RUN_ID = randomUUID();
const USER_ID = randomUUID();

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
    startedById: USER_ID,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('TrashEmptyRunService', () => {
  let service: TrashEmptyRunService;
  let prisma: MockPrismaService;
  let circleMembership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let thumbnails: jest.Mocked<Pick<MediaThumbnailService, 'attachThumbnailUrls'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    circleMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'circle_admin', isSuperAdmin: false }),
    };
    enrichmentJobs = { enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }) };
    thumbnails = { attachThumbnailUrls: jest.fn().mockResolvedValue([]) };

    service = new TrashEmptyRunService(
      prisma as unknown as PrismaService,
      circleMembership as unknown as CircleMembershipService,
      enrichmentJobs as unknown as EnrichmentJobService,
      thumbnails as unknown as MediaThumbnailService,
    );

    prisma.auditEvent.create.mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createRun
  // ---------------------------------------------------------------------------

  describe('createRun', () => {
    it('asserts circle_admin access before doing anything else', async () => {
      prisma.trashEmptyRun.count.mockResolvedValue(0);
      prisma.trashEmptyRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(CIRCLE_ID, USER_ID, ['media:delete']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:delete'],
        CircleRole.circle_admin,
      );
    });

    it('propagates the ForbiddenException from a failed circle-admin check without creating a run', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      circleMembership.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('not a circle_admin'),
      );

      await expect(
        service.createRun(CIRCLE_ID, USER_ID, ['media:delete']),
      ).rejects.toThrow('not a circle_admin');
      expect(prisma.trashEmptyRun.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when an active run (evaluating/running) already exists for the circle', async () => {
      prisma.trashEmptyRun.count.mockResolvedValue(1);

      await expect(
        service.createRun(CIRCLE_ID, USER_ID, ['media:delete']),
      ).rejects.toThrow(ConflictException);
      expect(prisma.trashEmptyRun.create).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('queries the concurrency guard scoped to {evaluating, running} for this circle', async () => {
      prisma.trashEmptyRun.count.mockResolvedValue(0);
      prisma.trashEmptyRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(CIRCLE_ID, USER_ID, ['media:delete']);

      expect(prisma.trashEmptyRun.count).toHaveBeenCalledWith({
        where: {
          circleId: CIRCLE_ID,
          status: { in: [TrashEmptyRunStatus.evaluating, TrashEmptyRunStatus.running] },
        },
      });
    });

    it('creates a run in "evaluating" status and returns the serialized run', async () => {
      prisma.trashEmptyRun.count.mockResolvedValue(0);
      prisma.trashEmptyRun.create.mockResolvedValue(makeRun() as any);

      const result = await service.createRun(CIRCLE_ID, USER_ID, ['media:delete']);

      expect(prisma.trashEmptyRun.create).toHaveBeenCalledWith({
        data: {
          circleId: CIRCLE_ID,
          status: TrashEmptyRunStatus.evaluating,
          startedById: USER_ID,
        },
      });
      expect(result.status).toBe(TrashEmptyRunStatus.evaluating);
      expect(result.id).toBe(RUN_ID);
    });

    it('enqueues trash_empty_evaluate at priority 20 with skipDedup and payload {runId}', async () => {
      prisma.trashEmptyRun.count.mockResolvedValue(0);
      prisma.trashEmptyRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(CIRCLE_ID, USER_ID, ['media:delete']);

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith({
        type: 'trash_empty_evaluate',
        mediaItemId: null,
        circleId: CIRCLE_ID,
        reason: 'rerun',
        priority: 20,
        skipDedup: true,
        payload: { runId: RUN_ID },
      });
    });

    it('writes a trash_empty_run:started audit event', async () => {
      prisma.trashEmptyRun.count.mockResolvedValue(0);
      prisma.trashEmptyRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(CIRCLE_ID, USER_ID, ['media:delete']);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'trash_empty_run:started',
            targetType: 'trash_empty_run',
            targetId: RUN_ID,
          }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // cancelRun
  // ---------------------------------------------------------------------------

  describe('cancelRun', () => {
    it('throws NotFoundException when the run does not exist', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(null);

      await expect(service.cancelRun(RUN_ID, USER_ID, ['media:delete'])).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([TrashEmptyRunStatus.evaluating, TrashEmptyRunStatus.running])(
      'cancels a non-terminal run in status %s',
      async (status) => {
        prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun({ status }) as any);
        prisma.trashEmptyRun.update.mockResolvedValue(
          makeRun({ status: TrashEmptyRunStatus.cancelled }) as any,
        );

        const result = await service.cancelRun(RUN_ID, USER_ID, ['media:delete']);

        expect(result).toEqual({ runId: RUN_ID, status: TrashEmptyRunStatus.cancelled });
        expect(prisma.trashEmptyRun.update).toHaveBeenCalledWith({
          where: { id: RUN_ID },
          data: { status: TrashEmptyRunStatus.cancelled, finishedAt: expect.any(Date) },
        });
      },
    );

    it.each([
      TrashEmptyRunStatus.completed,
      TrashEmptyRunStatus.completed_with_errors,
      TrashEmptyRunStatus.failed,
      TrashEmptyRunStatus.cancelled,
    ])('rejects cancelling an already-terminal run in status %s', async (status) => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun({ status }) as any);

      await expect(service.cancelRun(RUN_ID, USER_ID, ['media:delete'])).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.trashEmptyRun.update).not.toHaveBeenCalled();
    });

    it('asserts circle_admin access scoped to the run’s circle', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.trashEmptyRun.update.mockResolvedValue(
        makeRun({ status: TrashEmptyRunStatus.cancelled }) as any,
      );

      await service.cancelRun(RUN_ID, USER_ID, ['media:delete']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:delete'],
        CircleRole.circle_admin,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getRunDetail
  // ---------------------------------------------------------------------------

  describe('getRunDetail', () => {
    it('throws NotFoundException when the run does not exist', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(null);

      await expect(service.getRunDetail(RUN_ID, USER_ID, ['media:read'])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('asserts viewer access scoped to the run’s circle', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      (prisma.trashEmptyRunItem.groupBy as jest.Mock).mockResolvedValue([]);

      await service.getRunDetail(RUN_ID, USER_ID, ['media:read']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:read'],
        CircleRole.viewer,
      );
    });

    it('returns the serialized run plus itemStatusCounts derived from groupBy', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(
        makeRun({ matchedCount: 10, processedCount: 4, succeededCount: 3, failedCount: 1 }) as any,
      );
      (prisma.trashEmptyRunItem.groupBy as jest.Mock).mockResolvedValue([
        { status: TrashEmptyRunItemStatus.matched, _count: { _all: 6 } },
        { status: TrashEmptyRunItemStatus.deleted, _count: { _all: 3 } },
        { status: TrashEmptyRunItemStatus.failed, _count: { _all: 1 } },
      ]);

      const result = await service.getRunDetail(RUN_ID, USER_ID, ['media:read']);

      expect(result.matchedCount).toBe(10);
      expect(result.itemStatusCounts).toEqual({ matched: 6, deleted: 3, failed: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // listRunItems
  // ---------------------------------------------------------------------------

  describe('listRunItems', () => {
    const query = { page: 1, pageSize: 50 };

    it('throws NotFoundException when the run does not exist', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(null);

      await expect(
        service.listRunItems(RUN_ID, query, USER_ID, ['media:read']),
      ).rejects.toThrow(NotFoundException);
    });

    it('asserts viewer access scoped to the run’s circle', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);
      prisma.mediaItem.findMany.mockResolvedValue([] as any);

      await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:read'],
        CircleRole.viewer,
      );
    });

    it('returns paginated items with signed thumbnails merged in', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      const mediaItemId = randomUUID();
      const rowItem = {
        id: 'item-row-1',
        mediaItemId,
        status: TrashEmptyRunItemStatus.matched,
        error: null,
        updatedAt: new Date(),
      };
      prisma.$transaction.mockResolvedValue([[rowItem], 1] as any);
      prisma.mediaItem.findMany.mockResolvedValue([
        {
          id: mediaItemId,
          type: 'photo',
          capturedAt: new Date('2024-01-01'),
          originalFilename: 'a.jpg',
          width: 100,
          height: 100,
          metadata: null,
        },
      ] as any);
      thumbnails.attachThumbnailUrls.mockResolvedValue([
        {
          id: mediaItemId,
          type: 'photo',
          capturedAt: new Date('2024-01-01'),
          originalFilename: 'a.jpg',
          width: 100,
          height: 100,
          thumbnailUrl: 'https://signed.example.com/a.jpg',
        },
      ] as any);

      const result = await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(result.meta).toEqual({ page: 1, pageSize: 50, totalItems: 1, totalPages: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'item-row-1',
        mediaItemId,
        status: TrashEmptyRunItemStatus.matched,
        thumbnailUrl: 'https://signed.example.com/a.jpg',
        media: { type: 'photo', filename: 'a.jpg' },
      });
    });

    it('resolves media: null and thumbnailUrl: null for an item whose MediaItem row is already gone (successful purge cascade)', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      const rowItem = {
        id: 'item-row-purged',
        mediaItemId: randomUUID(),
        status: TrashEmptyRunItemStatus.deleted,
        error: null,
        updatedAt: new Date(),
      };
      prisma.$transaction.mockResolvedValue([[rowItem], 1] as any);
      // The MediaItem row is gone — findMany (and therefore signed thumbnails)
      // returns nothing for this id.
      prisma.mediaItem.findMany.mockResolvedValue([] as any);
      thumbnails.attachThumbnailUrls.mockResolvedValue([] as any);

      const result = await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(result.items[0].media).toBeNull();
      expect(result.items[0].thumbnailUrl).toBeNull();
    });

    it('filters by status when provided', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);
      prisma.mediaItem.findMany.mockResolvedValue([] as any);

      await service.listRunItems(
        RUN_ID,
        { ...query, status: TrashEmptyRunItemStatus.failed },
        USER_ID,
        ['media:read'],
      );

      // trashEmptyRunItem.findMany/count are invoked (synchronously, to build
      // the args passed into $transaction) with the status filter applied.
      expect(prisma.trashEmptyRunItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { runId: RUN_ID, status: TrashEmptyRunItemStatus.failed },
        }),
      );
      expect(prisma.trashEmptyRunItem.count).toHaveBeenCalledWith({
        where: { runId: RUN_ID, status: TrashEmptyRunItemStatus.failed },
      });
    });

    it('omits the status key from the where clause when no status filter is given', async () => {
      prisma.trashEmptyRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);
      prisma.mediaItem.findMany.mockResolvedValue([] as any);

      await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(prisma.trashEmptyRunItem.count).toHaveBeenCalledWith({
        where: { runId: RUN_ID },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueExecuteBatches
  // ---------------------------------------------------------------------------

  describe('enqueueExecuteBatches', () => {
    it('chunks matched items into ceil(N / 200) enrichment jobs', async () => {
      const ids = Array.from({ length: 450 }, () => randomUUID());
      prisma.trashEmptyRunItem.findMany.mockResolvedValue(
        ids.map((mediaItemId) => ({ mediaItemId })) as any,
      );

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      // 450 / 200 -> 3 batches (200, 200, 50).
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(3);
      const payloads = (enrichmentJobs.enqueue as jest.Mock).mock.calls.map(
        (c) => (c[0].payload as { itemIds: string[] }).itemIds,
      );
      expect(payloads[0]).toHaveLength(200);
      expect(payloads[1]).toHaveLength(200);
      expect(payloads[2]).toHaveLength(50);
      expect(payloads.flat().sort()).toEqual([...ids].sort());
    });

    it('enqueues each batch with priority 100, skipDedup, and reason "rerun"', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      prisma.trashEmptyRunItem.findMany.mockResolvedValue(
        ids.map((mediaItemId) => ({ mediaItemId })) as any,
      );

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'trash_empty_execute_batch',
          mediaItemId: null,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 100,
          skipDedup: true,
          payload: { runId: RUN_ID, itemIds: ids },
        }),
      );
    });

    it('only queries items with status matched', async () => {
      prisma.trashEmptyRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      expect(prisma.trashEmptyRunItem.findMany).toHaveBeenCalledWith({
        where: { runId: RUN_ID, status: TrashEmptyRunItemStatus.matched },
        select: { mediaItemId: true },
      });
    });

    it('enqueues nothing when there are no matched items', async () => {
      prisma.trashEmptyRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });
});
