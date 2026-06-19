import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { randomUUID } from 'crypto';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { GEO_LOCATION_PROVIDER } from './geo/geo-location-provider.interface';
import { ForwardGeocodeService } from './geo/forward-geocode.service';

// ---------------------------------------------------------------------------
// Helper: build a Prisma P2002 error the way Prisma actually throws it
// ---------------------------------------------------------------------------
function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    { code: 'P2002', clientVersion: '0.0.0', meta: { target: ['owner_id', 'content_hash'] } },
  );
}

// A valid 64-char lowercase hex SHA-256 string for use in tests
const TEST_HASH = 'a'.repeat(64);

const CIRCLE_ID = 'circle-uuid-0001-0002-0003';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

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
    uploadedById: 'user-1',
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
    addedById: 'user-1',
    circleId: CIRCLE_ID,
    type: 'photo' as const,
    source: 'web' as const,
    originalFilename: 'photo.jpg',
    capturedAt: null,
    capturedAtOffset: null,
    importedAt: new Date(),
    classification: 'unreviewed' as const,
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    cameraMake: null,
    cameraModel: null,
    contentHash: null,
    title: null,
    caption: null,
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
    addedById: 'user-1',
    circleId: CIRCLE_ID,
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
    addedById: 'user-1',
    circleId: CIRCLE_ID,
    name: 'nature',
    createdAt: new Date(),
    ...overrides,
  };
}

// Default paginated query params
// Cast to any to avoid strict DTO type checking in unit tests
// (the DTO has a `favorite` field with transform that TypeScript marks as required)
const defaultMediaQuery = {
  circleId: CIRCLE_ID,
  page: 1,
  pageSize: 20,
  sortBy: 'capturedAt' as const,
  sortOrder: 'desc' as const,
} as any;

const defaultAlbumQuery = {
  circleId: CIRCLE_ID,
  page: 1,
  pageSize: 20,
  sortBy: 'createdAt' as const,
  sortOrder: 'desc' as const,
} as any;

// Permissions helpers
const ownPerms = [
  PERMISSIONS.MEDIA_READ,
  PERMISSIONS.MEDIA_WRITE,
  PERMISSIONS.MEDIA_DELETE,
];
const anyPerms = [
  ...ownPerms,
  PERMISSIONS.MEDIA_READ_ANY,
  PERMISSIONS.MEDIA_WRITE_ANY,
  PERMISSIONS.MEDIA_DELETE_ANY,
];
const noPerms: string[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaService', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock; delete: jest.Mock };
  let mockSyncService: jest.Mocked<Pick<MediaMetadataSyncService, 'syncFromStorageObject'>>;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockGeoProvider: { reverseGeocode: jest.Mock };
  let mockForwardGeocodeService: { searchPlaces: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    // Configure $transaction to execute the callback with mockPrisma as the tx
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(mockPrisma);
      } else if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg;
    });
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    mockSyncService = {
      syncFromStorageObject: jest.fn().mockResolvedValue(undefined),
    };
    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    mockGeoProvider = { reverseGeocode: jest.fn().mockResolvedValue(null) };
    mockForwardGeocodeService = { searchPlaces: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: MediaMetadataSyncService, useValue: mockSyncService },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: GEO_LOCATION_PROVIDER, useValue: mockGeoProvider },
        { provide: ForwardGeocodeService, useValue: mockForwardGeocodeService },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // createMedia
  // -------------------------------------------------------------------------

  describe('createMedia', () => {
    it('should create a MediaItem when the StorageObject is owned by the caller', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      const dto = {
        storageObjectId: storageObject.id,
        type: 'photo' as const,
        source: 'web' as const,
        originalFilename: 'photo.jpg',
        circleId: CIRCLE_ID,
      };

      const result = await service.createMedia(dto, 'user-1', ownPerms);

      // Fresh create: result is the created item spread with deduplicated: false
      expect(result).toMatchObject({ ...createdItem, deduplicated: false });
      expect(result.deduplicated).toBe(false);
      expect(mockPrisma.storageObject.findUnique).toHaveBeenCalledWith({
        where: { id: dto.storageObjectId },
      });
      expect(mockPrisma.mediaItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageObjectId: dto.storageObjectId,
            addedById: 'user-1',
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
          }),
        }),
      );
    });

    it('should throw NotFoundException when StorageObject does not exist', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.createMedia(
          {
            storageObjectId: randomUUID(),
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
            circleId: CIRCLE_ID,
          },
          'user-1',
          ownPerms,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when StorageObject is not owned by caller', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'other-user' });
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.createMedia(
          {
            storageObjectId: storageObject.id,
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
            circleId: CIRCLE_ID,
          },
          'user-1',
          ownPerms,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when StorageObject is already linked to a MediaItem', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const existingItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(existingItem as any);

      await expect(
        service.createMedia(
          {
            storageObjectId: storageObject.id,
            type: 'photo',
            source: 'web',
            originalFilename: 'photo.jpg',
            circleId: CIRCLE_ID,
          },
          'user-1',
          ownPerms,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should call syncFromStorageObject with the created item storageObjectId (best-effort enrichment)', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      await service.createMedia(
        {
          storageObjectId: storageObject.id,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
          circleId: CIRCLE_ID,
        },
        'user-1',
        ownPerms,
      );

      expect(mockSyncService.syncFromStorageObject).toHaveBeenCalledTimes(1);
      expect(mockSyncService.syncFromStorageObject).toHaveBeenCalledWith(createdItem.storageObjectId);
    });

    it('should still resolve with the created MediaItem when syncFromStorageObject rejects (error swallowed)', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);
      mockSyncService.syncFromStorageObject.mockRejectedValue(new Error('sync failure'));

      const result = await service.createMedia(
        {
          storageObjectId: storageObject.id,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
          circleId: CIRCLE_ID,
        },
        'user-1',
        ownPerms,
      );

      // createMedia must resolve despite sync failure
      expect(result).toMatchObject(createdItem);
      expect(result.deduplicated).toBe(false);
    });

    it('stores contentHash on the created item when provided in the DTO', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id, contentHash: TEST_HASH });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      // findUnique for "already linked" check → null
      // findFirst for dedup pre-check → null (no existing item with this hash)
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

      await service.createMedia(
        {
          storageObjectId: storageObject.id,
          type: 'photo',
          source: 'web',
          originalFilename: 'photo.jpg',
          contentHash: TEST_HASH,
          circleId: CIRCLE_ID,
        },
        'user-1',
        ownPerms,
      );

      expect(mockPrisma.mediaItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contentHash: TEST_HASH }),
        }),
      );
    });

    it('returns the existing item (deduplicated: true) when pre-check finds a hash match', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1', storageKey: 'uploads/new.jpg' });
      const existingItem = makeMediaItem({ addedById: 'user-1', contentHash: TEST_HASH });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      // "already linked" check on storageObjectId → no match
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      // Dedup pre-check by (circleId, contentHash) → existing item found
      mockPrisma.mediaItem.findFirst.mockResolvedValue(existingItem as any);

      const result = await service.createMedia(
        {
          storageObjectId: storageObject.id,
          type: 'photo',
          source: 'web',
          originalFilename: 'dup.jpg',
          contentHash: TEST_HASH,
          circleId: CIRCLE_ID,
        },
        'user-1',
        ownPerms,
      );

      expect(result.deduplicated).toBe(true);
      expect(result.id).toBe(existingItem.id);
      // A new MediaItem must NOT have been created
      expect(mockPrisma.mediaItem.create).not.toHaveBeenCalled();
      // Redundant blob should be cleaned up (best-effort)
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(storageObject.storageKey);
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: storageObject.id },
      });
    });

    it('returns the existing item (deduplicated: true) when P2002 fires on concurrent create', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1', storageKey: 'uploads/new2.jpg' });
      const winnerItem = makeMediaItem({ addedById: 'user-1', contentHash: TEST_HASH });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      // "already linked" check → no match
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      // Dedup pre-check → not found (concurrent race)
      mockPrisma.mediaItem.findFirst
        .mockResolvedValueOnce(null)       // pre-check: not found yet
        .mockResolvedValueOnce(winnerItem as any); // post-P2002 re-query: winner found
      // create throws P2002
      mockPrisma.mediaItem.create.mockRejectedValue(makeP2002Error());

      const result = await service.createMedia(
        {
          storageObjectId: storageObject.id,
          type: 'photo',
          source: 'web',
          originalFilename: 'race.jpg',
          contentHash: TEST_HASH,
          circleId: CIRCLE_ID,
        },
        'user-1',
        ownPerms,
      );

      expect(result.deduplicated).toBe(true);
      expect(result.id).toBe(winnerItem.id);
      // Redundant blob should be cleaned up
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(storageObject.storageKey);
    });

    it('rethrows P2002 when post-race re-query finds nothing (winner was hard-deleted)', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      // pre-check → not found, post-P2002 re-query → still not found
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);
      mockPrisma.mediaItem.create.mockRejectedValue(makeP2002Error());

      await expect(
        service.createMedia(
          {
            storageObjectId: storageObject.id,
            type: 'photo',
            source: 'web',
            originalFilename: 'ghost.jpg',
            contentHash: TEST_HASH,
            circleId: CIRCLE_ID,
          },
          'user-1',
          ownPerms,
        ),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('cleanup failures do NOT prevent the dedup hit from being returned', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1', storageKey: 'uploads/err.jpg' });
      const existingItem = makeMediaItem({ addedById: 'user-1', contentHash: TEST_HASH });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(existingItem as any);
      // Both cleanup steps fail
      mockStorageProvider.delete.mockRejectedValue(new Error('blob delete failed'));
      mockPrisma.storageObject.delete.mockRejectedValue(new Error('db delete failed'));

      const result = await service.createMedia(
        {
          storageObjectId: storageObject.id,
          type: 'photo',
          source: 'web',
          originalFilename: 'dup.jpg',
          contentHash: TEST_HASH,
          circleId: CIRCLE_ID,
        },
        'user-1',
        ownPerms,
      );

      // Despite both cleanup failures, the dedup result is still returned
      expect(result.deduplicated).toBe(true);
      expect(result.id).toBe(existingItem.id);
    });
  });

  // -------------------------------------------------------------------------
  // listMedia — where-clause assertions
  // -------------------------------------------------------------------------

  describe('listMedia', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);
    });

    it('always includes deletedAt: null in the where clause', async () => {
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', ownPerms);

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({ deletedAt: null });
    });

    it('filters by circleId from query', async () => {
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', ownPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ circleId: CIRCLE_ID });
    });

    it('always filters by circleId from query regardless of permissions', async () => {
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', anyPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ circleId: CIRCLE_ID });
    });

    it('filters by type when provided', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, type: 'photo' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ type: 'photo' });
    });

    it('filters by capturedAt date range', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');

      await service.listMedia(
        { ...defaultMediaQuery, capturedAtFrom: from, capturedAtTo: to },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.capturedAt).toMatchObject({ gte: from, lte: to });
    });

    it('filters by classification', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, classification: 'memory' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ classification: 'memory' });
    });

    it('filters by albumId via AlbumItem join', async () => {
      const albumId = randomUUID();

      await service.listMedia(
        { ...defaultMediaQuery, albumId },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.albumItems).toMatchObject({ some: { albumId } });
    });

    it('filters by favorite', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, favorite: true },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ favorite: true });
    });

    it('filters by tag name via MediaTag join (case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, tag: 'nature' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.mediaTags).toMatchObject({
        some: {
          tag: { name: { equals: 'nature', mode: 'insensitive' } },
        },
      });
    });

    it('filters by country — OR across geoCountry (contains) and geoCountryCode (exact)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, country: 'CR' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'CR', mode: 'insensitive' } },
          { geoCountryCode: { equals: 'CR', mode: 'insensitive' } },
        ]),
      );
    });

    it('filters by region (geoAdmin1 contains, case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, region: 'California' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoAdmin1: { contains: 'California', mode: 'insensitive' },
      });
    });

    it('filters by locality (geoLocality contains, case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, locality: 'San Jose' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoLocality: { contains: 'San Jose', mode: 'insensitive' },
      });
    });

    it('filters by place (geoPlaceName contains, case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, place: 'Yosemite' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoPlaceName: { contains: 'Yosemite', mode: 'insensitive' },
      });
    });

    it('free-text location filter spans all geo tiers via OR', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, location: 'California' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'California', mode: 'insensitive' } },
          { geoCountryCode: { contains: 'California', mode: 'insensitive' } },
          { geoAdmin1: { contains: 'California', mode: 'insensitive' } },
          { geoLocality: { contains: 'California', mode: 'insensitive' } },
          { geoPlaceName: { contains: 'California', mode: 'insensitive' } },
        ]),
      );
    });

    it('returns correct pagination meta', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(45);

      const result = await service.listMedia(
        { ...defaultMediaQuery, page: 2, pageSize: 10 },
        'user-1',
        ownPerms,
      );

      expect(result.meta).toEqual({
        page: 2,
        pageSize: 10,
        totalItems: 45,
        totalPages: 5,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getMedia
  // -------------------------------------------------------------------------

  describe('getMedia', () => {
    it('should return a MediaItem for the owner', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: item.storageObjectId, uploadedById: 'user-1' }) as any,
      );

      const result = await service.getMedia(item.id, 'user-1', ownPerms);

      expect(result).toMatchObject({ id: item.id, addedById: 'user-1' });
    });

    it('should throw NotFoundException if item does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.getMedia(randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for soft-deleted items', async () => {
      const item = makeMediaItem({ deletedAt: new Date() });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);

      await expect(
        service.getMedia(item.id, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when non-owner without _any permission accesses', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.getMedia(item.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:read_any to access another user\'s item', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: item.storageObjectId, uploadedById: 'other-user' }) as any,
      );

      const result = await service.getMedia(item.id, 'user-1', anyPerms);

      expect(result).toMatchObject({ id: item.id, addedById: 'other-user' });
    });
  });

  // -------------------------------------------------------------------------
  // updateMedia
  // -------------------------------------------------------------------------

  describe('updateMedia', () => {
    it('should update mutable fields for the owner', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      const updated = { ...item, title: 'New Title', favorite: true };

      // findUnique called by getMediaWithOwnershipCheck
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(
        item.id,
        { title: 'New Title', favorite: true },
        'user-1',
        ownPerms,
      );

      expect(result).toEqual(updated);
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: item.id },
          data: expect.objectContaining({ title: 'New Title', favorite: true }),
        }),
      );
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.updateMedia(item.id, { title: 'hack' }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should allow Admin with media:write_any to update another user\'s item', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      const updated = { ...item, title: 'Admin Updated' };

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(
        item.id,
        { title: 'Admin Updated' },
        'user-1',
        anyPerms,
      );

      expect(result.title).toBe('Admin Updated');
    });

    it('should throw NotFoundException when item does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.updateMedia(randomUUID(), { favorite: true }, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // deleteMedia — soft-delete
  // -------------------------------------------------------------------------

  describe('deleteMedia', () => {
    it('should set deletedAt on the MediaItem (soft-delete)', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      } as any);

      await service.deleteMedia(item.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: item.id },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('should NOT call storageObject.delete (blob stays intact)', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      } as any);

      await service.deleteMedia(item.id, 'user-1', ownPerms);

      expect(mockPrisma.storageObject.delete).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.deleteMedia(item.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:delete_any to soft-delete another user\'s item', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue({
        ...item,
        deletedAt: new Date(),
      } as any);

      await expect(
        service.deleteMedia(item.id, 'user-1', anyPerms),
      ).resolves.not.toThrow();

      expect(mockPrisma.mediaItem.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException when item does not exist', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.deleteMedia(randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // listTags
  // -------------------------------------------------------------------------

  describe('listTags', () => {
    it('should return caller\'s tags with count', async () => {
      const tags = [
        { id: randomUUID(), name: 'nature', createdAt: new Date(), addedById: 'user-1', circleId: CIRCLE_ID, _count: { mediaTags: 3 } },
        { id: randomUUID(), name: 'travel', createdAt: new Date(), addedById: 'user-1', circleId: CIRCLE_ID, _count: { mediaTags: 1 } },
      ];

      mockPrisma.tag.findMany.mockResolvedValue(tags as any);

      const result = await service.listTags(CIRCLE_ID, 'user-1', ownPerms);

      expect(result).toEqual([
        { id: tags[0].id, name: 'nature', createdAt: tags[0].createdAt, count: 3 },
        { id: tags[1].id, name: 'travel', createdAt: tags[1].createdAt, count: 1 },
      ]);
      expect(mockPrisma.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId: CIRCLE_ID },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // attachTags
  // -------------------------------------------------------------------------

  describe('attachTags', () => {
    it('should upsert Tag and MediaTag for each name (idempotent)', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      const tag = makeTag({ name: 'nature' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);

      const result = await service.attachTags(
        item.id,
        { names: ['nature', 'travel'] },
        'user-1',
        ownPerms,
      );

      // Two tag upserts, two mediaTag upserts
      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledTimes(2);

      // Verify tag upsert args for first name
      expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId_name: { circleId: CIRCLE_ID, name: 'nature' } },
          create: { addedById: 'user-1', circleId: CIRCLE_ID, name: 'nature' },
          update: {},
        }),
      );

      expect(result).toHaveLength(2);
    });

    it('creates MediaTag with source=manual and updates source to manual (manual source is set on both sides)', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      const tag = makeTag({ name: 'nature' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);

      await service.attachTags(item.id, { names: ['nature'] }, 'user-1', ownPerms);

      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ source: 'manual' }),
          update: expect.objectContaining({ source: 'manual' }),
        }),
      );
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.attachTags(item.id, { names: ['nature'] }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:write_any to attach tags to another user\'s item', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      const tag = makeTag({ addedById: 'user-1', name: 'nature' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);

      await expect(
        service.attachTags(item.id, { names: ['nature'] }, 'user-1', anyPerms),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // removeTag
  // -------------------------------------------------------------------------

  describe('removeTag', () => {
    it('should delete the MediaTag join record', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      const tag = makeTag();
      const mediaTag = { id: randomUUID(), tagId: tag.id, mediaItemId: item.id, addedAt: new Date() };

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaTag.findUnique.mockResolvedValue(mediaTag as any);
      mockPrisma.mediaTag.delete.mockResolvedValue(mediaTag as any);

      await service.removeTag(item.id, tag.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaTag.delete).toHaveBeenCalledWith({
        where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId: item.id } },
      });
    });

    it('should throw NotFoundException when the tag is not attached', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaTag.findUnique.mockResolvedValue(null);

      await expect(
        service.removeTag(item.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.removeTag(item.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // createAlbum
  // -------------------------------------------------------------------------

  describe('createAlbum', () => {
    it('should create an album owned by the caller', async () => {
      const album = makeAlbum({ name: 'Vacation' });
      mockPrisma.album.create.mockResolvedValue(album as any);

      const result = await service.createAlbum({ name: 'Vacation', circleId: CIRCLE_ID }, 'user-1', ownPerms);

      expect(result).toEqual(album);
      expect(mockPrisma.album.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ addedById: 'user-1', name: 'Vacation' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // listAlbums
  // -------------------------------------------------------------------------

  describe('listAlbums', () => {
    beforeEach(() => {
      mockPrisma.album.findMany.mockResolvedValue([]);
      mockPrisma.album.count.mockResolvedValue(0);
    });

    it('should filter by circleId from query', async () => {
      await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      const [call] = (mockPrisma.album.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ circleId: CIRCLE_ID });
    });

    it('should always filter by circleId from query regardless of permissions', async () => {
      await service.listAlbums(defaultAlbumQuery, 'user-1', anyPerms);

      const [call] = (mockPrisma.album.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ circleId: CIRCLE_ID });
    });

    it('should return correct pagination meta', async () => {
      mockPrisma.album.count.mockResolvedValue(30);

      const result = await service.listAlbums(
        { ...defaultAlbumQuery, page: 2, pageSize: 10 },
        'user-1',
        ownPerms,
      );

      expect(result.meta).toEqual({
        page: 2,
        pageSize: 10,
        totalItems: 30,
        totalPages: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getAlbum
  // -------------------------------------------------------------------------

  describe('getAlbum', () => {
    it('should return album with items for the owner', async () => {
      const album = { ...makeAlbum(), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      const result = await service.getAlbum(album.id, 'user-1', ownPerms);

      expect(result).toEqual(album);
    });

    it('should throw NotFoundException when album does not exist', async () => {
      mockPrisma.album.findUnique.mockResolvedValue(null);

      await expect(
        service.getAlbum(randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = { ...makeAlbum({ addedById: 'other-user' }), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.getAlbum(album.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow Admin with media:read_any to access another user\'s album', async () => {
      const album = { ...makeAlbum({ addedById: 'other-user' }), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);

      const result = await service.getAlbum(album.id, 'user-1', anyPerms);

      expect(result).toEqual(album);
    });
  });

  // -------------------------------------------------------------------------
  // updateAlbum
  // -------------------------------------------------------------------------

  describe('updateAlbum', () => {
    it('should update album name and description for owner', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      const updated = { ...album, name: 'New Name' };

      // getAlbumWithOwnershipCheck uses album.findUnique
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.update.mockResolvedValue(updated as any);

      const result = await service.updateAlbum(
        album.id,
        { name: 'New Name' },
        'user-1',
        ownPerms,
      );

      expect(result.name).toBe('New Name');
      expect(mockPrisma.album.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: album.id },
          data: expect.objectContaining({ name: 'New Name' }),
        }),
      );
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = makeAlbum({ addedById: 'other-user' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.updateAlbum(album.id, { name: 'hack' }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // deleteAlbum
  // -------------------------------------------------------------------------

  describe('deleteAlbum', () => {
    it('should delete the album (and cascade AlbumItems) for the owner', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.delete.mockResolvedValue(album as any);

      await service.deleteAlbum(album.id, 'user-1', ownPerms);

      expect(mockPrisma.album.delete).toHaveBeenCalledWith({
        where: { id: album.id },
      });
    });

    it('should NOT call mediaItem.delete (MediaItems are not deleted)', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.delete.mockResolvedValue(album as any);

      await service.deleteAlbum(album.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.delete).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.deleteMany).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = makeAlbum({ addedById: 'other-user' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.deleteAlbum(album.id, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // addAlbumItems
  // -------------------------------------------------------------------------

  describe('addAlbumItems', () => {
    it('should upsert AlbumItem joins (idempotent)', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      const item1 = makeMediaItem({ addedById: 'user-1' });
      const item2 = makeMediaItem({ addedById: 'user-1' });

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([item1, item2] as any);
      (mockPrisma.albumItem.upsert as jest.Mock).mockImplementation(async ({ create }: any) => ({
        id: randomUUID(),
        albumId: create.albumId,
        mediaItemId: create.mediaItemId,
        addedAt: new Date(),
      }));

      const result = await service.addAlbumItems(
        album.id,
        { mediaItemIds: [item1.id, item2.id] },
        'user-1',
        ownPerms,
      );

      expect(mockPrisma.albumItem.upsert).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });

    it('should throw NotFoundException when a mediaItemId is not found', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      // Return only 1 item when 2 were requested
      mockPrisma.mediaItem.findMany.mockResolvedValue([makeMediaItem()] as any);

      await expect(
        service.addAlbumItems(
          album.id,
          { mediaItemIds: [randomUUID(), randomUUID()] },
          'user-1',
          ownPerms,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // removeAlbumItem
  // -------------------------------------------------------------------------

  describe('removeAlbumItem', () => {
    it('should delete the AlbumItem join record', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      const item = makeMediaItem({ addedById: 'user-1' });
      const albumItem = {
        id: randomUUID(),
        albumId: album.id,
        mediaItemId: item.id,
        addedAt: new Date(),
      };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findUnique.mockResolvedValue(albumItem as any);
      mockPrisma.albumItem.delete.mockResolvedValue(albumItem as any);

      await service.removeAlbumItem(album.id, item.id, 'user-1', ownPerms);

      expect(mockPrisma.albumItem.delete).toHaveBeenCalledWith({
        where: { albumId_mediaItemId: { albumId: album.id, mediaItemId: item.id } },
      });
    });

    it('should NOT delete the underlying MediaItem', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      const item = makeMediaItem({ addedById: 'user-1' });
      const albumItem = {
        id: randomUUID(),
        albumId: album.id,
        mediaItemId: item.id,
        addedAt: new Date(),
      };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findUnique.mockResolvedValue(albumItem as any);
      mockPrisma.albumItem.delete.mockResolvedValue(albumItem as any);

      await service.removeAlbumItem(album.id, item.id, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.delete).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when the item is not in the album', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findUnique.mockResolvedValue(null);

      await expect(
        service.removeAlbumItem(album.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const album = makeAlbum({ addedById: 'other-user' });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.removeAlbumItem(album.id, randomUUID(), 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // -------------------------------------------------------------------------
  // listLocations — where-clause assertions, shape, and URL signing
  // -------------------------------------------------------------------------

  describe('listLocations', () => {
    // Default (empty) query for listLocations — all fields optional.
    const emptyLocQuery = { circleId: CIRCLE_ID } as any;

    function makeGeoItem(overrides: Partial<any> = {}) {
      return {
        id: randomUUID(),
        takenLat: 9.9281,
        takenLng: -84.0907,
        capturedAt: new Date('2024-06-15'),
        geoLocality: 'La Fortuna',
        metadata: { thumbnailStorageKey: 'thumbs/abc.jpg' },
        ...overrides,
      };
    }

    beforeEach(() => {
      // Default: prisma returns an empty array.
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    });

    // ----- Where-clause: mandatory conditions -----

    it('always includes takenLat:{not:null} in the where clause', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ takenLat: { not: null } });
    });

    it('always includes takenLng:{not:null} in the where clause', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ takenLng: { not: null } });
    });

    it('always includes deletedAt:null in the where clause', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ deletedAt: null });
    });

    // ----- Where-clause: ownership branch -----

    it('filters by circleId from query', async () => {
      await service.listLocations({ circleId: CIRCLE_ID } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ circleId: CIRCLE_ID });
    });

    it('always filters by circleId from query regardless of permissions', async () => {
      await service.listLocations({ circleId: CIRCLE_ID } as any, 'user-1', anyPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ circleId: CIRCLE_ID });
    });

    // ----- Where-clause: NO pagination -----

    it('does NOT pass skip or take (no pagination)', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0]).not.toHaveProperty('skip');
      expect(call[0]).not.toHaveProperty('take');
    });

    // ----- Where-clause: optional filters -----

    it('filters by type when provided', async () => {
      await service.listLocations({ circleId: CIRCLE_ID, type: 'video' } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ type: 'video' });
    });

    it('filters by capturedAt date range', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');
      await service.listLocations(
        { circleId: CIRCLE_ID, capturedAtFrom: from, capturedAtTo: to } as any,
        'user-1',
        ownPerms,
      );
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.capturedAt).toMatchObject({ gte: from, lte: to });
    });

    it('filters by country via OR across geoCountry and geoCountryCode', async () => {
      await service.listLocations({ circleId: CIRCLE_ID, country: 'CR' } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'CR', mode: 'insensitive' } },
          { geoCountryCode: { equals: 'CR', mode: 'insensitive' } },
        ]),
      );
    });

    it('filters by region (geoAdmin1 contains, case-insensitive)', async () => {
      await service.listLocations({ circleId: CIRCLE_ID, region: 'Alajuela' } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoAdmin1: { contains: 'Alajuela', mode: 'insensitive' },
      });
    });

    it('filters by locality (geoLocality contains, case-insensitive)', async () => {
      await service.listLocations({ circleId: CIRCLE_ID, locality: 'La Fortuna' } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoLocality: { contains: 'La Fortuna', mode: 'insensitive' },
      });
    });

    it('filters by place (geoPlaceName contains, case-insensitive)', async () => {
      await service.listLocations({ circleId: CIRCLE_ID, place: 'Arenal' } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        geoPlaceName: { contains: 'Arenal', mode: 'insensitive' },
      });
    });

    it('free-text location filter spans all geo tiers via OR', async () => {
      await service.listLocations({ circleId: CIRCLE_ID, location: 'Costa Rica' } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.OR).toEqual(
        expect.arrayContaining([
          { geoCountry: { contains: 'Costa Rica', mode: 'insensitive' } },
          { geoAdmin1: { contains: 'Costa Rica', mode: 'insensitive' } },
          { geoLocality: { contains: 'Costa Rica', mode: 'insensitive' } },
          { geoPlaceName: { contains: 'Costa Rica', mode: 'insensitive' } },
        ]),
      );
    });

    // ----- Select: minimal fields -----

    it('selects only the 6 required fields (id, takenLat, takenLng, capturedAt, geoLocality, metadata)', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].select).toEqual({
        id: true,
        takenLat: true,
        takenLng: true,
        capturedAt: true,
        geoLocality: true,
        metadata: true,
      });
    });

    // ----- Return shape and thumbnail signing -----

    it('returns the 6-field MediaLocation shape with a signed thumbnailUrl', async () => {
      const item = makeGeoItem();
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://cdn.example.com/thumb.jpg');

      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: item.id,
        takenLat: item.takenLat,
        takenLng: item.takenLng,
        capturedAt: item.capturedAt,
        geoLocality: item.geoLocality,
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
      });
    });

    it('does NOT include metadata in the returned objects', async () => {
      const item = makeGeoItem();
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);

      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(results[0]).not.toHaveProperty('metadata');
    });

    it('calls getSignedDownloadUrl with the thumbnailStorageKey from metadata', async () => {
      const item = makeGeoItem({ metadata: { thumbnailStorageKey: 'thumbs/xyz.jpg' } });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);

      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith('thumbs/xyz.jpg');
    });

    it('returns thumbnailUrl: null when metadata has no thumbnailStorageKey', async () => {
      const item = makeGeoItem({ metadata: null });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);

      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(results[0].thumbnailUrl).toBeNull();
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns thumbnailUrl: null when getSignedDownloadUrl throws (signing failure)', async () => {
      const item = makeGeoItem({ metadata: { thumbnailStorageKey: 'thumbs/broken.jpg' } });
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockStorageProvider.getSignedDownloadUrl.mockRejectedValue(new Error('S3 error'));

      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      // Signing failure is swallowed; thumbnailUrl falls back to null.
      expect(results[0].thumbnailUrl).toBeNull();
    });

    it('returns an empty array when no geotagged items exist', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      expect(results).toEqual([]);
    });

    it('signs multiple thumbnails in parallel (all items get a URL)', async () => {
      const items = [
        makeGeoItem({ id: 'a', metadata: { thumbnailStorageKey: 'thumbs/a.jpg' } }),
        makeGeoItem({ id: 'b', metadata: { thumbnailStorageKey: 'thumbs/b.jpg' } }),
        makeGeoItem({ id: 'c', metadata: { thumbnailStorageKey: 'thumbs/c.jpg' } }),
      ];
      mockPrisma.mediaItem.findMany.mockResolvedValue(items as any);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://cdn.example.com/signed');

      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(results).toHaveLength(3);
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // bulkUpdateMedia
  // -------------------------------------------------------------------------

  describe('bulkUpdateMedia', () => {
    const makeIds = (n: number) =>
      Array.from({ length: n }, () => randomUUID());

    function makeBulkUpdateDto(overrides: Partial<any> = {}): any {
      return {
        circleId: CIRCLE_ID,
        ids: makeIds(2),
        set: { classification: 'memory' as const },
        ...overrides,
      };
    }

    it('assertAllInCircle rejects (NotFoundException) when not all ids belong to circle', async () => {
      const ids = makeIds(3);
      const dto = makeBulkUpdateDto({ ids, set: { classification: 'memory' as const } });
      // findMany returns only 2 out of 3 ids
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: ids[0] },
        { id: ids[1] },
      ] as any);

      await expect(
        service.bulkUpdateMedia(dto, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when assertCircleAccess rejects (collaborator gate)', async () => {
      const dto = makeBulkUpdateDto();
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Insufficient circle role'),
      );

      await expect(
        service.bulkUpdateMedia(dto, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('sets location fields + reverseGeocode + geoSource:manual when location is provided', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({
        ids,
        set: {
          location: { lat: 9.9281, lng: -84.0907 },
        },
      });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockGeoProvider.reverseGeocode.mockResolvedValue({
        country: 'Costa Rica',
        countryCode: 'CR',
        admin1: 'Alajuela',
        locality: 'La Fortuna',
      });
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toMatchObject({
        takenLat: 9.9281,
        takenLng: -84.0907,
        geoSource: 'manual',
        geoCountry: 'Costa Rica',
        geoCountryCode: 'CR',
        geoAdmin1: 'Alajuela',
        geoLocality: 'La Fortuna',
      });
      expect(updateCall[0].data.geocodedAt).toBeInstanceOf(Date);
    });

    it('sets GEO_CLEAR_COLUMNS when location is null', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({ ids, set: { location: null } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toMatchObject({
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
      });
    });

    it('updates classification and favorite only (no location)', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({
        ids,
        set: { classification: 'memory' as const, favorite: true },
      });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      expect(mockGeoProvider.reverseGeocode).not.toHaveBeenCalled();
      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toMatchObject({
        classification: 'memory',
        favorite: true,
      });
    });

    it('returns { updated: count }', async () => {
      const ids = makeIds(3);
      const dto = makeBulkUpdateDto({ ids, set: { classification: 'memory' as const } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      expect(result).toEqual({ updated: 3 });
    });

    it('does not call reverseGeocode when location is undefined', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({ ids, set: { favorite: false } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      expect(mockGeoProvider.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // bulkTags
  // -------------------------------------------------------------------------

  describe('bulkTags', () => {
    function makeBulkTagsDto(overrides: Partial<any> = {}): any {
      return {
        circleId: CIRCLE_ID,
        ids: [randomUUID(), randomUUID()],
        add: ['nature'],
        ...overrides,
      };
    }

    it('throws ForbiddenException when assertCircleAccess rejects', async () => {
      const dto = makeBulkTagsDto();
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Insufficient circle role'),
      );

      await expect(
        service.bulkTags(dto, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('upserts tag per name and createMany skipDuplicates with ids×tagIds for add operation', async () => {
      const ids = [randomUUID(), randomUUID()];
      const tagId = randomUUID();
      const dto = makeBulkTagsDto({ ids, add: ['nature', 'travel'] });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      const tag1 = makeTag({ id: tagId, name: 'nature' });
      const tag2 = makeTag({ id: randomUUID(), name: 'travel' });
      mockPrisma.tag.upsert
        .mockResolvedValueOnce(tag1 as any)
        .mockResolvedValueOnce(tag2 as any);
      mockPrisma.mediaTag.createMany.mockResolvedValue({ count: 4 });

      await service.bulkTags(dto, 'user-1', ownPerms);

      // upsert called twice (once per tag name)
      expect(mockPrisma.tag.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId_name: { circleId: CIRCLE_ID, name: 'nature' } },
        }),
      );

      // createMany called with ids × tagIds cross-product, each pair with source=manual
      expect(mockPrisma.mediaTag.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
          data: expect.arrayContaining([
            expect.objectContaining({ mediaItemId: ids[0], tagId: tag1.id, source: 'manual' }),
            expect.objectContaining({ mediaItemId: ids[1], tagId: tag1.id, source: 'manual' }),
            expect.objectContaining({ mediaItemId: ids[0], tagId: tag2.id, source: 'manual' }),
            expect.objectContaining({ mediaItemId: ids[1], tagId: tag2.id, source: 'manual' }),
          ]),
        }),
      );
    });

    it('promotes existing ai-sourced MediaTags to manual via updateMany after createMany', async () => {
      const ids = [randomUUID(), randomUUID()];
      const tag1 = makeTag({ id: randomUUID(), name: 'nature' });
      const tag2 = makeTag({ id: randomUUID(), name: 'travel' });
      const dto = makeBulkTagsDto({ ids, add: ['nature', 'travel'] });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.tag.upsert
        .mockResolvedValueOnce(tag1 as any)
        .mockResolvedValueOnce(tag2 as any);
      mockPrisma.mediaTag.createMany.mockResolvedValue({ count: 0 });

      await service.bulkTags(dto, 'user-1', ownPerms);

      expect(mockPrisma.mediaTag.updateMany).toHaveBeenCalledWith({
        where: {
          tagId: { in: [tag1.id, tag2.id] },
          mediaItemId: { in: ids },
          source: 'ai',
        },
        data: { source: 'manual' },
      });
    });

    it('remove operation resolves existing tag ids and calls deleteMany', async () => {
      const ids = [randomUUID(), randomUUID()];
      const tagId = randomUUID();
      const dto = makeBulkTagsDto({ ids, add: undefined, remove: ['nature'] });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.tag.findMany.mockResolvedValue([{ id: tagId }] as any);
      mockPrisma.mediaTag.deleteMany.mockResolvedValue({ count: 2 });

      await service.bulkTags(dto, 'user-1', ownPerms);

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tagId: { in: [tagId] },
            mediaItemId: { in: ids },
          }),
        }),
      );
    });

    it('non-existent remove names are a no-op (tag.findMany returns [])', async () => {
      const ids = [randomUUID()];
      const dto = makeBulkTagsDto({ ids, add: undefined, remove: ['nonexistent'] });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.tag.findMany.mockResolvedValue([] as any);

      await service.bulkTags(dto, 'user-1', ownPerms);

      expect(mockPrisma.mediaTag.deleteMany).not.toHaveBeenCalled();
    });

    it('uses $transaction', async () => {
      const ids = [randomUUID()];
      const dto = makeBulkTagsDto({ ids });

      mockPrisma.mediaItem.findMany.mockResolvedValue([{ id: ids[0] }] as any);
      mockPrisma.tag.upsert.mockResolvedValue(makeTag({ name: 'nature' }) as any);
      mockPrisma.mediaTag.createMany.mockResolvedValue({ count: 1 });

      await service.bulkTags(dto, 'user-1', ownPerms);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('returns { added, removed }', async () => {
      const ids = [randomUUID(), randomUUID()];
      const dto = makeBulkTagsDto({ ids, add: ['nature', 'travel'], remove: ['old'] });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.tag.upsert
        .mockResolvedValueOnce(makeTag({ name: 'nature' }) as any)
        .mockResolvedValueOnce(makeTag({ name: 'travel' }) as any);
      mockPrisma.mediaTag.createMany.mockResolvedValue({ count: 4 });
      mockPrisma.tag.findMany.mockResolvedValue([{ id: randomUUID() }] as any);
      mockPrisma.mediaTag.deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.bulkTags(dto, 'user-1', ownPerms);

      expect(result).toEqual({ added: 4, removed: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // bulkDelete
  // -------------------------------------------------------------------------

  describe('bulkDelete', () => {
    function makeBulkDeleteDto(overrides: Partial<any> = {}): any {
      return {
        circleId: CIRCLE_ID,
        ids: [randomUUID(), randomUUID()],
        ...overrides,
      };
    }

    it('throws ForbiddenException when assertCircleAccess rejects', async () => {
      const dto = makeBulkDeleteDto();
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Insufficient circle role'),
      );

      await expect(
        service.bulkDelete(dto, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('calls updateMany with deletedAt:new Date() where id in ids, circleId, deletedAt:null', async () => {
      const ids = [randomUUID(), randomUUID()];
      const dto = makeBulkDeleteDto({ ids });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkDelete(dto, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: ids },
            circleId: CIRCLE_ID,
            deletedAt: null,
          }),
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('returns { deleted: count }', async () => {
      const ids = [randomUUID(), randomUUID()];
      const dto = makeBulkDeleteDto({ ids });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.bulkDelete(dto, 'user-1', ownPerms);

      expect(result).toEqual({ deleted: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // listMedia — new filters
  // -------------------------------------------------------------------------

  describe('listMedia — new device and geo-missing filters', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);
    });

    it('filters by cameraMake (contains, insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, cameraMake: 'Canon' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        cameraMake: { contains: 'Canon', mode: 'insensitive' },
      });
    });

    it('filters by cameraModel (contains, insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, cameraModel: 'EOS R5' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        cameraModel: { contains: 'EOS R5', mode: 'insensitive' },
      });
    });

    it('filters by sourceDeviceName (contains, insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, sourceDeviceName: 'iPhone' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        sourceDeviceName: { contains: 'iPhone', mode: 'insensitive' },
      });
    });

    it('filters by sourceDeviceId (exact match)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, sourceDeviceId: 'dev-123' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ sourceDeviceId: 'dev-123' });
      // Exact match — NOT wrapped in { contains: ... }
      expect(call[0].where.sourceDeviceId).toBe('dev-123');
    });

    it('missingGeo:true → { takenLat: null, takenLng: null } in where', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, missingGeo: true },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ takenLat: null, takenLng: null });
    });

    it('missingGeo:false → { takenLat: { not: null }, takenLng: { not: null } } in where', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, missingGeo: false },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        takenLat: { not: null },
        takenLng: { not: null },
      });
    });

    it('no missingGeo filter when undefined', async () => {
      // defaultMediaQuery has no missingGeo field
      await service.listMedia({ ...defaultMediaQuery }, 'user-1', ownPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // where must NOT contain takenLat or takenLng as top-level keys
      // (they would only appear if missingGeo filter was applied)
      expect(call[0].where).not.toHaveProperty('takenLat');
      expect(call[0].where).not.toHaveProperty('takenLng');
    });
  });

  // -------------------------------------------------------------------------
  // getMedia — tags mapping
  // -------------------------------------------------------------------------

  describe('getMedia — tags mapping', () => {
    it('returns tags string[] mapped from mediaTags', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        ...item,
        mediaTags: [
          { tag: { name: 'vacation' } },
          { tag: { name: 'nature' } },
        ],
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: item.storageObjectId, uploadedById: 'user-1' }) as any,
      );

      const result = await service.getMedia(item.id, 'user-1', ownPerms);

      expect(result.tags).toEqual(['vacation', 'nature']);
    });

    it('returns tags: [] when mediaTags is empty', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        ...item,
        mediaTags: [],
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: item.storageObjectId, uploadedById: 'user-1' }) as any,
      );

      const result = await service.getMedia(item.id, 'user-1', ownPerms);

      expect(result.tags).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getDashboard
  // -------------------------------------------------------------------------

  describe('getDashboard', () => {
    const dashboardQuery = { circleId: CIRCLE_ID } as any;

    it('throws ForbiddenException when assertCircleAccess rejects', async () => {
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Not a circle member'),
      );

      await expect(
        service.getDashboard(dashboardQuery, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns shape { onThisDay, recent, favorites, counts }', async () => {
      // $queryRaw returns empty — no onThisDay items to hydrate
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      // Promise.all: onThisDay hydration skipped (empty ids), recent, favorites
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([]) // recent
        .mockResolvedValueOnce([]); // favorites
      // count calls: total, unreviewed, lowValue, missingGeo
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(10);

      const result = await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      expect(result).toHaveProperty('onThisDay');
      expect(result).toHaveProperty('recent');
      expect(result).toHaveProperty('favorites');
      expect(result).toHaveProperty('counts');
      expect(result.counts).toMatchObject({
        total: 100,
        unreviewed: 20,
        lowValue: 5,
        missingGeo: 10,
      });
    });

    it('getDashboard passes correct where to count queries', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(50)  // total
        .mockResolvedValueOnce(10)  // unreviewed
        .mockResolvedValueOnce(3)   // low_value
        .mockResolvedValueOnce(7);  // missingGeo

      await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      const countCalls = (mockPrisma.mediaItem.count as jest.Mock).mock.calls;

      // All count calls must include circleId and deletedAt: null
      for (const call of countCalls) {
        expect(call[0].where).toMatchObject({
          circleId: CIRCLE_ID,
          deletedAt: null,
        });
      }

      // Verify specific classification filters
      const allWheres = countCalls.map((c: any) => c[0].where);
      const unreviewedWhere = allWheres.find(
        (w: any) => w.classification === 'unreviewed',
      );
      const lowValueWhere = allWheres.find(
        (w: any) => w.classification === 'low_value',
      );
      const missingGeoWhere = allWheres.find(
        (w: any) => w.takenLat === null,
      );

      expect(unreviewedWhere).toBeDefined();
      expect(lowValueWhere).toBeDefined();
      expect(missingGeoWhere).toBeDefined();
    });

    it('onThisDay uses $queryRaw and hydrates ids via findMany', async () => {
      const mediaId = randomUUID();
      const item = makeMediaItem({ id: mediaId });

      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: mediaId }]);
      // First findMany call is for onThisDay hydration, then recent, then favorites
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([item] as any) // onThisDay hydration
        .mockResolvedValueOnce([])            // recent
        .mockResolvedValueOnce([]);           // favorites
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      // Assert findMany was called with id in [mediaId] for hydration
      const findManyCalls = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      const hydrateCall = findManyCalls.find(
        (c: any) => c[0].where?.id?.in?.includes(mediaId),
      );
      expect(hydrateCall).toBeDefined();

      expect(result.onThisDay).toHaveLength(1);
      expect(result.onThisDay[0].id).toBe(mediaId);
    });

    it('recent ordered by importedAt desc take 12', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([])  // recent
        .mockResolvedValueOnce([]); // favorites
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      const findManyCalls = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      const recentCall = findManyCalls.find(
        (c: any) =>
          c[0].orderBy?.importedAt === 'desc' && c[0].take === 12,
      );
      expect(recentCall).toBeDefined();
    });

    it('favorites filtered by favorite:true take 12', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([])  // recent
        .mockResolvedValueOnce([]); // favorites
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      const findManyCalls = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      const favoritesCall = findManyCalls.find(
        (c: any) => c[0].where?.favorite === true && c[0].take === 12,
      );
      expect(favoritesCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // listMedia — personId filter
  // -------------------------------------------------------------------------

  describe('listMedia — personId filter', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);
    });

    it('includes faces.some.personId in the where clause when personId is provided', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, personId: 'person-uuid-123' } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        faces: { some: { personId: 'person-uuid-123' } },
      });
    });

    it('omits the faces filter when personId is not provided', async () => {
      await service.listMedia({ ...defaultMediaQuery } as any, 'user-1', ownPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.faces).toBeUndefined();
    });
  });
});
