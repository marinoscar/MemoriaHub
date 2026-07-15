import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { MediaService } from '../../src/media/media.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../mocks/prisma.mock';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { MediaMetadataSyncService } from '../../src/media/sync/media-metadata-sync.service';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import { CircleMembershipService } from '../../src/circles/circle-membership.service';
import { GEO_LOCATION_PROVIDER } from '../../src/media/geo/geo-location-provider.interface';
import { ForwardGeocodeService } from '../../src/media/geo/forward-geocode.service';
import { StorageProviderResolver } from '../../src/storage/providers/storage-provider.resolver';
import { MediaEnrichmentService } from '../../src/media/enrichment/media-enrichment.service';
import { MediaThumbnailService } from '../../src/media/media-thumbnail.service';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const CIRCLE_A = 'circle-a-0000-0000-0000-000000000001';
const CIRCLE_B = 'circle-b-0000-0000-0000-000000000002';
const USER_A = 'user-a-0000-0000-0000-000000000001';
const USER_B = 'user-b-0000-0000-0000-000000000002';

function makeStorageObject(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    name: 'photo.jpg',
    size: BigInt(1024000),
    mimeType: 'image/jpeg',
    storageKey: 'uploads/photo.jpg',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: USER_A,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    storageObjectId: randomUUID(),
    addedById: USER_A,
    circleId: CIRCLE_A,
    type: 'photo' as const,
    source: 'web' as const,
    originalFilename: 'photo.jpg',
    capturedAt: null,
    capturedAtOffset: null,
    importedAt: new Date(),
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    cameraMake: null,
    cameraModel: null,
    contentHash: null,
    description: null,
    favorite: false,
    deletedAt: null,
    originalCreatedAt: null,
    sourcePath: null,
    sourceDeviceId: null,
    sourceDeviceName: null,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    geoCountry: null,
    geoCountryCode: null,
    geoAdmin1: null,
    geoAdmin2: null,
    geoLocality: null,
    geoPlaceName: null,
    geoSource: null,
    geocodedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAlbum(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    addedById: USER_A,
    circleId: CIRCLE_A,
    name: 'My Album',
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTag(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    addedById: USER_A,
    circleId: CIRCLE_A,
    name: 'nature',
    createdAt: new Date(),
    ...overrides,
  };
}

const ownPerms = [PERMISSIONS.MEDIA_READ, PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_DELETE];
const superAdminPerms = [...ownPerms, PERMISSIONS.MEDIA_READ_ANY, PERMISSIONS.MEDIA_WRITE_ANY, PERMISSIONS.MEDIA_DELETE_ANY];
const noPerms: string[] = [];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Circle Authorization Matrix (MediaService unit)', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: {
    getSignedDownloadUrl: jest.Mock;
    delete: jest.Mock;
    getBucket: jest.Mock;
  };
  let mockSyncService: jest.Mocked<Pick<MediaMetadataSyncService, 'syncFromStorageObject'>>;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
      delete: jest.fn().mockResolvedValue(undefined),
      // MediaThumbnailService's legacy-fallback signing path calls
      // storageProvider.getBucket() to build its URL-cache key.
      getBucket: jest.fn().mockReturnValue('legacy-static-bucket'),
    };
    // Batched thumbnail signing (MediaThumbnailService.signThumbsBatched) issues
    // one storageObject.findMany call for list surfaces. Default to no
    // matching rows -> falls back to the legacy static provider.
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
    mockSyncService = {
      syncFromStorageObject: jest.fn().mockResolvedValue(undefined),
    };
    // Default: collaborator member, not super-admin
    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator' as CircleRole, isSuperAdmin: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        // Real MediaThumbnailService, reusing the same PrismaService/
        // STORAGE_PROVIDER/StorageProviderResolver mocks registered below.
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: MediaMetadataSyncService, useValue: mockSyncService },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: GEO_LOCATION_PROVIDER, useValue: { reverseGeocode: jest.fn() } },
        { provide: ForwardGeocodeService, useValue: { searchPlaces: jest.fn() } },
        {
          provide: StorageProviderResolver,
          useValue: {
            getProviderFor: jest.fn().mockResolvedValue({
              getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/download'),
            }),
          },
        },
        { provide: MediaEnrichmentService, useValue: { enqueueUploadEnrichment: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Cross-member visibility — shared library
  // =========================================================================

  describe('Cross-member visibility (shared circle library)', () => {
    it('member B can see a MediaItem added by member A in the same circle (getMedia resolves)', async () => {
      // The item was created by USER_A but USER_B is also a member → access granted
      const item = makeMediaItem({ addedById: USER_A, circleId: CIRCLE_A });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: item.storageObjectId }) as any,
      );
      // assertCircleAccess resolves → USER_B is a viewer/member
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: 'viewer' as CircleRole,
        isSuperAdmin: false,
      });

      const result = await service.getMedia(item.id, USER_B, ownPerms);

      expect(result).toMatchObject({ id: item.id });
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_B,
        CIRCLE_A,
        ownPerms,
        'viewer',
      );
    });

    it('non-member gets ForbiddenException when trying to read a circle item', async () => {
      const item = makeMediaItem({ addedById: USER_A, circleId: CIRCLE_A });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      // assertCircleAccess throws → non-member
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('You are not a member of this circle'),
      );

      await expect(service.getMedia(item.id, 'non-member-user', noPerms)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // =========================================================================
  // Viewer CANNOT write
  // =========================================================================

  describe('Viewer cannot perform write operations', () => {
    it('createMedia throws ForbiddenException for viewer (collaborator role required)', async () => {
      const storageObject = makeStorageObject({ uploadedById: USER_A });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      // assertCircleAccess throws because viewer < collaborator
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('This action requires collaborator role or higher'),
      );

      await expect(
        service.createMedia(
          { storageObjectId: storageObject.id, type: 'photo', source: 'web', originalFilename: 'p.jpg', circleId: CIRCLE_A },
          USER_A,
          ownPerms,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('updateMedia throws ForbiddenException for viewer', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('This action requires collaborator role or higher'),
      );

      await expect(
        service.updateMedia(item.id, { description: 'new description' }, USER_A, ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deleteMedia throws ForbiddenException for viewer', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('This action requires collaborator role or higher'),
      );

      await expect(
        service.deleteMedia(item.id, USER_A, ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // =========================================================================
  // Collaborator CAN write
  // =========================================================================

  describe('Collaborator can perform write operations', () => {
    beforeEach(() => {
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: 'collaborator' as CircleRole,
        isSuperAdmin: false,
      });
    });

    it('createMedia succeeds for collaborator', async () => {
      const storageObject = makeStorageObject({ uploadedById: USER_A });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      const result = await service.createMedia(
        { storageObjectId: storageObject.id, type: 'photo', source: 'web', originalFilename: 'p.jpg', circleId: CIRCLE_A },
        USER_A,
        ownPerms,
      );

      expect(result.id).toBe(createdItem.id);
      expect(result.deduplicated).toBe(false);
    });

    it('updateMedia succeeds for collaborator', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      const updated = { ...item, description: 'New Description' };
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(item.id, { description: 'New Description' }, USER_A, ownPerms);
      expect(result.description).toBe('New Description');
    });

    it('deleteMedia succeeds for collaborator', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({ ...item, deletedAt: new Date() } as any);

      await expect(service.deleteMedia(item.id, USER_A, ownPerms)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Circle admin CAN do everything a collaborator can
  // =========================================================================

  describe('Circle admin has at least collaborator-level access', () => {
    beforeEach(() => {
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: 'circle_admin' as CircleRole,
        isSuperAdmin: false,
      });
    });

    it('createMedia succeeds for circle_admin', async () => {
      const storageObject = makeStorageObject({ uploadedById: USER_A });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      const result = await service.createMedia(
        { storageObjectId: storageObject.id, type: 'photo', source: 'web', originalFilename: 'p.jpg', circleId: CIRCLE_A },
        USER_A,
        ownPerms,
      );

      expect(result.id).toBe(createdItem.id);
    });

    it('deleteMedia succeeds for circle_admin', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({ ...item, deletedAt: new Date() } as any);

      await expect(service.deleteMedia(item.id, USER_A, ownPerms)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Cross-circle isolation: circle_admin of circle X cannot act on circle Y
  // =========================================================================

  describe('Cross-circle isolation', () => {
    it('circle_admin of circle A cannot read media from circle B', async () => {
      const itemInB = makeMediaItem({ circleId: CIRCLE_B, addedById: USER_B });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(itemInB as any);
      // assertCircleAccess is called with CIRCLE_B and throws for USER_A
      mockCircleMembershipService.assertCircleAccess.mockImplementation(
        async (userId, circleId) => {
          if (circleId === CIRCLE_B) {
            throw new ForbiddenException('You are not a member of this circle');
          }
          return { role: 'circle_admin' as CircleRole, isSuperAdmin: false };
        },
      );

      await expect(service.getMedia(itemInB.id, USER_A, ownPerms)).rejects.toThrow(ForbiddenException);
    });

    it('circle_admin of circle A cannot delete media from circle B', async () => {
      const itemInB = makeMediaItem({ circleId: CIRCLE_B, addedById: USER_B });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(itemInB as any);
      mockCircleMembershipService.assertCircleAccess.mockImplementation(
        async (userId, circleId) => {
          if (circleId === CIRCLE_B) {
            throw new ForbiddenException('You are not a member of this circle');
          }
          return { role: 'circle_admin' as CircleRole, isSuperAdmin: false };
        },
      );

      await expect(service.deleteMedia(itemInB.id, USER_A, ownPerms)).rejects.toThrow(ForbiddenException);
    });
  });

  // =========================================================================
  // Super-admin can access any circle
  // =========================================================================

  describe('Super-admin (global media:read_any / write_any) bypasses circle membership', () => {
    beforeEach(() => {
      mockCircleMembershipService.assertCircleAccess.mockResolvedValue({
        role: 'circle_admin' as CircleRole,
        isSuperAdmin: true,
      });
    });

    it('super-admin can read media from any circle', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_B, addedById: USER_B });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: item.storageObjectId }) as any,
      );

      const result = await service.getMedia(item.id, USER_A, superAdminPerms);
      expect(result.id).toBe(item.id);
      // assertCircleAccess should have been called (service still delegates, mock returns super-admin result)
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_A,
        CIRCLE_B,
        superAdminPerms,
        'viewer',
      );
    });

    it('super-admin can delete media from any circle', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_B, addedById: USER_B });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({ ...item, deletedAt: new Date() } as any);

      await expect(service.deleteMedia(item.id, USER_A, superAdminPerms)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // addAlbumItems — cross-circle item rejection
  // =========================================================================

  describe('addAlbumItems rejects items from a different circle', () => {
    it('throws NotFoundException when requested media items belong to a different circle than the album', async () => {
      const album = makeAlbum({ circleId: CIRCLE_A });
      const mediaItemIdFromCircleB = randomUUID();

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      // findMany filters by circleId: album.circleId — items from CIRCLE_B won't match
      mockPrisma.mediaItem.findMany.mockResolvedValue([]); // 0 found, 1 requested

      await expect(
        service.addAlbumItems(
          album.id,
          { mediaItemIds: [mediaItemIdFromCircleB] },
          USER_A,
          ownPerms,
        ),
      ).rejects.toThrow(NotFoundException);

      // Confirm the service queried with the album's circleId, not the item's circle
      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: CIRCLE_A,
          }),
        }),
      );
    });

    it('succeeds when all media items belong to the same circle as the album', async () => {
      const album = makeAlbum({ circleId: CIRCLE_A });
      const item1 = makeMediaItem({ circleId: CIRCLE_A });
      const item2 = makeMediaItem({ circleId: CIRCLE_A });
      const albumItem1 = { id: randomUUID(), albumId: album.id, mediaItemId: item1.id, addedAt: new Date() };
      const albumItem2 = { id: randomUUID(), albumId: album.id, mediaItemId: item2.id, addedAt: new Date() };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([item1, item2] as any);
      mockPrisma.albumItem.upsert
        .mockResolvedValueOnce(albumItem1 as any)
        .mockResolvedValueOnce(albumItem2 as any);

      const result = await service.addAlbumItems(
        album.id,
        { mediaItemIds: [item1.id, item2.id] },
        USER_A,
        ownPerms,
      );

      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // attachTags — per-circle tag uniqueness
  // =========================================================================

  describe('attachTags uses per-circle unique key (circleId, name)', () => {
    it('upserts tag using { circleId_name: { circleId, name } } compound key', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      const tag = makeTag({ circleId: CIRCLE_A, name: 'holiday' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({
        tagId: tag.id,
        mediaItemId: item.id,
      } as any);

      await service.attachTags(item.id, { names: ['holiday'] }, USER_A, ownPerms);

      expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            circleId_name: { circleId: CIRCLE_A, name: 'holiday' },
          },
        }),
      );
    });

    it('creates tag with circleId scoped to the media item circle', async () => {
      const item = makeMediaItem({ circleId: CIRCLE_A });
      const tag = makeTag({ circleId: CIRCLE_A, name: 'summer' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({
        tagId: tag.id,
        mediaItemId: item.id,
      } as any);

      await service.attachTags(item.id, { names: ['summer'] }, USER_A, ownPerms);

      expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            circleId: CIRCLE_A,
            name: 'summer',
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Dedup: per-circle content hash uniqueness
  // =========================================================================

  describe('createMedia deduplication is per-circle', () => {
    const TEST_HASH = 'a'.repeat(64);

    it('does NOT dedup when same hash exists only in a different circle (creates new item)', async () => {
      const storageObject = makeStorageObject({ uploadedById: USER_A });
      // findFirst with { circleId: CIRCLE_A, contentHash: ... } returns null
      // (the other circle has the same hash but this circle does not)
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id, contentHash: TEST_HASH, circleId: CIRCLE_A });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null); // not already linked
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null); // no match in THIS circle
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      const result = await service.createMedia(
        { storageObjectId: storageObject.id, type: 'photo', source: 'web', originalFilename: 'p.jpg', circleId: CIRCLE_A, contentHash: TEST_HASH },
        USER_A,
        ownPerms,
      );

      expect(result.deduplicated).toBe(false);
      expect(mockPrisma.mediaItem.create).toHaveBeenCalledTimes(1);
      // The dedup query must be scoped to CIRCLE_A
      expect(mockPrisma.mediaItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: CIRCLE_A,
            contentHash: TEST_HASH,
          }),
        }),
      );
    });

    it('returns existing item (deduplicated: true) when same hash exists in the same circle', async () => {
      const storageObject = makeStorageObject({ uploadedById: USER_A, storageKey: 'uploads/new.jpg' });
      const existingItem = makeMediaItem({ addedById: USER_A, contentHash: TEST_HASH, circleId: CIRCLE_A });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null); // not already linked
      mockPrisma.mediaItem.findFirst.mockResolvedValue(existingItem as any); // dedup hit in CIRCLE_A

      const result = await service.createMedia(
        { storageObjectId: storageObject.id, type: 'photo', source: 'web', originalFilename: 'p.jpg', circleId: CIRCLE_A, contentHash: TEST_HASH },
        USER_A,
        ownPerms,
      );

      expect(result.deduplicated).toBe(true);
      expect(result.id).toBe(existingItem.id);
      // Redundant storage object blob cleanup attempted
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(storageObject.storageKey);
    });
  });
});
