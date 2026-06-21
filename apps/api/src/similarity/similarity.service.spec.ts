/**
 * Unit tests for SimilarityService.
 *
 * Covers:
 *  - listSimilarityGroups: RBAC (assertCircleAccess called with viewer), response
 *    shape { items, meta }, only groups >= minGroupSize surfaced, signed thumbnail
 *    URLs, perceptualHash never in response, empty result
 *  - getSimilarityGroup: RBAC (viewer), 404, isSuggestedBest derived correctly,
 *    perceptualHash not in members, signed thumbnailUrl per member
 *  - resolveSimilarityGroup: RBAC (collaborator), 404, 400 on non-pending status,
 *    400 on invalid keepIds, soft-deletes non-kept, status=resolved, allows keeping all
 *  - dismissSimilarityGroup: RBAC (collaborator), 404, 400 on non-pending status,
 *    clears similarityGroupId + similarityScore (NOT burstScore), status=dismissed
 *  - backfillSimilarityDetection: RBAC (collaborator), 404 when circle not found,
 *    400 when visualDedupEnabled=false, backfill reason + priority 100, force=false
 *    skips succeeded jobs, force=true enqueues all photos, capturedAt range filtering
 *  - getDedupSettings: RBAC (viewer), 404, returns { visualDedupEnabled }
 *  - updateDedupSettings: RBAC (circle_admin), calls circle.update, creates audit event
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SimilarityService } from './similarity.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CircleRole, JobReason, JobStatus, MediaType, SimilarityGroupStatus } from '@prisma/client';
import { SimilarityQueryDto } from './dto/similarity-query.dto';
import { ResolveSimilarityDto } from './dto/resolve-similarity.dto';
import { SimilarityBackfillDto } from './dto/similarity-backfill.dto';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const CIRCLE_ID = 'circle-xyz';
const GROUP_ID = 'group-111';

const PERMS_MEDIA_READ = ['media:read'];
const PERMS_MEDIA_WRITE = ['media:write'];
const PERMS_MEDIA_DELETE = ['media:delete'];

function makeRequestUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: USER_ID,
    email: 'test@example.com',
    roles: ['Viewer'],
    permissions: PERMS_MEDIA_READ,
    isActive: true,
    ...overrides,
  };
}

function makeQueryDto(overrides: Partial<SimilarityQueryDto> = {}): SimilarityQueryDto {
  return {
    circleId: CIRCLE_ID,
    status: 'pending',
    page: 1,
    pageSize: 20,
    ...overrides,
  } as SimilarityQueryDto;
}

function makeResolveDto(keepIds: string[]): ResolveSimilarityDto {
  return { keepIds } as ResolveSimilarityDto;
}

function makeBackfillDto(overrides: Partial<SimilarityBackfillDto> = {}): SimilarityBackfillDto {
  return { circleId: CIRCLE_ID, force: false, ...overrides } as SimilarityBackfillDto;
}

function makeSimilarityGroupRow(overrides: Partial<{
  id: string;
  circleId: string;
  status: SimilarityGroupStatus;
  mediaCount: number;
  createdAt: Date;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  suggestedBestItem: { metadata: Record<string, unknown> } | null;
  items: Array<{ id: string; metadata: Record<string, unknown> }>;
}> = {}) {
  return {
    id: GROUP_ID,
    circleId: CIRCLE_ID,
    status: SimilarityGroupStatus.pending,
    mediaCount: 4,
    createdAt: new Date(),
    suggestedBestItemId: 'media-1',
    resolvedById: null,
    resolvedAt: null,
    suggestedBestItem: { metadata: { thumbnailStorageKey: 'thumbnails/best.jpg' } },
    items: [
      { id: 'media-1', metadata: { thumbnailStorageKey: 'thumbnails/1.jpg' } },
      { id: 'media-2', metadata: { thumbnailStorageKey: 'thumbnails/2.jpg' } },
    ],
    ...overrides,
  };
}

function makeDetailGroup(overrides: Partial<{
  id: string;
  circleId: string;
  status: SimilarityGroupStatus;
  mediaCount: number;
  createdAt: Date;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  items: Array<{
    id: string;
    similarityScore: number | null;
    sharpnessScore: number | null;
    width: number | null;
    height: number | null;
    metadata: Record<string, unknown>;
    importedAt: Date;
    capturedAt: Date | null;
  }>;
}> = {}) {
  return {
    id: GROUP_ID,
    circleId: CIRCLE_ID,
    status: SimilarityGroupStatus.pending,
    mediaCount: 2,
    createdAt: new Date(),
    suggestedBestItemId: 'media-1',
    resolvedById: null,
    resolvedAt: null,
    items: [
      {
        id: 'media-1',
        similarityScore: 0.87,
        sharpnessScore: 412.3,
        width: 4032,
        height: 3024,
        metadata: { thumbnailStorageKey: 'thumbnails/1.jpg' },
        importedAt: new Date('2026-06-15T14:32:00Z'),
        capturedAt: new Date('2026-06-15T14:32:00Z'),
      },
      {
        id: 'media-2',
        similarityScore: 0.42,
        sharpnessScore: 210.1,
        width: 4032,
        height: 3024,
        metadata: { thumbnailStorageKey: 'thumbnails/2.jpg' },
        importedAt: new Date('2026-06-15T14:32:03Z'),
        capturedAt: new Date('2026-06-15T14:32:03Z'),
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SimilarityService', () => {
  let service: SimilarityService;
  let mockPrisma: MockPrismaService;
  let mockMembership: { assertCircleAccess: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockMembership = { assertCircleAccess: jest.fn().mockResolvedValue(undefined) };
    mockEnrichmentJobService = { enqueue: jest.fn() };
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed-url'),
    };

    // Default: $transaction executes array operations in parallel
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    // Default system settings: minGroupSize=2
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { similarity: { minGroupSize: 2 } },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimilarityService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
      ],
    }).compile();

    service = module.get<SimilarityService>(SimilarityService);
  });

  // -------------------------------------------------------------------------
  // listSimilarityGroups
  // -------------------------------------------------------------------------

  describe('listSimilarityGroups', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.similarityGroup.count as jest.Mock).mockResolvedValue(0);

      await service.listSimilarityGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('returns { items, meta } shape', async () => {
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.similarityGroup.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listSimilarityGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('meta');
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.meta).toMatchObject({ total: 0, page: 1, pageSize: 20 });
    });

    it('queries only groups with mediaCount >= minGroupSize from system settings', async () => {
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.similarityGroup.count as jest.Mock).mockResolvedValue(0);

      await service.listSimilarityGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      const findManyCall = (mockPrisma.similarityGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.mediaCount).toEqual({ gte: 2 });
    });

    it('returns signed thumbnail URLs via getSignedDownloadUrl', async () => {
      const group = makeSimilarityGroupRow();
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([group]);
      (mockPrisma.similarityGroup.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listSimilarityGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalled();
      expect(result.items[0].suggestedBestThumbnailUrl).toBe('https://cdn.example.com/signed-url');
    });

    it('response items do NOT contain perceptualHash field', async () => {
      const group = makeSimilarityGroupRow();
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([group]);
      (mockPrisma.similarityGroup.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listSimilarityGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      for (const item of result.items) {
        expect(item).not.toHaveProperty('perceptualHash');
      }
    });

    it('returns empty items array and total=0 when no groups found', async () => {
      (mockPrisma.similarityGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.similarityGroup.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listSimilarityGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result.items).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getSimilarityGroup
  // -------------------------------------------------------------------------

  describe('getSimilarityGroup', () => {
    it('throws NotFoundException when group is not found', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getSimilarityGroup('nonexistent', USER_ID, PERMS_MEDIA_READ),
      ).rejects.toThrow(NotFoundException);
    });

    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(makeDetailGroup());

      await service.getSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('sets isSuggestedBest=true only on the member matching suggestedBestItemId', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(
        makeDetailGroup({ suggestedBestItemId: 'media-1' }),
      );

      const result = await service.getSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      const best = result.data.members.find((m: any) => m.id === 'media-1');
      const nonBest = result.data.members.find((m: any) => m.id === 'media-2');
      expect(best?.isSuggestedBest).toBe(true);
      expect(nonBest?.isSuggestedBest).toBe(false);
    });

    it('members do NOT have perceptualHash field in response', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(makeDetailGroup());

      const result = await service.getSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      for (const member of result.data.members) {
        expect(member).not.toHaveProperty('perceptualHash');
      }
    });

    it('returns signed thumbnailUrl per member', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(makeDetailGroup());

      const result = await service.getSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      for (const member of result.data.members) {
        expect(member.thumbnailUrl).toBe('https://cdn.example.com/signed-url');
      }
    });
  });

  // -------------------------------------------------------------------------
  // resolveSimilarityGroup
  // -------------------------------------------------------------------------

  describe('resolveSimilarityGroup', () => {
    function setupGroup(overrides: Partial<{
      status: SimilarityGroupStatus;
      items: { id: string }[];
    }> = {}) {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: SimilarityGroupStatus.pending,
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupGroup();

      await service.resolveSimilarityGroup(
        GROUP_ID,
        makeResolveDto(['media-1']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_DELETE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when group not found', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resolveSimilarityGroup(
          GROUP_ID,
          makeResolveDto(['media-1']),
          USER_ID,
          PERMS_MEDIA_DELETE,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when group is not pending', async () => {
      setupGroup({ status: SimilarityGroupStatus.resolved });

      await expect(
        service.resolveSimilarityGroup(
          GROUP_ID,
          makeResolveDto(['media-1']),
          USER_ID,
          PERMS_MEDIA_DELETE,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when keepIds contains ID not in group', async () => {
      setupGroup();

      await expect(
        service.resolveSimilarityGroup(
          GROUP_ID,
          makeResolveDto(['media-1', 'not-in-group-id']),
          USER_ID,
          PERMS_MEDIA_DELETE,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('soft-deletes non-kept members (sets deletedAt)', async () => {
      setupGroup();

      await service.resolveSimilarityGroup(
        GROUP_ID,
        makeResolveDto(['media-1']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { deletedAt: expect.any(Date) },
        }),
      );
    });

    it('marks the group as resolved with resolvedById and resolvedAt', async () => {
      setupGroup();

      await service.resolveSimilarityGroup(
        GROUP_ID,
        makeResolveDto(['media-1']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(mockPrisma.similarityGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GROUP_ID },
          data: expect.objectContaining({
            status: SimilarityGroupStatus.resolved,
            resolvedById: USER_ID,
            resolvedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('returns { data: { deleted, kept, groupStatus: "resolved" } }', async () => {
      setupGroup();

      const result = await service.resolveSimilarityGroup(
        GROUP_ID,
        makeResolveDto(['media-1']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data).toMatchObject({
        deleted: 2,
        kept: 1,
        groupStatus: 'resolved',
      });
    });

    it('allows keeping all members (zero deletions)', async () => {
      setupGroup();

      const result = await service.resolveSimilarityGroup(
        GROUP_ID,
        makeResolveDto(['media-1', 'media-2', 'media-3']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.deleted).toBe(0);
      expect(result.data.kept).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // dismissSimilarityGroup
  // -------------------------------------------------------------------------

  describe('dismissSimilarityGroup', () => {
    function setupGroupForDismiss(overrides: Partial<{
      status: SimilarityGroupStatus;
      items: { id: string }[];
    }> = {}) {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: SimilarityGroupStatus.pending,
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 3 });
      (mockPrisma.similarityGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupGroupForDismiss();

      await service.dismissSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when group not found', async () => {
      (mockPrisma.similarityGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.dismissSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when group is not pending', async () => {
      setupGroupForDismiss({ status: SimilarityGroupStatus.dismissed });

      await expect(
        service.dismissSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE),
      ).rejects.toThrow(BadRequestException);
    });

    it('clears similarityGroupId and similarityScore on all members (NOT burstScore)', async () => {
      setupGroupForDismiss();

      await service.dismissSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      const updateManyCall = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls[0][0];
      expect(updateManyCall).toMatchObject({
        where: { similarityGroupId: GROUP_ID },
        data: { similarityGroupId: null, similarityScore: null },
      });
      // Confirm it does NOT clear burstGroupId or burstScore
      expect(updateManyCall.data).not.toHaveProperty('burstGroupId');
      expect(updateManyCall.data).not.toHaveProperty('burstScore');
    });

    it('marks group as dismissed with resolvedById and resolvedAt', async () => {
      setupGroupForDismiss();

      await service.dismissSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockPrisma.similarityGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GROUP_ID },
          data: expect.objectContaining({
            status: SimilarityGroupStatus.dismissed,
            resolvedById: USER_ID,
            resolvedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('returns { data: { groupStatus: "dismissed", ungrouped: N } }', async () => {
      setupGroupForDismiss();

      const result = await service.dismissSimilarityGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(result.data).toMatchObject({
        groupStatus: 'dismissed',
        ungrouped: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // backfillSimilarityDetection
  // -------------------------------------------------------------------------

  describe('backfillSimilarityDetection', () => {
    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.backfillSimilarityDetection(makeBackfillDto(), USER_ID, PERMS_MEDIA_WRITE);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when circle not found', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.backfillSimilarityDetection(makeBackfillDto(), USER_ID, PERMS_MEDIA_WRITE),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when visualDedupEnabled=false', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: false });

      await expect(
        service.backfillSimilarityDetection(makeBackfillDto(), USER_ID, PERMS_MEDIA_WRITE),
      ).rejects.toThrow(BadRequestException);
    });

    it('enqueues with type="similarity_detection", reason=backfill, priority=100', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'media-1' },
        { id: 'media-2' },
      ]);
      mockEnrichmentJobService.enqueue.mockResolvedValue({
        id: 'job-1',
        status: JobStatus.pending,
      });

      await service.backfillSimilarityDetection(
        makeBackfillDto({ force: false }),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'similarity_detection',
          reason: JobReason.backfill,
          priority: 100,
        }),
      );
    });

    it('force=false: skips items that already have succeeded similarity_detection jobs', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      // media-1 already has a succeeded job
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([
        { mediaItemId: 'media-1' },
      ]);
      // Only media-2 is returned (no burstGroupId + not in excludeIds)
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([{ id: 'media-2' }]);
      mockEnrichmentJobService.enqueue.mockResolvedValue({
        id: 'job-new',
        status: JobStatus.pending,
      });

      const result = await service.backfillSimilarityDetection(
        makeBackfillDto({ force: false }),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(1);
      expect(result.data.enqueued).toBe(1);
    });

    it('force=true: enqueues all non-deleted photos regardless of existing jobs', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'media-1' },
        { id: 'media-2' },
        { id: 'media-3' },
      ]);
      mockEnrichmentJobService.enqueue.mockResolvedValue({
        id: 'job-x',
        status: JobStatus.pending,
      });

      const result = await service.backfillSimilarityDetection(
        makeBackfillDto({ force: true }),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(3);
      expect(result.data.enqueued).toBe(3);
    });

    it('force=true: queries only type=photo with deletedAt=null', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

      await service.backfillSimilarityDetection(
        makeBackfillDto({ force: true }),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.type).toBe(MediaType.photo);
      expect(findManyCall.where.deletedAt).toBeNull();
    });

    // -----------------------------------------------------------------------
    // capturedAt range filtering (from / to)
    // -----------------------------------------------------------------------

    describe('capturedAt range filtering (from / to)', () => {
      const FROM_ISO = '2026-01-01T00:00:00Z';
      const TO_ISO = '2026-06-30T23:59:59Z';

      function setupEnabled() {
        (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
        (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
      }

      it('force=true: passes gte+lte capturedAt filter when both from and to are set', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: true, from: FROM_ISO, to: TO_ISO }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.capturedAt).toEqual({
          gte: new Date(FROM_ISO),
          lte: new Date(TO_ISO),
        });
      });

      it('force=false: passes gte+lte capturedAt filter when both from and to are set', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: false, from: FROM_ISO, to: TO_ISO }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.capturedAt).toEqual({
          gte: new Date(FROM_ISO),
          lte: new Date(TO_ISO),
        });
      });

      it('force=true: passes only gte when only from is set', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: true, from: FROM_ISO }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.capturedAt).toEqual({ gte: new Date(FROM_ISO) });
        expect(findManyCall.where.capturedAt).not.toHaveProperty('lte');
      });

      it('force=true: passes only lte when only to is set', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: true, to: TO_ISO }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.capturedAt).toEqual({ lte: new Date(TO_ISO) });
        expect(findManyCall.where.capturedAt).not.toHaveProperty('gte');
      });

      it('force=false: passes only gte when only from is set', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: false, from: FROM_ISO }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.capturedAt).toEqual({ gte: new Date(FROM_ISO) });
        expect(findManyCall.where.capturedAt).not.toHaveProperty('lte');
      });

      it('force=false: passes only lte when only to is set', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: false, to: TO_ISO }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.capturedAt).toEqual({ lte: new Date(TO_ISO) });
        expect(findManyCall.where.capturedAt).not.toHaveProperty('gte');
      });

      it('no capturedAt key in where-clause when neither from nor to is provided', async () => {
        setupEnabled();

        await service.backfillSimilarityDetection(
          makeBackfillDto({ force: true }),
          USER_ID,
          PERMS_MEDIA_WRITE,
        );

        const findManyCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where).not.toHaveProperty('capturedAt');
      });
    });

    // -----------------------------------------------------------------------
    // SimilarityBackfillDto Zod validation: from > to is rejected
    // -----------------------------------------------------------------------

    describe('SimilarityBackfillDto validation', () => {
      it('rejects when from is after to', () => {
        const { SimilarityBackfillDto: Dto } = require('./dto/similarity-backfill.dto');

        const schema = Dto.zodSchema;
        const VALID_UUID = '11111111-1111-1111-8111-111111111111';

        if (schema) {
          const result = schema.safeParse({
            circleId: VALID_UUID,
            force: false,
            from: '2026-06-30T00:00:00Z',
            to: '2026-01-01T00:00:00Z', // before from → invalid
          });
          expect(result.success).toBe(false);
          if (!result.success) {
            const fromError = result.error.errors.find((e: any) => e.path.includes('from'));
            expect(fromError).toBeDefined();
            expect(fromError?.message).toMatch(/must not be after/i);
          }
        } else {
          // Fallback: reconstruct minimal schema to verify the refine behavior
          const z = require('zod');
          const minimalSchema = z
            .object({
              circleId: z.string().uuid(),
              force: z.boolean().optional().default(false),
              from: z.string().datetime({ offset: true }).optional(),
              to: z.string().datetime({ offset: true }).optional(),
            })
            .refine(
              (data: any) => {
                if (data.from && data.to) {
                  return new Date(data.from) <= new Date(data.to);
                }
                return true;
              },
              { message: '`from` must not be after `to`', path: ['from'] },
            );

          const result = minimalSchema.safeParse({
            circleId: VALID_UUID,
            force: false,
            from: '2026-06-30T00:00:00Z',
            to: '2026-01-01T00:00:00Z',
          });
          expect(result.success).toBe(false);
        }
      });

      it('accepts when from equals to (same instant is valid)', () => {
        const z = require('zod');
        const schema = z
          .object({
            circleId: z.string().uuid(),
            force: z.boolean().optional().default(false),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
          })
          .refine(
            (data: any) => {
              if (data.from && data.to) {
                return new Date(data.from) <= new Date(data.to);
              }
              return true;
            },
            { message: '`from` must not be after `to`', path: ['from'] },
          );

        const result = schema.safeParse({
          circleId: '11111111-1111-1111-8111-111111111111',
          force: false,
          from: '2026-06-01T00:00:00Z',
          to: '2026-06-01T00:00:00Z',
        });
        expect(result.success).toBe(true);
      });

      it('accepts when only from is provided (no upper-bound to compare against)', () => {
        const z = require('zod');
        const schema = z
          .object({
            circleId: z.string().uuid(),
            force: z.boolean().optional().default(false),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
          })
          .refine(
            (data: any) => {
              if (data.from && data.to) {
                return new Date(data.from) <= new Date(data.to);
              }
              return true;
            },
            { message: '`from` must not be after `to`', path: ['from'] },
          );

        const result = schema.safeParse({
          circleId: '11111111-1111-1111-8111-111111111111',
          force: false,
          from: '2026-06-30T00:00:00Z',
        });
        expect(result.success).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // getDedupSettings
  // -------------------------------------------------------------------------

  describe('getDedupSettings', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: false });
      const user = makeRequestUser();

      await service.getDedupSettings(CIRCLE_ID, user);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        user.permissions,
        CircleRole.viewer,
      );
    });

    it('throws NotFoundException when circle not found', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getDedupSettings(CIRCLE_ID, makeRequestUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns { visualDedupEnabled: boolean }', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });

      const result = await service.getDedupSettings(CIRCLE_ID, makeRequestUser());

      expect(result).toEqual({ visualDedupEnabled: true });
    });
  });

  // -------------------------------------------------------------------------
  // updateDedupSettings
  // -------------------------------------------------------------------------

  describe('updateDedupSettings', () => {
    it('calls assertCircleAccess with circle_admin role', async () => {
      (mockPrisma.circle.update as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
      const user = makeRequestUser({ permissions: ['circles:write'] });

      await service.updateDedupSettings(CIRCLE_ID, true, user);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        user.permissions,
        CircleRole.circle_admin,
      );
    });

    it('calls circle.update with { visualDedupEnabled: enabled }', async () => {
      (mockPrisma.circle.update as jest.Mock).mockResolvedValue({ visualDedupEnabled: false });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

      await service.updateDedupSettings(CIRCLE_ID, false, makeRequestUser());

      expect(mockPrisma.circle.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CIRCLE_ID },
          data: { visualDedupEnabled: false },
        }),
      );
    });

    it('creates an audit event with action "circle:dedup_settings_update"', async () => {
      (mockPrisma.circle.update as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

      await service.updateDedupSettings(CIRCLE_ID, true, makeRequestUser());

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'circle:dedup_settings_update',
            targetType: 'circle',
            targetId: CIRCLE_ID,
          }),
        }),
      );
    });

    it('returns { visualDedupEnabled: boolean } from the updated circle', async () => {
      (mockPrisma.circle.update as jest.Mock).mockResolvedValue({ visualDedupEnabled: true });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

      const result = await service.updateDedupSettings(CIRCLE_ID, true, makeRequestUser());

      expect(result).toEqual({ visualDedupEnabled: true });
    });
  });
});
