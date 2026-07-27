/**
 * Unit tests for ReviewRunService — the shared bulk review-queue run
 * lifecycle service (issue #190) behind burst resolve/dismiss-by-threshold,
 * duplicate resolve/dismiss-by-threshold, and location-suggestion bulk
 * accept/reject.
 *
 * Covers:
 *   - createRun: 409 ConflictException fires for a second active run of the
 *     SAME (circleId, subjectType), but NOT when the existing active run has
 *     a different subjectType in the same circle (concurrency guard is
 *     scoped by subjectType, not just circleId) — asserted directly against
 *     the Prisma `where` clause passed to reviewRun.count.
 *   - RBAC per action: media:delete required ONLY for resolve_trash;
 *     resolve_archive/dismiss/accept/reject succeed without it.
 *   - Unknown subjectType -> BadRequestException; an action not in the
 *     strategy's supportedActions -> BadRequestException.
 *   - cancelRun: terminal-status run -> BadRequestException; non-terminal
 *     run -> cancelled + finishedAt; unknown run -> NotFoundException.
 *   - enqueueExecuteBatches: chunks into ceil(N/BATCH_SIZE) jobs of type
 *     review_run_execute_batch with skipDedup: true, payload subjectIds
 *     matching the slice.
 *   - serializeRun: includes subjectType, action, and threshold (not just
 *     the progress counters) — the frontend's RunProgressPanel labels off
 *     these fields.
 *   - listRunItems: response row shape is EXACTLY { id, subjectId,
 *     subjectType, status, error, updatedAt, media, thumbnailUrl } — the
 *     three exclusive-arc columns (burstGroupId/duplicateGroupId/
 *     locationSuggestionId) must NOT leak into the API response.
 *   - getRunDetail: not found -> NotFoundException; itemStatusCounts built
 *     correctly from a groupBy result.
 *
 * No database required — PrismaService, CircleMembershipService,
 * EnrichmentJobService, MediaThumbnailService, and ReviewRunSubjectRegistry
 * are all mocked; the service is constructed directly (no Nest
 * TestingModule), mirroring the preserved
 * location-suggestion-run.service.spec.ts.old reference's style.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CircleRole,
  ReviewRunAction,
  ReviewRunItemStatus,
  ReviewRunStatus,
  ReviewRunSubject,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  ACTIVE_RUN_STATUSES,
  BATCH_SIZE,
  ReviewRunService,
  subjectIdOf,
} from './review-run.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ReviewRunSubjectRegistry } from './review-run-subject.registry';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const RUN_ID = randomUUID();
const USER_ID = randomUUID();

const PERMS_MEDIA_WRITE = ['media:write'];
const PERMS_MEDIA_WRITE_DELETE = ['media:write', PERMISSIONS.MEDIA_DELETE];

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
    startedById: USER_ID,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** A stub strategy for a given subject; supportedActions is the RBAC-relevant bit. */
function makeStrategy(
  subject: ReviewRunSubject,
  subjectColumn: 'burstGroupId' | 'duplicateGroupId' | 'locationSuggestionId',
  supportedActions: ReviewRunAction[],
) {
  return {
    subject,
    subjectColumn,
    supportedActions,
    evaluatePage: jest.fn(),
    executeItem: jest.fn(),
    hydrateItems: jest.fn().mockResolvedValue(new Map()),
  };
}

describe('ReviewRunService', () => {
  let service: ReviewRunService;
  let prisma: MockPrismaService;
  let circleMembership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let thumbnails: jest.Mocked<Pick<MediaThumbnailService, 'signThumbsBatched' | 'extractThumbKey'>>;
  let burstStrategy: ReturnType<typeof makeStrategy>;
  let duplicateStrategy: ReturnType<typeof makeStrategy>;
  let locationStrategy: ReturnType<typeof makeStrategy>;
  let registry: { get: jest.Mock };

  beforeEach(() => {
    prisma = createMockPrismaService();
    circleMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    enrichmentJobs = { enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }) };
    thumbnails = {
      signThumbsBatched: jest.fn().mockResolvedValue(new Map()),
      extractThumbKey: jest.fn().mockReturnValue(null),
    };

    burstStrategy = makeStrategy(ReviewRunSubject.burst_group, 'burstGroupId', [
      ReviewRunAction.resolve_archive,
      ReviewRunAction.resolve_trash,
      ReviewRunAction.dismiss,
    ]);
    duplicateStrategy = makeStrategy(ReviewRunSubject.duplicate_group, 'duplicateGroupId', [
      ReviewRunAction.resolve_archive,
      ReviewRunAction.resolve_trash,
      ReviewRunAction.dismiss,
    ]);
    locationStrategy = makeStrategy(ReviewRunSubject.location_suggestion, 'locationSuggestionId', [
      ReviewRunAction.accept,
      ReviewRunAction.reject,
    ]);

    registry = {
      get: jest.fn((subject: ReviewRunSubject) => {
        if (subject === ReviewRunSubject.burst_group) return burstStrategy;
        if (subject === ReviewRunSubject.duplicate_group) return duplicateStrategy;
        if (subject === ReviewRunSubject.location_suggestion) return locationStrategy;
        return undefined;
      }),
    };

    service = new ReviewRunService(
      prisma as unknown as PrismaService,
      circleMembership as unknown as CircleMembershipService,
      enrichmentJobs as unknown as EnrichmentJobService,
      thumbnails as unknown as MediaThumbnailService,
      registry as unknown as ReviewRunSubjectRegistry,
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
    it('throws BadRequestException for an unknown subjectType', async () => {
      registry.get.mockReturnValueOnce(undefined);

      await expect(
        service.createRun({
          circleId: CIRCLE_ID,
          subjectType: 'not_a_real_subject' as ReviewRunSubject,
          action: ReviewRunAction.resolve_archive,
          threshold: 60,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.reviewRun.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the action is not in the strategy supportedActions (e.g. "accept" against burst_group)', async () => {
      await expect(
        service.createRun({
          circleId: CIRCLE_ID,
          subjectType: ReviewRunSubject.burst_group,
          action: ReviewRunAction.accept,
          threshold: 60,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(circleMembership.assertCircleAccess).not.toHaveBeenCalled();
      expect(prisma.reviewRun.create).not.toHaveBeenCalled();
    });

    describe('RBAC — media:delete required only for resolve_trash', () => {
      it.each([
        ['resolve_archive', ReviewRunAction.resolve_archive, ReviewRunSubject.burst_group],
        ['dismiss', ReviewRunAction.dismiss, ReviewRunSubject.burst_group],
        ['accept', ReviewRunAction.accept, ReviewRunSubject.location_suggestion],
        ['reject', ReviewRunAction.reject, ReviewRunSubject.location_suggestion],
      ])('%s succeeds with only media:write perms (no media:delete)', async (_label, action, subjectType) => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(makeRun({ subjectType, action }) as any);

        await expect(
          service.createRun({
            circleId: CIRCLE_ID,
            subjectType,
            action,
            threshold: 60,
            userId: USER_ID,
            perms: PERMS_MEDIA_WRITE,
          }),
        ).resolves.toBeDefined();
      });

      it('resolve_trash throws BadRequestException without media:delete', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);

        await expect(
          service.createRun({
            circleId: CIRCLE_ID,
            subjectType: ReviewRunSubject.burst_group,
            action: ReviewRunAction.resolve_trash,
            threshold: 60,
            userId: USER_ID,
            perms: PERMS_MEDIA_WRITE, // no media:delete
          }),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.reviewRun.create).not.toHaveBeenCalled();
      });

      it('resolve_trash succeeds with media:delete', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(
          makeRun({ action: ReviewRunAction.resolve_trash }) as any,
        );

        await expect(
          service.createRun({
            circleId: CIRCLE_ID,
            subjectType: ReviewRunSubject.burst_group,
            action: ReviewRunAction.resolve_trash,
            threshold: 60,
            userId: USER_ID,
            perms: PERMS_MEDIA_WRITE_DELETE,
          }),
        ).resolves.toBeDefined();
      });
    });

    describe('concurrency guard scoped to (circleId, subjectType)', () => {
      it('queries the guard scoped by circleId AND subjectType, with status in ACTIVE_RUN_STATUSES', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(makeRun() as any);

        await service.createRun({
          circleId: CIRCLE_ID,
          subjectType: ReviewRunSubject.burst_group,
          action: ReviewRunAction.resolve_archive,
          threshold: 60,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        });

        expect(prisma.reviewRun.count).toHaveBeenCalledWith({
          where: {
            circleId: CIRCLE_ID,
            subjectType: ReviewRunSubject.burst_group,
            status: { in: ACTIVE_RUN_STATUSES },
          },
        });
      });

      it('throws ConflictException when an active run of the SAME subjectType already exists', async () => {
        prisma.reviewRun.count.mockResolvedValue(1);

        await expect(
          service.createRun({
            circleId: CIRCLE_ID,
            subjectType: ReviewRunSubject.burst_group,
            action: ReviewRunAction.resolve_archive,
            threshold: 60,
            userId: USER_ID,
            perms: PERMS_MEDIA_WRITE,
          }),
        ).rejects.toThrow(ConflictException);
        expect(prisma.reviewRun.create).not.toHaveBeenCalled();
        expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
      });

      it('does NOT 409 when the active run in the circle has a DIFFERENT subjectType (a burst run and a location-accept run may coexist)', async () => {
        // The count query itself is scoped by subjectType, so a
        // burst_group-scoped query returns 0 even though a
        // location_suggestion run is active in the same circle.
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(makeRun() as any);

        await expect(
          service.createRun({
            circleId: CIRCLE_ID,
            subjectType: ReviewRunSubject.burst_group,
            action: ReviewRunAction.resolve_archive,
            threshold: 60,
            userId: USER_ID,
            perms: PERMS_MEDIA_WRITE,
          }),
        ).resolves.toBeDefined();

        expect(prisma.reviewRun.count).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ subjectType: ReviewRunSubject.burst_group }),
          }),
        );
      });
    });

    describe('happy path', () => {
      it('asserts collaborator access before creating anything', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(makeRun() as any);

        await service.createRun({
          circleId: CIRCLE_ID,
          subjectType: ReviewRunSubject.burst_group,
          action: ReviewRunAction.resolve_archive,
          threshold: 60,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        });

        expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
          USER_ID,
          CIRCLE_ID,
          PERMS_MEDIA_WRITE,
          CircleRole.collaborator,
        );
      });

      it('creates a run in "evaluating" status persisting action + threshold', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(
          makeRun({ action: ReviewRunAction.dismiss, threshold: 40 }) as any,
        );

        await service.createRun({
          circleId: CIRCLE_ID,
          subjectType: ReviewRunSubject.burst_group,
          action: ReviewRunAction.dismiss,
          threshold: 40,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        });

        expect(prisma.reviewRun.create).toHaveBeenCalledWith({
          data: {
            circleId: CIRCLE_ID,
            subjectType: ReviewRunSubject.burst_group,
            action: ReviewRunAction.dismiss,
            threshold: 40,
            status: ReviewRunStatus.evaluating,
            startedById: USER_ID,
          },
        });
      });

      it('enqueues review_run_evaluate at priority 20 with skipDedup and payload {runId}', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(makeRun() as any);

        await service.createRun({
          circleId: CIRCLE_ID,
          subjectType: ReviewRunSubject.burst_group,
          action: ReviewRunAction.resolve_archive,
          threshold: 60,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        });

        expect(enrichmentJobs.enqueue).toHaveBeenCalledWith({
          type: 'review_run_evaluate',
          mediaItemId: null,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 20,
          skipDedup: true,
          payload: { runId: RUN_ID },
        });
      });

      it('writes a review_run:started audit event', async () => {
        prisma.reviewRun.count.mockResolvedValue(0);
        prisma.reviewRun.create.mockResolvedValue(makeRun() as any);

        await service.createRun({
          circleId: CIRCLE_ID,
          subjectType: ReviewRunSubject.burst_group,
          action: ReviewRunAction.resolve_archive,
          threshold: 60,
          userId: USER_ID,
          perms: PERMS_MEDIA_WRITE,
        });

        expect(prisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              actorUserId: USER_ID,
              action: 'review_run:started',
              targetType: 'review_run',
              targetId: RUN_ID,
              meta: {
                circleId: CIRCLE_ID,
                subjectType: ReviewRunSubject.burst_group,
                action: ReviewRunAction.resolve_archive,
                threshold: 60,
              },
            }),
          }),
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // cancelRun
  // ---------------------------------------------------------------------------

  describe('cancelRun', () => {
    it('throws NotFoundException when the run does not exist', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(null);

      await expect(service.cancelRun(RUN_ID, USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([ReviewRunStatus.evaluating, ReviewRunStatus.running])(
      'cancels a non-terminal run in status %s',
      async (status) => {
        prisma.reviewRun.findUnique.mockResolvedValue(makeRun({ status }) as any);
        prisma.reviewRun.update.mockResolvedValue(makeRun({ status: ReviewRunStatus.cancelled }) as any);

        const result = await service.cancelRun(RUN_ID, USER_ID, PERMS_MEDIA_WRITE);

        expect(result).toEqual({ runId: RUN_ID, status: ReviewRunStatus.cancelled });
        expect(prisma.reviewRun.update).toHaveBeenCalledWith({
          where: { id: RUN_ID },
          data: { status: ReviewRunStatus.cancelled, finishedAt: expect.any(Date) },
        });
      },
    );

    it.each([
      ReviewRunStatus.completed,
      ReviewRunStatus.completed_with_errors,
      ReviewRunStatus.failed,
      ReviewRunStatus.cancelled,
    ])('rejects cancelling an already-terminal run in status %s', async (status) => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun({ status }) as any);

      await expect(service.cancelRun(RUN_ID, USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.reviewRun.update).not.toHaveBeenCalled();
    });

    it('asserts collaborator access scoped to the run’s circle', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.reviewRun.update.mockResolvedValue(makeRun({ status: ReviewRunStatus.cancelled }) as any);

      await service.cancelRun(RUN_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE,
        CircleRole.collaborator,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getRunDetail
  // ---------------------------------------------------------------------------

  describe('getRunDetail', () => {
    it('throws NotFoundException when the run does not exist', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(null);

      await expect(service.getRunDetail(RUN_ID, USER_ID, ['media:read'])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('asserts viewer access scoped to the run’s circle', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      (prisma.reviewRunItem.groupBy as jest.Mock).mockResolvedValue([]);

      await service.getRunDetail(RUN_ID, USER_ID, ['media:read']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:read'],
        CircleRole.viewer,
      );
    });

    it('returns the serialized run plus itemStatusCounts derived from groupBy', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(
        makeRun({ matchedCount: 10, processedCount: 4, succeededCount: 3, failedCount: 1 }) as any,
      );
      (prisma.reviewRunItem.groupBy as jest.Mock).mockResolvedValue([
        { status: ReviewRunItemStatus.matched, _count: { _all: 6 } },
        { status: ReviewRunItemStatus.applied, _count: { _all: 3 } },
        { status: ReviewRunItemStatus.failed, _count: { _all: 1 } },
      ]);

      const result = await service.getRunDetail(RUN_ID, USER_ID, ['media:read']);

      expect(result.matchedCount).toBe(10);
      expect(result.itemStatusCounts).toEqual({ matched: 6, applied: 3, failed: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // serializeRun — subjectType/action/threshold must be present, not just counters
  // ---------------------------------------------------------------------------

  describe('serializeRun', () => {
    it('includes subjectType, action, and threshold alongside the progress counters', () => {
      const run = makeRun({
        subjectType: ReviewRunSubject.location_suggestion,
        action: ReviewRunAction.accept,
        threshold: 85,
      });

      const result = service.serializeRun(run as any);

      expect(result.subjectType).toBe(ReviewRunSubject.location_suggestion);
      expect(result.action).toBe(ReviewRunAction.accept);
      expect(result.threshold).toBe(85);
      expect(result).toMatchObject({
        matchedCount: run.matchedCount,
        processedCount: run.processedCount,
        succeededCount: run.succeededCount,
        failedCount: run.failedCount,
        skippedCount: run.skippedCount,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // listRunItems
  // ---------------------------------------------------------------------------

  describe('listRunItems', () => {
    const query = { page: 1, pageSize: 50 };

    it('throws NotFoundException when the run does not exist', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(null);

      await expect(
        service.listRunItems(RUN_ID, query, USER_ID, ['media:read']),
      ).rejects.toThrow(NotFoundException);
    });

    it('asserts viewer access scoped to the run’s circle', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);

      await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:read'],
        CircleRole.viewer,
      );
    });

    it('returns a row shape EXACTLY { id, subjectId, subjectType, status, error, updatedAt, media, thumbnailUrl } — no exclusive-arc columns leak through', async () => {
      const mediaItemId = randomUUID();
      const groupId = randomUUID();
      const updatedAt = new Date();
      const row = {
        id: 'item-row-1',
        subjectType: ReviewRunSubject.burst_group,
        burstGroupId: groupId,
        duplicateGroupId: null,
        locationSuggestionId: null,
        status: ReviewRunItemStatus.applied,
        error: null,
        updatedAt,
      };
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[row], 1] as any);
      burstStrategy.hydrateItems.mockResolvedValue(
        new Map([
          [
            groupId,
            {
              mediaItemId,
              type: 'photo',
              capturedAt: new Date('2024-01-01'),
              filename: 'a.jpg',
              width: 100,
              height: 100,
              metadata: { thumbnailKey: 'thumbs/a.jpg' },
            },
          ],
        ]),
      );
      thumbnails.extractThumbKey.mockReturnValue('thumbs/a.jpg');
      thumbnails.signThumbsBatched.mockResolvedValue(
        new Map([['thumbs/a.jpg', 'https://signed.example.com/a.jpg']]),
      );

      const result = await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(Object.keys(item).sort()).toEqual(
        ['error', 'id', 'media', 'status', 'subjectId', 'subjectType', 'thumbnailUrl', 'updatedAt'].sort(),
      );
      expect(item).not.toHaveProperty('burstGroupId');
      expect(item).not.toHaveProperty('duplicateGroupId');
      expect(item).not.toHaveProperty('locationSuggestionId');
      expect(item).toEqual({
        id: 'item-row-1',
        subjectId: groupId,
        subjectType: ReviewRunSubject.burst_group,
        status: ReviewRunItemStatus.applied,
        error: null,
        updatedAt,
        media: { type: 'photo', capturedAt: new Date('2024-01-01'), filename: 'a.jpg', width: 100, height: 100 },
        thumbnailUrl: 'https://signed.example.com/a.jpg',
      });
    });

    it('resolves subjectId/media/thumbnailUrl to null when the strategy has no preview for the subject', async () => {
      const row = {
        id: 'item-row-orphan',
        subjectType: ReviewRunSubject.burst_group,
        burstGroupId: randomUUID(),
        duplicateGroupId: null,
        locationSuggestionId: null,
        status: ReviewRunItemStatus.applied,
        error: null,
        updatedAt: new Date(),
      };
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[row], 1] as any);
      burstStrategy.hydrateItems.mockResolvedValue(new Map());

      const result = await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(result.items[0].media).toBeNull();
      expect(result.items[0].thumbnailUrl).toBeNull();
      // subjectId is still populated from the row's own column, independent of hydration.
      expect(result.items[0].subjectId).toBe(row.burstGroupId);
    });

    it('returns pagination meta { page, pageSize, totalItems, totalPages }', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 37] as any);

      const result = await service.listRunItems(RUN_ID, { page: 2, pageSize: 10 }, USER_ID, [
        'media:read',
      ]);

      expect(result.meta).toEqual({ page: 2, pageSize: 10, totalItems: 37, totalPages: 4 });
    });

    it('filters by status when provided (findMany/count args are captured even though $transaction is mocked, since the array form evaluates its arguments eagerly)', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);

      await service.listRunItems(
        RUN_ID,
        { ...query, status: ReviewRunItemStatus.failed },
        USER_ID,
        ['media:read'],
      );

      expect(prisma.reviewRunItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { runId: RUN_ID, status: ReviewRunItemStatus.failed } }),
      );
      expect(prisma.reviewRunItem.count).toHaveBeenCalledWith({
        where: { runId: RUN_ID, status: ReviewRunItemStatus.failed },
      });
    });

    it('omits the status key from the where clause when no status filter is given', async () => {
      prisma.reviewRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);

      await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(prisma.reviewRunItem.count).toHaveBeenCalledWith({ where: { runId: RUN_ID } });
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueExecuteBatches
  // ---------------------------------------------------------------------------

  describe('enqueueExecuteBatches', () => {
    it('chunks matched items into ceil(N / BATCH_SIZE) enrichment jobs', async () => {
      const ids = Array.from({ length: 450 }, () => randomUUID());
      prisma.reviewRunItem.findMany.mockResolvedValue(
        ids.map((burstGroupId) => ({
          burstGroupId,
          duplicateGroupId: null,
          locationSuggestionId: null,
        })) as any,
      );

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID, ReviewRunSubject.burst_group);

      // 450 / 200 -> 3 batches (200, 200, 50).
      expect(BATCH_SIZE).toBe(200);
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(3);
      const payloads = (enrichmentJobs.enqueue as jest.Mock).mock.calls.map(
        (c) => (c[0].payload as { subjectIds: string[] }).subjectIds,
      );
      expect(payloads[0]).toHaveLength(200);
      expect(payloads[1]).toHaveLength(200);
      expect(payloads[2]).toHaveLength(50);
      expect(payloads.flat().sort()).toEqual([...ids].sort());
    });

    it('enqueues each batch with type review_run_execute_batch, priority 100, skipDedup, reason rerun, and payload {runId, subjectIds}', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      prisma.reviewRunItem.findMany.mockResolvedValue(
        ids.map((burstGroupId) => ({
          burstGroupId,
          duplicateGroupId: null,
          locationSuggestionId: null,
        })) as any,
      );

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID, ReviewRunSubject.burst_group);

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'review_run_execute_batch',
          mediaItemId: null,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 100,
          skipDedup: true,
          payload: { runId: RUN_ID, subjectIds: ids },
        }),
      );
    });

    it('only queries items with status matched', async () => {
      prisma.reviewRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID, ReviewRunSubject.burst_group);

      expect(prisma.reviewRunItem.findMany).toHaveBeenCalledWith({
        where: { runId: RUN_ID, status: ReviewRunItemStatus.matched },
        select: { burstGroupId: true, duplicateGroupId: true, locationSuggestionId: true },
      });
    });

    it('enqueues nothing when there are no matched items', async () => {
      prisma.reviewRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID, ReviewRunSubject.burst_group);

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // subjectIdOf helper
  // ---------------------------------------------------------------------------

  describe('subjectIdOf', () => {
    it('reads the populated column for the given key', () => {
      const row = { burstGroupId: 'g-1', duplicateGroupId: null, locationSuggestionId: null };
      expect(subjectIdOf(row, 'burstGroupId')).toBe('g-1');
      expect(subjectIdOf(row, 'duplicateGroupId')).toBeNull();
    });
  });
});
