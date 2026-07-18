/**
 * Unit tests for BurstService.
 *
 * Covers:
 *  - listBurstGroups: RBAC (assertCircleAccess called with viewer), response shape
 *    { items, meta }, only groups >= minGroupSize surfaced, perceptualHash never
 *    included in response
 *  - getBurstGroup: RBAC (viewer), 404, isSuggestedBest derived correctly,
 *    perceptualHash not in members
 *  - resolveBurstGroup: RBAC (collaborator), 400 on non-pending status,
 *    400 on invalid keepIds, soft-deletes non-kept members, status=resolved
 *  - dismissBurstGroup: RBAC (collaborator), 400 on non-pending status,
 *    clears burstGroupId + burstScore, status=dismissed
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BurstService } from './burst.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { DuplicateDetectionService } from '../dedup/duplicate-detection.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { BurstGroupStatus, CircleRole, MediaType } from '@prisma/client';
import { BurstQueryDto } from './dto/burst-query.dto';
import { ResolveBurstDto } from './dto/resolve-burst.dto';
import { BulkResolveBurstDto } from './dto/bulk-resolve-burst.dto';
import { BulkResolveBurstThresholdDto } from './dto/bulk-resolve-burst-threshold.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const CIRCLE_ID = 'circle-xyz';
const GROUP_ID = 'group-111';

const PERMS_MEDIA_READ = ['media:read'];
const PERMS_MEDIA_WRITE = ['media:write'];
const PERMS_MEDIA_DELETE = ['media:delete'];

function makeQueryDto(overrides: Partial<BurstQueryDto> = {}): BurstQueryDto {
  return {
    circleId: CIRCLE_ID,
    status: 'pending',
    page: 1,
    pageSize: 20,
    ...overrides,
  } as BurstQueryDto;
}

function makeResolveDto(
  keepIds: string[],
  action: 'archive' | 'trash' = 'trash',
): ResolveBurstDto {
  return { keepIds, action } as ResolveBurstDto;
}

function makeBulkResolveDto(
  ids: string[],
  action: 'archive' | 'trash' = 'archive',
  circleId: string = CIRCLE_ID,
): BulkResolveBurstDto {
  return { circleId, ids, action } as BulkResolveBurstDto;
}

function makeBulkResolveThresholdDto(
  threshold: number,
  action: 'archive' | 'trash' = 'archive',
  circleId: string = CIRCLE_ID,
): BulkResolveBurstThresholdDto {
  return { circleId, threshold, action } as BulkResolveBurstThresholdDto;
}

function makeBurstGroupRow(overrides: Partial<{
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: Date | null;
  confidence: number | null;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  suggestedBestItem: { metadata: Record<string, unknown> } | null;
  items: Array<{ id: string; metadata: Record<string, unknown> }>;
}> = {}) {
  return {
    id: GROUP_ID,
    circleId: CIRCLE_ID,
    status: BurstGroupStatus.pending,
    mediaCount: 5,
    capturedAt: new Date('2026-06-15T14:32:00Z'),
    confidence: 0.82,
    suggestedBestItemId: 'media-1',
    resolvedById: null,
    resolvedAt: null,
    createdAt: new Date(),
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
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: Date | null;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  items: Array<{
    id: string;
    capturedAt: Date | null;
    burstScore: number | null;
    sharpnessScore: number | null;
    width: number | null;
    height: number | null;
    metadata: Record<string, unknown>;
  }>;
}> = {}) {
  return {
    id: GROUP_ID,
    circleId: CIRCLE_ID,
    status: BurstGroupStatus.pending,
    mediaCount: 3,
    capturedAt: new Date('2026-06-15T14:32:00Z'),
    suggestedBestItemId: 'media-1',
    resolvedById: null,
    resolvedAt: null,
    items: [
      {
        id: 'media-1',
        capturedAt: new Date('2026-06-15T14:32:00Z'),
        burstScore: 0.87,
        sharpnessScore: 412.3,
        width: 4032,
        height: 3024,
        metadata: { thumbnailStorageKey: 'thumbnails/1.jpg' },
      },
      {
        id: 'media-2',
        capturedAt: new Date('2026-06-15T14:32:03Z'),
        burstScore: 0.42,
        sharpnessScore: 210.1,
        width: 4032,
        height: 3024,
        metadata: { thumbnailStorageKey: 'thumbnails/2.jpg' },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BurstService', () => {
  let service: BurstService;
  let mockPrisma: MockPrismaService;
  let mockMembership: { assertCircleAccess: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock; getBucket: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockSystemSettings: { isFeatureEnabled: jest.Mock };
  let mockDuplicateDetectionService: { evictExistingBurstOverlaps: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockMembership = { assertCircleAccess: jest.fn().mockResolvedValue(undefined) };
    mockEnrichmentJobService = { enqueue: jest.fn() };
    // Default: duplicateDetection feature disabled, so the re-enqueue helper
    // in resolve/dismiss is a no-op unless a test explicitly enables it.
    mockSystemSettings = { isFeatureEnabled: jest.fn().mockResolvedValue(false) };
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed-url'),
      // MediaThumbnailService's legacy-fallback signing path calls
      // storageProvider.getBucket() to build its URL-cache key, so the mock
      // must implement it or that fallback throws and silently returns null.
      getBucket: jest.fn().mockReturnValue('legacy-static-bucket'),
    };
    // Resolver returns mockStorageProvider so getSignedDownloadUrl assertions are unchanged.
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };
    // Burst wins over duplicate detection: backfillAllCircles's remediation
    // step, mocked as a collaborator, never the real DuplicateDetectionService.
    mockDuplicateDetectionService = {
      evictExistingBurstOverlaps: jest.fn().mockResolvedValue({ evicted: 0 }),
    };

    // Default: $transaction executes array operations
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    // Default system settings: minGroupSize=3
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { burst: { minGroupSize: 3 } },
    });

    // Batched thumbnail signing (MediaThumbnailService.signThumbsBatched, used
    // by listBurstGroups/getBurstGroup) issues one storageObject.findMany call.
    // Default to no matching rows -> falls back to the legacy static
    // STORAGE_PROVIDER, which in this spec is the SAME mock object returned by
    // mockResolver.getProviderFor, so existing "signed-url" assertions still
    // hold without needing per-test findMany rows.
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

    // resolveBurstGroup/dismissBurstGroup write an audit event after the transaction.
    (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BurstService,
        // Real MediaThumbnailService, reusing the same PrismaService/
        // STORAGE_PROVIDER/StorageProviderResolver mocks registered below.
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: DuplicateDetectionService, useValue: mockDuplicateDetectionService },
      ],
    }).compile();

    service = module.get<BurstService>(BurstService);
  });

  // -------------------------------------------------------------------------
  // listBurstGroups
  // -------------------------------------------------------------------------

  describe('listBurstGroups', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(0);

      await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('returns { items, meta } shape', async () => {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('meta');
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.meta).toMatchObject({ total: 0, page: 1, pageSize: 20 });
    });

    it('queries only groups with mediaCount >= minGroupSize', async () => {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(0);

      await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      const findManyCall = (mockPrisma.burstGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.mediaCount).toEqual({ gte: 3 });
    });

    it('returns signed thumbnail URLs (not raw storage keys) in response', async () => {
      const group = makeBurstGroupRow();
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([group]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalled();
      expect(result.items[0].suggestedBestThumbnailUrl).toBe('https://cdn.example.com/signed-url');
    });

    it('passes through the persisted confidence value on each list item', async () => {
      const group = makeBurstGroupRow({ confidence: 0.73 });
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([group]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result.items[0].confidence).toBe(0.73);
    });

    it('passes through a null confidence (not coerced to a number)', async () => {
      const group = makeBurstGroupRow({ confidence: null });
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([group]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result.items[0].confidence).toBeNull();
    });

    it('response items do NOT contain perceptualHash field', async () => {
      const group = makeBurstGroupRow();
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([group]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      for (const item of result.items) {
        expect(item).not.toHaveProperty('perceptualHash');
      }
    });

    it('returns empty items array when no groups found', async () => {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(0);

      const result = await service.listBurstGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result.items).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getBurstGroup
  // -------------------------------------------------------------------------

  describe('getBurstGroup', () => {
    it('throws NotFoundException when group is not found', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getBurstGroup('nonexistent', USER_ID, PERMS_MEDIA_READ)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(makeDetailGroup());

      await service.getBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('sets isSuggestedBest=true only on the member matching suggestedBestItemId', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(
        makeDetailGroup({ suggestedBestItemId: 'media-1' }),
      );

      const result = await service.getBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      const best = result.data.members.find((m: any) => m.id === 'media-1');
      const nonBest = result.data.members.find((m: any) => m.id === 'media-2');
      expect(best?.isSuggestedBest).toBe(true);
      expect(nonBest?.isSuggestedBest).toBe(false);
    });

    it('members do NOT have perceptualHash field in response', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(makeDetailGroup());

      const result = await service.getBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      for (const member of result.data.members) {
        expect(member).not.toHaveProperty('perceptualHash');
      }
    });

    it('returns signed thumbnailUrl per member', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(makeDetailGroup());

      const result = await service.getBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      for (const member of result.data.members) {
        expect(member.thumbnailUrl).toBe('https://cdn.example.com/signed-url');
      }
    });
  });

  // -------------------------------------------------------------------------
  // resolveBurstGroup
  // -------------------------------------------------------------------------

  describe('resolveBurstGroup', () => {
    function setupGroup(overrides: Parameters<typeof makeBurstGroupRow>[0] = {}) {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupGroup();

      await service.resolveBurstGroup(GROUP_ID, makeResolveDto(['media-1']), USER_ID, PERMS_MEDIA_DELETE);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_DELETE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when group not found', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resolveBurstGroup(GROUP_ID, makeResolveDto(['media-1']), USER_ID, PERMS_MEDIA_DELETE),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when group is not pending', async () => {
      setupGroup({ status: BurstGroupStatus.resolved });

      await expect(
        service.resolveBurstGroup(GROUP_ID, makeResolveDto(['media-1']), USER_ID, PERMS_MEDIA_DELETE),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when keepIds contains ID not in group', async () => {
      setupGroup();

      await expect(
        service.resolveBurstGroup(
          GROUP_ID,
          makeResolveDto(['media-1', 'not-in-group-id']),
          USER_ID,
          PERMS_MEDIA_DELETE,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when action is "trash" but perms lack media:delete', async () => {
      setupGroup();

      await expect(
        service.resolveBurstGroup(
          GROUP_ID,
          makeResolveDto(['media-1'], 'trash'),
          USER_ID,
          PERMS_MEDIA_WRITE, // media:write only — no media:delete
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows action "archive" with only media:write perms (media:delete not required)', async () => {
      setupGroup();

      const result = await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      expect(result.data.action).toBe('archive');
    });

    it('trashes non-kept members (sets deletedAt) when action is "trash"', async () => {
      setupGroup();

      await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'trash'), // keep only media-1
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      // media-2 and media-3 should be soft-deleted
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { deletedAt: expect.any(Date) },
        }),
      );
    });

    it('archives non-kept members (sets archivedAt) when action is "archive"', async () => {
      setupGroup();

      await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'archive'), // keep only media-1
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      // media-2 and media-3 should be archived, not trashed
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { archivedAt: expect.any(Date) },
        }),
      );
    });

    it('marks the group as resolved with resolvedById, resolvedAt, and resolution outcome fields', async () => {
      setupGroup();

      await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'trash'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(mockPrisma.burstGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GROUP_ID },
          data: expect.objectContaining({
            status: BurstGroupStatus.resolved,
            resolvedById: USER_ID,
            resolvedAt: expect.any(Date),
            resolutionAction: 'trash',
            keptCount: 1,
            removedCount: 2,
          }),
        }),
      );
    });

    it('writes an audit event for the resolution', async () => {
      setupGroup();

      await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'trash'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'burst_group:resolved',
            targetType: 'burst_group',
            targetId: GROUP_ID,
          }),
        }),
      );
    });

    it('returns { data: { removed, kept, action, groupStatus: "resolved" } }', async () => {
      setupGroup();

      const result = await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'trash'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data).toMatchObject({
        removed: 2,
        kept: 1,
        action: 'trash',
        groupStatus: 'resolved',
      });
    });

    it('allows keeping all members (zero deletions)', async () => {
      setupGroup();

      const result = await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1', 'media-2', 'media-3']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.removed).toBe(0);
      expect(result.data.kept).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // bulkResolveBurstGroups
  // -------------------------------------------------------------------------

  describe('bulkResolveBurstGroups', () => {
    function makeBulkGroup(overrides: Partial<{
      id: string;
      circleId: string;
      status: BurstGroupStatus;
      suggestedBestItemId: string | null;
      items: Array<{ id: string }>;
    }> = {}) {
      return {
        id: 'group-1',
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        suggestedBestItemId: 'media-1',
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      };
    }

    function setupGroups(groups: ReturnType<typeof makeBulkGroup>[]) {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue(groups);
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      const group = makeBulkGroup();
      setupGroups([group]);

      await service.bulkResolveBurstGroups(
        makeBulkResolveDto([group.id]),
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

    it('happy path: resolves all pending groups keeping only suggestedBest, with correct counts', async () => {
      const groupA = makeBulkGroup({
        id: 'group-a',
        suggestedBestItemId: 'media-1',
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
      });
      const groupB = makeBulkGroup({
        id: 'group-b',
        suggestedBestItemId: 'media-10',
        items: [{ id: 'media-10' }, { id: 'media-11' }],
      });
      setupGroups([groupA, groupB]);

      const result = await service.bulkResolveBurstGroups(
        makeBulkResolveDto(['group-a', 'group-b'], 'archive'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data).toMatchObject({
        resolvedGroups: 2,
        keptCount: 2, // 1 kept per group
        removedCount: 3, // 2 removed from group-a + 1 removed from group-b
        action: 'archive',
        skipped: 0,
        errors: 0,
      });

      // group-a: keeps media-1, archives media-2 + media-3
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { archivedAt: expect.any(Date) },
        }),
      );
      // group-b: keeps media-10, archives media-11
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['media-11'] } },
          data: { archivedAt: expect.any(Date) },
        }),
      );
    });

    it('skips groups that are not pending', async () => {
      const pendingGroup = makeBulkGroup({ id: 'group-pending' });
      const resolvedGroup = makeBulkGroup({ id: 'group-resolved', status: BurstGroupStatus.resolved });
      setupGroups([pendingGroup, resolvedGroup]);

      const result = await service.bulkResolveBurstGroups(
        makeBulkResolveDto(['group-pending', 'group-resolved']),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(1);
      expect(result.data.skipped).toBe(1);
      expect(result.data.errors).toBe(0);
    });

    it('skips groups with a null suggestedBestItemId', async () => {
      const group = makeBulkGroup({ suggestedBestItemId: null });
      setupGroups([group]);

      const result = await service.bulkResolveBurstGroups(
        makeBulkResolveDto([group.id]),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(0);
      expect(result.data.skipped).toBe(1);
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('skips groups whose suggestedBestItemId is no longer a live member', async () => {
      const group = makeBulkGroup({
        suggestedBestItemId: 'media-gone',
        items: [{ id: 'media-1' }, { id: 'media-2' }],
      });
      setupGroups([group]);

      const result = await service.bulkResolveBurstGroups(
        makeBulkResolveDto([group.id]),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(0);
      expect(result.data.skipped).toBe(1);
    });

    it('throws BadRequestException when a requested id is missing (not found)', async () => {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([makeBulkGroup({ id: 'group-a' })]);

      await expect(
        service.bulkResolveBurstGroups(
          makeBulkResolveDto(['group-a', 'group-does-not-exist']),
          USER_ID,
          PERMS_MEDIA_DELETE,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when a requested id belongs to a different circle', async () => {
      const group = makeBulkGroup({ id: 'group-a', circleId: 'other-circle' });
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue([group]);

      await expect(
        service.bulkResolveBurstGroups(
          makeBulkResolveDto(['group-a']),
          USER_ID,
          PERMS_MEDIA_DELETE,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when action is "trash" but perms lack media:delete', async () => {
      const group = makeBulkGroup();
      setupGroups([group]);

      await expect(
        service.bulkResolveBurstGroups(
          makeBulkResolveDto([group.id], 'trash'),
          USER_ID,
          PERMS_MEDIA_WRITE, // no media:delete
        ),
      ).rejects.toThrow(BadRequestException);

      // Permission check should short-circuit before any group lookup/mutation
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('allows action "archive" with only media:write perms (media:delete not required)', async () => {
      const group = makeBulkGroup();
      setupGroups([group]);

      const result = await service.bulkResolveBurstGroups(
        makeBulkResolveDto([group.id], 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      expect(result.data.resolvedGroups).toBe(1);
      expect(result.data.action).toBe('archive');
    });

    it('increments errors and continues processing when one group fails mid-loop', async () => {
      const groupA = makeBulkGroup({ id: 'group-a', suggestedBestItemId: 'media-1', items: [{ id: 'media-1' }, { id: 'media-2' }] });
      const groupB = makeBulkGroup({ id: 'group-b', suggestedBestItemId: 'media-10', items: [{ id: 'media-10' }, { id: 'media-11' }] });
      const groupC = makeBulkGroup({ id: 'group-c', suggestedBestItemId: 'media-20', items: [{ id: 'media-20' }, { id: 'media-21' }] });
      setupGroups([groupA, groupB, groupC]);

      // group-a succeeds, group-b's mediaItem.updateMany rejects, group-c succeeds
      (mockPrisma.mediaItem.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 1 }) // group-a
        .mockRejectedValueOnce(new Error('db boom')) // group-b
        .mockResolvedValueOnce({ count: 1 }); // group-c

      const result = await service.bulkResolveBurstGroups(
        makeBulkResolveDto(['group-a', 'group-b', 'group-c'], 'archive'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(2);
      expect(result.data.errors).toBe(1);
      expect(result.data.skipped).toBe(0);
      // The loop must still process group-c after group-b's failure
      expect(mockPrisma.burstGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'group-c' } }),
      );
    });

    it('deduplicates repeated ids in the request before looking up groups', async () => {
      const group = makeBulkGroup();
      setupGroups([group]);

      await service.bulkResolveBurstGroups(
        makeBulkResolveDto([group.id, group.id]),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      const findManyCall = (mockPrisma.burstGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.id.in).toEqual([group.id]);
    });
  });

  // -------------------------------------------------------------------------
  // bulkResolveBurstGroupsByThreshold
  // -------------------------------------------------------------------------

  describe('bulkResolveBurstGroupsByThreshold', () => {
    function makeThresholdGroup(overrides: Partial<{
      id: string;
      circleId: string;
      status: BurstGroupStatus;
      suggestedBestItemId: string | null;
      items: Array<{ id: string }>;
    }> = {}) {
      return {
        id: 'group-1',
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        suggestedBestItemId: 'media-1',
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      };
    }

    function setupThresholdGroups(groups: ReturnType<typeof makeThresholdGroup>[], remainingCount = 0) {
      (mockPrisma.burstGroup.findMany as jest.Mock).mockResolvedValue(groups);
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
      (mockPrisma.burstGroup.count as jest.Mock).mockResolvedValue(remainingCount);
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      const group = makeThresholdGroup();
      setupThresholdGroups([group]);

      await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70),
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

    it('queries only pending groups in the circle with confidence >= threshold/100, capped at 500', async () => {
      setupThresholdGroups([]);

      await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      const findManyCall = (mockPrisma.burstGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        confidence: { gte: 0.7 },
      });
      expect(findManyCall.take).toBe(500);
    });

    it('happy path: resolves all groups returned by the query, keeping only suggestedBest', async () => {
      // The confidence >= threshold filter is applied in SQL, so by the time
      // groups reach the service every returned row is already eligible.
      const groupA = makeThresholdGroup({
        id: 'group-a',
        suggestedBestItemId: 'media-1',
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
      });
      const groupB = makeThresholdGroup({
        id: 'group-b',
        suggestedBestItemId: 'media-10',
        items: [{ id: 'media-10' }, { id: 'media-11' }],
      });
      setupThresholdGroups([groupA, groupB], 0);

      const result = await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70, 'archive'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data).toMatchObject({
        resolvedGroups: 2,
        keptCount: 2,
        removedCount: 3,
        action: 'archive',
        skipped: 0,
        errors: 0,
        remaining: 0,
      });
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { archivedAt: expect.any(Date) },
        }),
      );
      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['media-11'] } },
          data: { archivedAt: expect.any(Date) },
        }),
      );
    });

    it('action=trash sets deletedAt (not archivedAt) on non-kept members', async () => {
      const group = makeThresholdGroup();
      setupThresholdGroups([group]);

      await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70, 'trash'),
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

    it('throws BadRequestException when action is "trash" but perms lack media:delete', async () => {
      const group = makeThresholdGroup();
      setupThresholdGroups([group]);

      await expect(
        service.bulkResolveBurstGroupsByThreshold(
          makeBulkResolveThresholdDto(70, 'trash'),
          USER_ID,
          PERMS_MEDIA_WRITE, // no media:delete
        ),
      ).rejects.toThrow(BadRequestException);

      // Permission check should short-circuit before any group lookup/mutation
      expect(mockPrisma.burstGroup.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('allows action "archive" with only media:write perms (media:delete not required)', async () => {
      const group = makeThresholdGroup();
      setupThresholdGroups([group]);

      const result = await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70, 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE,
      );

      expect(result.data.resolvedGroups).toBe(1);
      expect(result.data.action).toBe('archive');
    });

    it('skips groups whose suggestedBestItemId is no longer a live member (counted in skipped)', async () => {
      const group = makeThresholdGroup({
        suggestedBestItemId: 'media-gone',
        items: [{ id: 'media-1' }, { id: 'media-2' }],
      });
      setupThresholdGroups([group]);

      const result = await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(0);
      expect(result.data.skipped).toBe(1);
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('skips groups with a null suggestedBestItemId (counted in skipped)', async () => {
      const group = makeThresholdGroup({ suggestedBestItemId: null });
      setupThresholdGroups([group]);

      const result = await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(0);
      expect(result.data.skipped).toBe(1);
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('increments errors and continues processing when one group fails mid-loop', async () => {
      const groupA = makeThresholdGroup({ id: 'group-a', suggestedBestItemId: 'media-1', items: [{ id: 'media-1' }, { id: 'media-2' }] });
      const groupB = makeThresholdGroup({ id: 'group-b', suggestedBestItemId: 'media-10', items: [{ id: 'media-10' }, { id: 'media-11' }] });
      const groupC = makeThresholdGroup({ id: 'group-c', suggestedBestItemId: 'media-20', items: [{ id: 'media-20' }, { id: 'media-21' }] });
      setupThresholdGroups([groupA, groupB, groupC]);

      (mockPrisma.mediaItem.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 1 }) // group-a
        .mockRejectedValueOnce(new Error('db boom')) // group-b
        .mockResolvedValueOnce({ count: 1 }); // group-c

      const result = await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70, 'archive'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.resolvedGroups).toBe(2);
      expect(result.data.errors).toBe(1);
      expect(result.data.skipped).toBe(0);
      expect(mockPrisma.burstGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'group-c' } }),
      );
    });

    it('returns remaining = the post-resolve count of still-pending eligible groups', async () => {
      const group = makeThresholdGroup();
      // 1200 pending+eligible groups existed; this call resolves the first 500
      // (capped by MAX_THRESHOLD_RESOLVE), leaving 700 still eligible.
      setupThresholdGroups([group], 700);

      const result = await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70, 'archive'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      expect(result.data.remaining).toBe(700);
      expect(mockPrisma.burstGroup.count).toHaveBeenCalledWith({
        where: {
          circleId: CIRCLE_ID,
          status: BurstGroupStatus.pending,
          confidence: { gte: 0.7 },
        },
      });
    });

    it('the remaining count query runs AFTER the resolve loop (reflects post-resolve state)', async () => {
      const group = makeThresholdGroup();
      setupThresholdGroups([group], 0);

      await service.bulkResolveBurstGroupsByThreshold(
        makeBulkResolveThresholdDto(70, 'archive'),
        USER_ID,
        PERMS_MEDIA_DELETE,
      );

      const findManyOrder = (mockPrisma.burstGroup.findMany as jest.Mock).mock.invocationCallOrder[0];
      const countOrder = (mockPrisma.burstGroup.count as jest.Mock).mock.invocationCallOrder[0];
      const updateManyOrder = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.invocationCallOrder[0];

      expect(findManyOrder).toBeLessThan(updateManyOrder);
      expect(updateManyOrder).toBeLessThan(countOrder);
    });
  });

  // -------------------------------------------------------------------------
  // dismissBurstGroup
  // -------------------------------------------------------------------------

  describe('dismissBurstGroup', () => {
    function setupGroupForDismiss(overrides: Partial<{
      status: BurstGroupStatus;
      items: { id: string }[];
    }> = {}) {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: BurstGroupStatus.pending,
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 3 });
      (mockPrisma.burstGroup.update as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupGroupForDismiss();

      await service.dismissBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when group not found', async () => {
      (mockPrisma.burstGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.dismissBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when group is not pending', async () => {
      setupGroupForDismiss({ status: BurstGroupStatus.dismissed });

      await expect(
        service.dismissBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE),
      ).rejects.toThrow(BadRequestException);
    });

    it('clears burstGroupId and burstScore on all members', async () => {
      setupGroupForDismiss();

      await service.dismissBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { burstGroupId: GROUP_ID },
          data: { burstGroupId: null, burstScore: null },
        }),
      );
    });

    it('marks group as dismissed with resolvedById and resolvedAt', async () => {
      setupGroupForDismiss();

      await service.dismissBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockPrisma.burstGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GROUP_ID },
          data: expect.objectContaining({
            status: BurstGroupStatus.dismissed,
            resolvedById: USER_ID,
            resolvedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('returns { data: { groupStatus: "dismissed", ungrouped } }', async () => {
      setupGroupForDismiss();

      const result = await service.dismissBurstGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(result.data).toMatchObject({
        groupStatus: 'dismissed',
        ungrouped: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // backfillAllCircles — includes the burst/duplicate overlap remediation
  // -------------------------------------------------------------------------

  describe('backfillAllCircles', () => {
    function setupCircles(circleIds: string[]) {
      (mockPrisma.circle.findMany as jest.Mock).mockResolvedValue(circleIds.map((id) => ({ id })));
      // force=false path (default opts): no succeeded jobs, no eligible items —
      // keeps the per-circle enqueue loop a no-op so these tests isolate the
      // eviction remediation step.
      (mockPrisma.enrichmentJob.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
    }

    it('result includes evictedDuplicateOverlaps matching what evictExistingBurstOverlaps returned', async () => {
      setupCircles(['circle-a', 'circle-b']);
      mockDuplicateDetectionService.evictExistingBurstOverlaps.mockResolvedValue({ evicted: 7 });

      const result = await service.backfillAllCircles({});

      expect(result).toMatchObject({ circles: 2, evictedDuplicateOverlaps: 7 });
    });

    it('calls evictExistingBurstOverlaps exactly once, app-wide (no circleId scoping)', async () => {
      setupCircles(['circle-a']);
      mockDuplicateDetectionService.evictExistingBurstOverlaps.mockResolvedValue({ evicted: 0 });

      await service.backfillAllCircles({});

      expect(mockDuplicateDetectionService.evictExistingBurstOverlaps).toHaveBeenCalledTimes(1);
      expect(mockDuplicateDetectionService.evictExistingBurstOverlaps).toHaveBeenCalledWith();
    });

    it('does not fail the backfill when evictExistingBurstOverlaps throws (best-effort)', async () => {
      setupCircles(['circle-a']);
      mockDuplicateDetectionService.evictExistingBurstOverlaps.mockRejectedValue(
        new Error('eviction boom'),
      );

      const result = await service.backfillAllCircles({});

      expect(result.evictedDuplicateOverlaps).toBe(0);
      expect(result.circles).toBe(1);
    });
  });
});

