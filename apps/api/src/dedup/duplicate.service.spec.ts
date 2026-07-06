/**
 * Unit tests for DuplicateService.
 *
 * Covers:
 *  - listDuplicateGroups: RBAC (assertCircleAccess called with viewer),
 *    response shape { items, meta }, kind filter applied after enrichment
 *  - getDuplicateGroup: RBAC (viewer), 404, isSuggestedBest/similarityToBest
 *    derived correctly
 *  - Best-copy scoring: an original with full EXIF + larger dimensions beats
 *    a stripped, smaller copy
 *  - Kind classification: exact_variant / edited / similar
 *  - resolveDuplicateGroup: RBAC (collaborator), 400 on non-pending status,
 *    400 on invalid keepIds, 400 on trash action without media:delete
 *    permission, archive path sets archivedAt, trash path sets deletedAt,
 *    audit event written
 *  - dismissDuplicateGroup: RBAC (collaborator), 400 on non-pending status,
 *    ungroups all members, audit event written
 *  - rerunDuplicateDetection: 404 on missing/deleted item, 400 on non-photo,
 *    enqueues at priority 0 with reason=rerun
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DuplicateService } from './duplicate.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaUrlSigningService } from '../media/signing/media-url-signing.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CircleRole, DuplicateGroupStatus, JobReason, JobStatus, MediaType } from '@prisma/client';
import { DuplicateQueryDto } from './dto/duplicate-query.dto';
import { ResolveDuplicateDto } from './dto/resolve-duplicate.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const CIRCLE_ID = 'circle-xyz';
const GROUP_ID = 'group-111';

const PERMS_MEDIA_READ = ['media:read'];
const PERMS_MEDIA_WRITE = ['media:write'];
const PERMS_MEDIA_WRITE_DELETE = ['media:write', 'media:delete'];

function makeQueryDto(overrides: Partial<DuplicateQueryDto> = {}): DuplicateQueryDto {
  return {
    circleId: CIRCLE_ID,
    status: 'pending',
    page: 1,
    pageSize: 20,
    ...overrides,
  } as DuplicateQueryDto;
}

function makeResolveDto(keepIds: string[], action: 'archive' | 'trash' = 'archive'): ResolveDuplicateDto {
  return { keepIds, action } as ResolveDuplicateDto;
}

function makeMember(overrides: Partial<{
  id: string;
  metadata: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  perceptualHash: string | null;
  sharpnessScore: number | null;
  capturedAt: Date | null;
  takenLat: number | null;
  takenLng: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  contentHash: string | null;
  storageObject: { size: bigint } | null;
}> = {}) {
  return {
    id: 'media-1',
    metadata: { thumbnailStorageKey: 'thumbnails/1.jpg' },
    width: 4032,
    height: 3024,
    perceptualHash: '12345',
    sharpnessScore: 200,
    capturedAt: new Date('2026-06-15T14:32:00Z'),
    takenLat: 9.9281,
    takenLng: -84.0907,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    contentHash: 'abcdef0123456789',
    storageObject: { size: 4_500_000n },
    ...overrides,
  };
}

function makeGroupRow(overrides: Partial<{
  id: string;
  circleId: string;
  status: DuplicateGroupStatus;
  mediaCount: number;
  capturedAt: Date | null;
  suggestedBestItemId: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  items: ReturnType<typeof makeMember>[];
}> = {}) {
  return {
    id: GROUP_ID,
    circleId: CIRCLE_ID,
    status: DuplicateGroupStatus.pending,
    mediaCount: 2,
    capturedAt: new Date('2026-06-15T14:32:00Z'),
    suggestedBestItemId: 'media-1',
    resolvedById: null,
    resolvedAt: null,
    items: [makeMember({ id: 'media-1' }), makeMember({ id: 'media-2' })],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuplicateService', () => {
  let service: DuplicateService;
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
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };

    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    // Default: no pairwise embedding similarity rows -> kind falls back to 'similar'
    (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    (mockPrisma.storageObject.findFirst as jest.Mock).mockResolvedValue({
      storageProvider: 's3',
      bucket: 'test-bucket',
    });
    (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuplicateService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: MediaUrlSigningService, useValue: { enabled: false } },
      ],
    }).compile();

    service = module.get<DuplicateService>(DuplicateService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // listDuplicateGroups
  // -------------------------------------------------------------------------

  describe('listDuplicateGroups', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDuplicateGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('returns { items, meta } shape', async () => {
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.listDuplicateGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('meta');
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.meta).toMatchObject({ total: 0, page: 1, pageSize: 20 });
    });

    it('queries groups filtered by circleId and status', async () => {
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);

      await service.listDuplicateGroups(makeQueryDto({ status: 'resolved' }), USER_ID, PERMS_MEDIA_READ);

      const findManyCall = (mockPrisma.duplicateGroup.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ circleId: CIRCLE_ID, status: 'resolved' });
    });

    it('returns signed cover thumbnail URLs (not raw storage keys)', async () => {
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([makeGroupRow()]);

      const result = await service.listDuplicateGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalled();
      // makeGroupRow() has 2 members by default -> 2 cover thumbnails (up to 4 max)
      expect(result.items[0].coverThumbnailUrls).toEqual([
        'https://cdn.example.com/signed-url',
        'https://cdn.example.com/signed-url',
      ]);
    });

    it('applies the kind filter AFTER computing kind classification per group', async () => {
      // Group A: exact_variant (tight similarity + tight hash distance)
      const groupA = makeGroupRow({
        id: 'group-a',
        items: [
          makeMember({ id: 'a1', perceptualHash: '0', width: 4032, height: 3024 }),
          makeMember({ id: 'a2', perceptualHash: '1', width: 4032, height: 3024 }), // Hamming distance 1
        ],
      });
      // Group B: divergent dimensions + no embedding similarity rows -> 'edited', never 'exact_variant'
      const groupB = makeGroupRow({
        id: 'group-b',
        items: [
          makeMember({ id: 'b1', perceptualHash: '12345', width: 4032, height: 3024 }),
          makeMember({ id: 'b2', perceptualHash: '12345', width: 800, height: 600 }),
        ],
      });
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([groupA, groupB]);
      // computeGroupKind issues one $queryRaw pairwise-similarity call per group, in
      // groups.map() order (groupA first, then groupB).
      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ sim: 0.995 }]) // groupA: high similarity -> exact_variant
        .mockResolvedValueOnce([]); // groupB: no embedding rows -> maxSim stays null

      const exactVariantResult = await service.listDuplicateGroups(
        makeQueryDto({ kind: 'exact_variant' }),
        USER_ID,
        PERMS_MEDIA_READ,
      );
      expect(exactVariantResult.items.map((i) => i.id)).toEqual(['group-a']);
      expect(exactVariantResult.meta.total).toBe(1);

      (mockPrisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce([{ sim: 0.995 }])
        .mockResolvedValueOnce([]);

      const editedResult = await service.listDuplicateGroups(
        makeQueryDto({ kind: 'edited' }),
        USER_ID,
        PERMS_MEDIA_READ,
      );
      expect(editedResult.items.map((i) => i.id)).toEqual(['group-b']);
      expect(editedResult.meta.total).toBe(1);
    });

    it('returns empty items array when no groups found', async () => {
      (mockPrisma.duplicateGroup.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.listDuplicateGroups(makeQueryDto(), USER_ID, PERMS_MEDIA_READ);

      expect(result.items).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getDuplicateGroup
  // -------------------------------------------------------------------------

  describe('getDuplicateGroup', () => {
    it('throws NotFoundException when group is not found', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getDuplicateGroup('nonexistent', USER_ID, PERMS_MEDIA_READ)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(makeGroupRow());

      await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_READ,
        CircleRole.viewer,
      );
    });

    it('sets isSuggestedBest=true only on the member matching the computed best-copy id', async () => {
      // media-1 has richer EXIF + larger dims + bigger file -> should win best-copy scoring
      const richer = makeMember({
        id: 'media-1',
        width: 4032,
        height: 3024,
        sharpnessScore: 300,
        storageObject: { size: 6_000_000n },
        capturedAt: new Date('2026-06-15T14:32:00Z'),
        takenLat: 9.9,
        takenLng: -84.0,
        cameraMake: 'Apple',
      });
      const stripped = makeMember({
        id: 'media-2',
        width: 1024,
        height: 768,
        sharpnessScore: 50,
        storageObject: { size: 200_000n },
        capturedAt: null,
        takenLat: null,
        takenLng: null,
        cameraMake: null,
        cameraModel: null,
      });
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({ items: [richer, stripped], suggestedBestItemId: null }),
      );

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      const best = result.data.members.find((m: any) => m.id === 'media-1');
      const notBest = result.data.members.find((m: any) => m.id === 'media-2');
      expect(best?.isSuggestedBest).toBe(true);
      expect(notBest?.isSuggestedBest).toBe(false);
    });

    it('persists the recomputed suggestedBestItemId back to the group when it changed', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({ suggestedBestItemId: 'media-2' }), // stale; media-1 will win via scoring
      );

      await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: GROUP_ID } }),
      );
    });

    it('returns signed thumbnailUrl and previewUrl per member', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(makeGroupRow());
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({ storageObjectId: 'sobj-1' });
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        storageKey: 'originals/1.jpg',
        storageProvider: 's3',
        bucket: 'test-bucket',
      });

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      for (const member of result.data.members) {
        expect(member.thumbnailUrl).toBe('https://cdn.example.com/signed-url');
        expect(member.previewUrl).toBe('https://cdn.example.com/signed-url');
      }
    });

    it('truncates contentHash to 12 characters in the response (not the full hash)', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({
          items: [
            makeMember({ id: 'media-1', contentHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdef' }),
          ],
        }),
      );

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.members[0].contentHash).toBe('abcdefabcdef');
      expect(result.data.members[0].contentHash).toHaveLength(12);
    });

    it('hasGps is true only when both takenLat and takenLng are present', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({
          items: [
            makeMember({ id: 'media-1', takenLat: 9.9, takenLng: -84.0 }),
            makeMember({ id: 'media-2', takenLat: null, takenLng: null }),
          ],
        }),
      );

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      const withGps = result.data.members.find((m: any) => m.id === 'media-1');
      const withoutGps = result.data.members.find((m: any) => m.id === 'media-2');
      expect(withGps?.hasGps).toBe(true);
      expect(withoutGps?.hasGps).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Best-copy scoring
  // -------------------------------------------------------------------------

  describe('best-copy scoring', () => {
    it('an original with full EXIF and larger dimensions beats a stripped, smaller copy', async () => {
      const original = makeMember({
        id: 'original',
        width: 4032,
        height: 3024, // large resolution
        sharpnessScore: 300,
        storageObject: { size: 6_000_000n }, // large file
        capturedAt: new Date('2026-06-15T14:32:00Z'), // has capturedAt
        takenLat: 9.9,
        takenLng: -84.0, // has GPS
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15 Pro', // has camera info -> exifRichness = 3
      });
      const strippedCopy = makeMember({
        id: 'stripped',
        width: 800,
        height: 600, // tiny resolution (WhatsApp-style downscale)
        sharpnessScore: 40,
        storageObject: { size: 80_000n }, // small file
        capturedAt: null,
        takenLat: null,
        takenLng: null,
        cameraMake: null,
        cameraModel: null, // exifRichness = 0
      });
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({ items: [original, strippedCopy], suggestedBestItemId: null }),
      );

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.suggestedBestItemId).toBe('original');
      const originalMember = result.data.members.find((m: any) => m.id === 'original')!;
      const strippedMember = result.data.members.find((m: any) => m.id === 'stripped')!;
      expect(originalMember.qualityScore as number).toBeGreaterThan(strippedMember.qualityScore as number);
    });

    it('when all members are identical, scores tie at 0.5 (normalize() fallback) and the first member wins ties', async () => {
      const identicalA = makeMember({ id: 'a', width: 1000, height: 1000, sharpnessScore: 100, storageObject: { size: 1_000_000n } });
      const identicalB = makeMember({ id: 'b', width: 1000, height: 1000, sharpnessScore: 100, storageObject: { size: 1_000_000n } });
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({ items: [identicalA, identicalB], suggestedBestItemId: null }),
      );

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(['a', 'b']).toContain(result.data.suggestedBestItemId);
      // Both scores are equal since all normalized inputs tie
      expect(result.data.members[0].qualityScore as number).toBeCloseTo(
        result.data.members[1].qualityScore as number,
        5,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Kind classification
  // -------------------------------------------------------------------------

  describe('kind classification (computeGroupKind via getDuplicateGroup)', () => {
    it("classifies as 'exact_variant' when max embedding similarity >= 0.99 and min Hamming distance <= 2", async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({
          items: [
            makeMember({ id: 'a', perceptualHash: '0', width: 4032, height: 3024 }),
            makeMember({ id: 'b', perceptualHash: '2', width: 4032, height: 3024 }), // Hamming distance 1
          ],
        }),
      );
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ sim: 0.995 }]);

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.kind).toBe('exact_variant');
    });

    it("classifies as 'edited' when linked but dimensions diverge", async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({
          items: [
            makeMember({ id: 'a', perceptualHash: '0', width: 4032, height: 3024 }),
            makeMember({ id: 'b', perceptualHash: '2', width: 1024, height: 768 }), // different dims
          ],
        }),
      );
      // Low similarity so it doesn't qualify as exact_variant, but dims diverge -> edited
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ sim: 0.97 }]);

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.kind).toBe('edited');
    });

    it("classifies as 'edited' when hash distances diverge beyond the exact-variant threshold", async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({
          items: [
            makeMember({ id: 'a', perceptualHash: '0', width: 4032, height: 3024 }),
            // Hamming distance from '0' to a value with several bits set > 2
            makeMember({ id: 'b', perceptualHash: '15', width: 4032, height: 3024 }), // 0b1111 -> distance 4
          ],
        }),
      );
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ sim: 0.97 }]);

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.kind).toBe('edited');
    });

    it("classifies as 'similar' as the fallback when neither exact_variant nor edited criteria are met", async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({
          items: [
            makeMember({ id: 'a', perceptualHash: '0', width: 4032, height: 3024 }),
            makeMember({ id: 'b', perceptualHash: '0', width: 4032, height: 3024 }), // identical hash, same dims
          ],
        }),
      );
      // No embedding rows at all -> maxSim stays null -> not exact_variant; same dims + distance 0 -> not edited
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.kind).toBe('similar');
    });

    it("classifies a single-member group as 'similar' (kind classification requires >= 2 members)", async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroupRow({ items: [makeMember({ id: 'solo' })] }),
      );

      const result = await service.getDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_READ);

      expect(result.data.kind).toBe('similar');
    });
  });

  // -------------------------------------------------------------------------
  // resolveDuplicateGroup
  // -------------------------------------------------------------------------

  describe('resolveDuplicateGroup', () => {
    function setupGroup(overrides: Parameters<typeof makeGroupRow>[0] = {}) {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: DuplicateGroupStatus.pending,
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupGroup();

      await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1']),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE_DELETE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when group not found', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.resolveDuplicateGroup(GROUP_ID, makeResolveDto(['media-1']), USER_ID, PERMS_MEDIA_WRITE_DELETE),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when group is not pending', async () => {
      setupGroup({ status: DuplicateGroupStatus.resolved } as any);

      await expect(
        service.resolveDuplicateGroup(GROUP_ID, makeResolveDto(['media-1']), USER_ID, PERMS_MEDIA_WRITE_DELETE),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when keepIds contains an ID not in the group', async () => {
      setupGroup();

      await expect(
        service.resolveDuplicateGroup(
          GROUP_ID,
          makeResolveDto(['media-1', 'not-in-group-id']),
          USER_ID,
          PERMS_MEDIA_WRITE_DELETE,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when action=trash but the caller lacks media:delete', async () => {
      setupGroup();

      await expect(
        service.resolveDuplicateGroup(
          GROUP_ID,
          makeResolveDto(['media-1'], 'trash'),
          USER_ID,
          PERMS_MEDIA_WRITE, // no media:delete
        ),
      ).rejects.toThrow(BadRequestException);

      // The permission check should short-circuit before any mutation
      expect(mockPrisma.mediaItem.updateMany).not.toHaveBeenCalled();
    });

    it('allows action=archive without media:delete permission', async () => {
      setupGroup();

      await expect(
        service.resolveDuplicateGroup(
          GROUP_ID,
          makeResolveDto(['media-1'], 'archive'),
          USER_ID,
          PERMS_MEDIA_WRITE, // no media:delete — should still be fine for archive
        ),
      ).resolves.toBeDefined();
    });

    it('action=archive sets archivedAt (not deletedAt) on non-kept members', async () => {
      setupGroup();

      await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { archivedAt: expect.any(Date) },
        }),
      );
    });

    it('action=trash sets deletedAt (not archivedAt) on non-kept members', async () => {
      setupGroup();

      await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'trash'),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: expect.arrayContaining(['media-2', 'media-3']) } },
          data: { deletedAt: expect.any(Date) },
        }),
      );
    });

    it('marks the group resolved with resolvedById and resolvedAt', async () => {
      setupGroup();

      await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GROUP_ID },
          data: expect.objectContaining({
            status: DuplicateGroupStatus.resolved,
            resolvedById: USER_ID,
            resolvedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('writes an audit event with action=duplicate_group:resolved', async () => {
      setupGroup();

      await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'trash'),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'duplicate_group:resolved',
            targetType: 'duplicate_group',
            targetId: GROUP_ID,
          }),
        }),
      );
    });

    it('returns { data: { removed, kept, action, groupStatus: "resolved" } }', async () => {
      setupGroup();

      const result = await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1'], 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(result.data).toMatchObject({
        removed: 2,
        kept: 1,
        action: 'archive',
        groupStatus: 'resolved',
      });
    });

    it('allows keeping all members (zero removals)', async () => {
      setupGroup();

      const result = await service.resolveDuplicateGroup(
        GROUP_ID,
        makeResolveDto(['media-1', 'media-2', 'media-3'], 'archive'),
        USER_ID,
        PERMS_MEDIA_WRITE_DELETE,
      );

      expect(result.data.removed).toBe(0);
      expect(result.data.kept).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // dismissDuplicateGroup
  // -------------------------------------------------------------------------

  describe('dismissDuplicateGroup', () => {
    function setupGroupForDismiss(overrides: Partial<{
      status: DuplicateGroupStatus;
      items: { id: string }[];
    }> = {}) {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue({
        id: GROUP_ID,
        circleId: CIRCLE_ID,
        status: DuplicateGroupStatus.pending,
        items: [{ id: 'media-1' }, { id: 'media-2' }, { id: 'media-3' }],
        ...overrides,
      });
      (mockPrisma.mediaItem.updateMany as jest.Mock).mockResolvedValue({ count: 3 });
      (mockPrisma.duplicateGroup.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupGroupForDismiss();

      await service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE,
        CircleRole.collaborator,
      );
    });

    it('throws NotFoundException when group not found', async () => {
      (mockPrisma.duplicateGroup.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when group is not pending', async () => {
      setupGroupForDismiss({ status: DuplicateGroupStatus.dismissed });

      await expect(service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('ungroups all members by clearing duplicateGroupId', async () => {
      setupGroupForDismiss();

      await service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { duplicateGroupId: GROUP_ID },
          data: { duplicateGroupId: null },
        }),
      );
    });

    it('marks the group dismissed with resolvedById and resolvedAt', async () => {
      setupGroupForDismiss();

      await service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockPrisma.duplicateGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GROUP_ID },
          data: expect.objectContaining({
            status: DuplicateGroupStatus.dismissed,
            resolvedById: USER_ID,
            resolvedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('writes an audit event with action=duplicate_group:dismissed', async () => {
      setupGroupForDismiss();

      await service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'duplicate_group:dismissed',
            targetType: 'duplicate_group',
            targetId: GROUP_ID,
          }),
        }),
      );
    });

    it('returns { data: { groupStatus: "dismissed", ungrouped } }', async () => {
      setupGroupForDismiss();

      const result = await service.dismissDuplicateGroup(GROUP_ID, USER_ID, PERMS_MEDIA_WRITE);

      expect(result.data).toMatchObject({
        groupStatus: 'dismissed',
        ungrouped: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // rerunDuplicateDetection
  // -------------------------------------------------------------------------

  describe('rerunDuplicateDetection', () => {
    it('calls assertCircleAccess with the item circleId and collaborator role', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'media-1',
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.photo,
      });
      mockEnrichmentJobService.enqueue.mockResolvedValue({
        id: 'job-rerun-1',
        status: JobStatus.pending,
      });

      await service.rerunDuplicateDetection('media-1', USER_ID, PERMS_MEDIA_WRITE);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS_MEDIA_WRITE,
        CircleRole.collaborator,
      );
    });

    it('propagates a rejection from assertCircleAccess without enqueueing a job', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'media-1',
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.photo,
      });
      mockMembership.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('not a circle member'));

      await expect(service.rerunDuplicateDetection('media-1', USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.rerunDuplicateDetection('media-x', USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'media-1',
        circleId: CIRCLE_ID,
        deletedAt: new Date(),
        type: MediaType.photo,
      });

      await expect(service.rerunDuplicateDetection('media-1', USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the mediaItem is not a photo', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'media-1',
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.video,
      });

      await expect(service.rerunDuplicateDetection('media-1', USER_ID, PERMS_MEDIA_WRITE)).rejects.toThrow(BadRequestException);
    });

    it('enqueues a duplicate_detection job at priority 0 with reason=rerun', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: 'media-1',
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.photo,
      });
      mockEnrichmentJobService.enqueue.mockResolvedValue({
        id: 'job-rerun-1',
        status: JobStatus.pending,
      });

      const result = await service.rerunDuplicateDetection('media-1', USER_ID, PERMS_MEDIA_WRITE);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'duplicate_detection',
          mediaItemId: 'media-1',
          circleId: CIRCLE_ID,
          reason: JobReason.rerun,
          priority: 0,
        }),
      );
      expect(result).toEqual({ data: { jobId: 'job-rerun-1', status: JobStatus.pending } });
    });
  });
});
