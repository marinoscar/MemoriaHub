/**
 * Unit tests for LocationSuggestionRunService — the async, run-based bulk
 * accept/reject engine for the Location Inference review queue (mirrors
 * TrashEmptyRunService, issue #165's "Empty Trash at Scale" precedent).
 *
 * Covers:
 *   - createRun: collaborator auth enforced (matching the per-item
 *     accept/reject authority — a step below trash-empty's circle_admin);
 *     per-circle concurrency guard (409 ConflictException) when an active
 *     {evaluating, running} run already exists; happy path creates an
 *     'evaluating' run (persisting action + threshold) and enqueues
 *     location_suggestion_run_evaluate at priority 20 with skipDedup +
 *     payload {runId}; audit event written.
 *   - cancelRun: non-terminal -> cancelled; terminal run rejection;
 *     not-found; collaborator auth scoped to the run's circle.
 *   - getRunDetail: not-found; auth (viewer); shape (serialized run +
 *     itemStatusCounts derived from groupBy).
 *   - listRunItems: auth; pagination meta; status filter; the
 *     suggestion-nested row shape (resolves the media item THROUGH the
 *     suggestion) and thumbnail merge via signThumbsBatched.
 *   - enqueueExecuteBatches: chunking by BATCH_SIZE (200), keyed on
 *     suggestionId (not mediaItemId, unlike trash-empty); no-op when there
 *     are no matched items.
 *
 * No database required — PrismaService, CircleMembershipService,
 * EnrichmentJobService, and MediaThumbnailService are all mocked.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CircleRole,
  LocationSuggestionRunAction,
  LocationSuggestionRunItemStatus,
  LocationSuggestionRunStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { LocationSuggestionRunService } from './location-suggestion-run.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { MediaThumbnailService } from '../../media/media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const RUN_ID = randomUUID();
const USER_ID = randomUUID();

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
    startedById: USER_ID,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('LocationSuggestionRunService', () => {
  let service: LocationSuggestionRunService;
  let prisma: MockPrismaService;
  let circleMembership: jest.Mocked<Pick<CircleMembershipService, 'assertCircleAccess'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;
  let thumbnails: jest.Mocked<Pick<MediaThumbnailService, 'signThumbsBatched' | 'extractThumbKey'>>;

  beforeEach(() => {
    prisma = createMockPrismaService();
    circleMembership = {
      assertCircleAccess: jest
        .fn()
        .mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    enrichmentJobs = { enqueue: jest.fn().mockResolvedValue({ id: randomUUID() }) };
    thumbnails = {
      signThumbsBatched: jest.fn().mockResolvedValue(new Map()),
      extractThumbKey: jest.fn().mockReturnValue(null),
    };

    service = new LocationSuggestionRunService(
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
    it('asserts collaborator access before doing anything else', async () => {
      prisma.locationSuggestionRun.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(
        CIRCLE_ID,
        LocationSuggestionRunAction.accept,
        80,
        USER_ID,
        ['media:write'],
      );

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:write'],
        CircleRole.collaborator,
      );
    });

    it('propagates the ForbiddenException from a failed collaborator check without creating a run', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      circleMembership.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('not a collaborator'),
      );

      await expect(
        service.createRun(CIRCLE_ID, LocationSuggestionRunAction.accept, 80, USER_ID, [
          'media:write',
        ]),
      ).rejects.toThrow('not a collaborator');
      expect(prisma.locationSuggestionRun.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when an active run (evaluating/running) already exists for the circle', async () => {
      prisma.locationSuggestionRun.count.mockResolvedValue(1);

      await expect(
        service.createRun(CIRCLE_ID, LocationSuggestionRunAction.accept, 80, USER_ID, [
          'media:write',
        ]),
      ).rejects.toThrow(ConflictException);
      expect(prisma.locationSuggestionRun.create).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('queries the concurrency guard scoped to {evaluating, running} for this circle', async () => {
      prisma.locationSuggestionRun.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(
        CIRCLE_ID,
        LocationSuggestionRunAction.accept,
        80,
        USER_ID,
        ['media:write'],
      );

      expect(prisma.locationSuggestionRun.count).toHaveBeenCalledWith({
        where: {
          circleId: CIRCLE_ID,
          status: {
            in: [LocationSuggestionRunStatus.evaluating, LocationSuggestionRunStatus.running],
          },
        },
      });
    });

    it('creates a run in "evaluating" status persisting action + threshold, and returns the serialized run', async () => {
      prisma.locationSuggestionRun.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.create.mockResolvedValue(
        makeRun({ action: LocationSuggestionRunAction.reject, threshold: 40 }) as any,
      );

      const result = await service.createRun(
        CIRCLE_ID,
        LocationSuggestionRunAction.reject,
        40,
        USER_ID,
        ['media:write'],
      );

      expect(prisma.locationSuggestionRun.create).toHaveBeenCalledWith({
        data: {
          circleId: CIRCLE_ID,
          action: LocationSuggestionRunAction.reject,
          threshold: 40,
          status: LocationSuggestionRunStatus.evaluating,
          startedById: USER_ID,
        },
      });
      expect(result.status).toBe(LocationSuggestionRunStatus.evaluating);
      expect(result.action).toBe(LocationSuggestionRunAction.reject);
      expect(result.threshold).toBe(40);
      expect(result.id).toBe(RUN_ID);
    });

    it('enqueues location_suggestion_run_evaluate at priority 20 with skipDedup and payload {runId}', async () => {
      prisma.locationSuggestionRun.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(
        CIRCLE_ID,
        LocationSuggestionRunAction.accept,
        80,
        USER_ID,
        ['media:write'],
      );

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith({
        type: 'location_suggestion_run_evaluate',
        mediaItemId: null,
        circleId: CIRCLE_ID,
        reason: 'rerun',
        priority: 20,
        skipDedup: true,
        payload: { runId: RUN_ID },
      });
    });

    it('writes a location_suggestion_run:started audit event', async () => {
      prisma.locationSuggestionRun.count.mockResolvedValue(0);
      prisma.locationSuggestionRun.create.mockResolvedValue(makeRun() as any);

      await service.createRun(
        CIRCLE_ID,
        LocationSuggestionRunAction.accept,
        80,
        USER_ID,
        ['media:write'],
      );

      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'location_suggestion_run:started',
            targetType: 'location_suggestion_run',
            targetId: RUN_ID,
            meta: { circleId: CIRCLE_ID, action: LocationSuggestionRunAction.accept, threshold: 80 },
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
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(null);

      await expect(
        service.cancelRun(RUN_ID, USER_ID, ['media:write']),
      ).rejects.toThrow(NotFoundException);
    });

    it.each([LocationSuggestionRunStatus.evaluating, LocationSuggestionRunStatus.running])(
      'cancels a non-terminal run in status %s',
      async (status) => {
        prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun({ status }) as any);
        prisma.locationSuggestionRun.update.mockResolvedValue(
          makeRun({ status: LocationSuggestionRunStatus.cancelled }) as any,
        );

        const result = await service.cancelRun(RUN_ID, USER_ID, ['media:write']);

        expect(result).toEqual({ runId: RUN_ID, status: LocationSuggestionRunStatus.cancelled });
        expect(prisma.locationSuggestionRun.update).toHaveBeenCalledWith({
          where: { id: RUN_ID },
          data: { status: LocationSuggestionRunStatus.cancelled, finishedAt: expect.any(Date) },
        });
      },
    );

    it.each([
      LocationSuggestionRunStatus.completed,
      LocationSuggestionRunStatus.completed_with_errors,
      LocationSuggestionRunStatus.failed,
      LocationSuggestionRunStatus.cancelled,
    ])('rejects cancelling an already-terminal run in status %s', async (status) => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun({ status }) as any);

      await expect(
        service.cancelRun(RUN_ID, USER_ID, ['media:write']),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.locationSuggestionRun.update).not.toHaveBeenCalled();
    });

    it('asserts collaborator access scoped to the run’s circle', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.locationSuggestionRun.update.mockResolvedValue(
        makeRun({ status: LocationSuggestionRunStatus.cancelled }) as any,
      );

      await service.cancelRun(RUN_ID, USER_ID, ['media:write']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:write'],
        CircleRole.collaborator,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getRunDetail
  // ---------------------------------------------------------------------------

  describe('getRunDetail', () => {
    it('throws NotFoundException when the run does not exist', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(null);

      await expect(
        service.getRunDetail(RUN_ID, USER_ID, ['media:read']),
      ).rejects.toThrow(NotFoundException);
    });

    it('asserts viewer access scoped to the run’s circle', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      (prisma.locationSuggestionRunItem.groupBy as jest.Mock).mockResolvedValue([]);

      await service.getRunDetail(RUN_ID, USER_ID, ['media:read']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:read'],
        CircleRole.viewer,
      );
    });

    it('returns the serialized run plus itemStatusCounts derived from groupBy', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(
        makeRun({ matchedCount: 10, processedCount: 4, succeededCount: 3, failedCount: 1 }) as any,
      );
      (prisma.locationSuggestionRunItem.groupBy as jest.Mock).mockResolvedValue([
        { status: LocationSuggestionRunItemStatus.matched, _count: { _all: 6 } },
        { status: LocationSuggestionRunItemStatus.applied, _count: { _all: 3 } },
        { status: LocationSuggestionRunItemStatus.failed, _count: { _all: 1 } },
      ]);

      const result = await service.getRunDetail(RUN_ID, USER_ID, ['media:read']);

      expect(result.matchedCount).toBe(10);
      expect(result.itemStatusCounts).toEqual({ matched: 6, applied: 3, failed: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // listRunItems
  // ---------------------------------------------------------------------------

  describe('listRunItems', () => {
    const query = { page: 1, pageSize: 50 };

    it('throws NotFoundException when the run does not exist', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(null);

      await expect(
        service.listRunItems(RUN_ID, query, USER_ID, ['media:read']),
      ).rejects.toThrow(NotFoundException);
    });

    it('asserts viewer access scoped to the run’s circle', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);

      await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['media:read'],
        CircleRole.viewer,
      );
    });

    it('returns paginated items resolving the media item THROUGH the suggestion, with signed thumbnails merged in', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      const mediaItemId = randomUUID();
      const suggestionId = randomUUID();
      const rowItem = {
        id: 'item-row-1',
        suggestionId,
        status: LocationSuggestionRunItemStatus.applied,
        error: null,
        updatedAt: new Date(),
        suggestion: {
          mediaItemId,
          lat: 10.5,
          lng: -20.1,
          confidence: 0.92,
          mediaItem: {
            id: mediaItemId,
            type: 'photo',
            capturedAt: new Date('2024-01-01'),
            originalFilename: 'a.jpg',
            width: 100,
            height: 100,
            metadata: { thumbnailKey: 'thumbs/a.jpg' },
          },
        },
      };
      prisma.$transaction.mockResolvedValue([[rowItem], 1] as any);
      thumbnails.extractThumbKey.mockReturnValue('thumbs/a.jpg');
      thumbnails.signThumbsBatched.mockResolvedValue(
        new Map([['thumbs/a.jpg', 'https://signed.example.com/a.jpg']]),
      );

      const result = await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(result.meta).toEqual({ page: 1, pageSize: 50, totalItems: 1, totalPages: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'item-row-1',
        suggestionId,
        mediaItemId,
        status: LocationSuggestionRunItemStatus.applied,
        lat: 10.5,
        lng: -20.1,
        confidence: 0.92,
        thumbnailUrl: 'https://signed.example.com/a.jpg',
        media: { type: 'photo', filename: 'a.jpg' },
      });
    });

    it('resolves suggestionId/mediaItemId/media: null for a run item whose LocationSuggestion row is already gone', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      const rowItem = {
        id: 'item-row-orphan',
        suggestionId: randomUUID(),
        status: LocationSuggestionRunItemStatus.applied,
        error: null,
        updatedAt: new Date(),
        suggestion: null,
      };
      prisma.$transaction.mockResolvedValue([[rowItem], 1] as any);
      thumbnails.extractThumbKey.mockReturnValue(null);

      const result = await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(result.items[0].mediaItemId).toBeNull();
      expect(result.items[0].media).toBeNull();
      expect(result.items[0].thumbnailUrl).toBeNull();
    });

    it('filters by status when provided', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);

      await service.listRunItems(
        RUN_ID,
        { ...query, status: LocationSuggestionRunItemStatus.failed },
        USER_ID,
        ['media:read'],
      );

      expect(prisma.locationSuggestionRunItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { runId: RUN_ID, status: LocationSuggestionRunItemStatus.failed },
        }),
      );
      expect(prisma.locationSuggestionRunItem.count).toHaveBeenCalledWith({
        where: { runId: RUN_ID, status: LocationSuggestionRunItemStatus.failed },
      });
    });

    it('omits the status key from the where clause when no status filter is given', async () => {
      prisma.locationSuggestionRun.findUnique.mockResolvedValue(makeRun() as any);
      prisma.$transaction.mockResolvedValue([[], 0] as any);

      await service.listRunItems(RUN_ID, query, USER_ID, ['media:read']);

      expect(prisma.locationSuggestionRunItem.count).toHaveBeenCalledWith({
        where: { runId: RUN_ID },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // enqueueExecuteBatches
  // ---------------------------------------------------------------------------

  describe('enqueueExecuteBatches', () => {
    it('chunks matched items (by suggestionId) into ceil(N / 200) enrichment jobs', async () => {
      const ids = Array.from({ length: 450 }, () => randomUUID());
      prisma.locationSuggestionRunItem.findMany.mockResolvedValue(
        ids.map((suggestionId) => ({ suggestionId })) as any,
      );

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      // 450 / 200 -> 3 batches (200, 200, 50).
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(3);
      const payloads = (enrichmentJobs.enqueue as jest.Mock).mock.calls.map(
        (c) => (c[0].payload as { suggestionIds: string[] }).suggestionIds,
      );
      expect(payloads[0]).toHaveLength(200);
      expect(payloads[1]).toHaveLength(200);
      expect(payloads[2]).toHaveLength(50);
      expect(payloads.flat().sort()).toEqual([...ids].sort());
    });

    it('enqueues each batch with priority 100, skipDedup, and reason "rerun"', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      prisma.locationSuggestionRunItem.findMany.mockResolvedValue(
        ids.map((suggestionId) => ({ suggestionId })) as any,
      );

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'location_suggestion_run_execute_batch',
          mediaItemId: null,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 100,
          skipDedup: true,
          payload: { runId: RUN_ID, suggestionIds: ids },
        }),
      );
    });

    it('only queries items with status matched', async () => {
      prisma.locationSuggestionRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      expect(prisma.locationSuggestionRunItem.findMany).toHaveBeenCalledWith({
        where: { runId: RUN_ID, status: LocationSuggestionRunItemStatus.matched },
        select: { suggestionId: true },
      });
    });

    it('enqueues nothing when there are no matched items', async () => {
      prisma.locationSuggestionRunItem.findMany.mockResolvedValue([] as any);

      await service.enqueueExecuteBatches(RUN_ID, CIRCLE_ID);

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });
});
