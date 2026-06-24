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
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { BurstGroupStatus, CircleRole, MediaType } from '@prisma/client';
import { BurstQueryDto } from './dto/burst-query.dto';
import { ResolveBurstDto } from './dto/resolve-burst.dto';

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

function makeResolveDto(keepIds: string[]): ResolveBurstDto {
  return { keepIds } as ResolveBurstDto;
}

function makeBurstGroupRow(overrides: Partial<{
  id: string;
  circleId: string;
  status: BurstGroupStatus;
  mediaCount: number;
  capturedAt: Date | null;
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
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockMembership = { assertCircleAccess: jest.fn().mockResolvedValue(undefined) };
    mockEnrichmentJobService = { enqueue: jest.fn() };
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed-url'),
    };
    // Resolver returns mockStorageProvider so getSignedDownloadUrl assertions are unchanged.
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };

    // Default: $transaction executes array operations
    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    // Default system settings: minGroupSize=3
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: { burst: { minGroupSize: 3 } },
    });

    // Default storageObject.findFirst for signThumb: return a row so resolver is used.
    (mockPrisma.storageObject.findFirst as jest.Mock).mockResolvedValue({
      storageProvider: 's3',
      bucket: 'test-bucket',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BurstService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
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

    it('soft-deletes non-kept members (sets deletedAt)', async () => {
      setupGroup();

      await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1']), // keep only media-1
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

    it('marks the group as resolved with resolvedById and resolvedAt', async () => {
      setupGroup();

      await service.resolveBurstGroup(
        GROUP_ID,
        makeResolveDto(['media-1']),
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
          }),
        }),
      );
    });

    it('returns { data: { deleted, kept, groupStatus: "resolved" } }', async () => {
      setupGroup();

      const result = await service.resolveBurstGroup(
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

      const result = await service.resolveBurstGroup(
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

});

