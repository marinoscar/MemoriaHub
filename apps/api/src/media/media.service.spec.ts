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
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';
import { mediaThumbnailsQuerySchema } from './dto/media-thumbnails-query.dto';

// ---------------------------------------------------------------------------
// AND-composition query helpers
//
// listMedia calls buildMediaWhere which now collects every filter contribution
// into a shared `where.AND = [...]` array. These helpers locate contributions
// without rewriting every assertion.
// ---------------------------------------------------------------------------

/** Returns the first entry in `where.AND` that owns the given top-level key. */
function inAnd(where: any, key: string): any {
  const and = where.AND as any[] | undefined;
  return and?.find((c: any) => key in c) ?? {};
}

/** Returns the first entry in `where.AND` whose `OR` array contains an element with the given key. */
function orInAnd(where: any, key: string): any {
  const and = where.AND as any[] | undefined;
  return (
    and?.find(
      (c: any) => Array.isArray(c.OR) && c.OR.some((e: any) => key in e),
    ) ?? {}
  );
}

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
    addedById: 'user-1',
    circleId: CIRCLE_ID,
    name: 'My Album',
    description: null,
    coverMediaItemId: null,
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
  let mockResolver: { getProviderFor: jest.Mock };
  let mockMediaEnrichmentService: {
    enqueueUploadEnrichment: jest.Mock;
    enqueueForStorageObject: jest.Mock;
    enqueueTagRerun: jest.Mock;
    enqueueFaceRerun: jest.Mock;
    enqueueThumbnailRerun: jest.Mock;
  };

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
    // Default: getProviderFor resolves to a provider so existing tests that reach
    // the download-URL routing path (FIX 1) do not throw on .then().
    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue({
        getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
      }),
    };
    mockMediaEnrichmentService = {
      enqueueUploadEnrichment: jest.fn().mockResolvedValue(undefined),
      enqueueForStorageObject: jest.fn().mockResolvedValue(undefined),
      enqueueTagRerun: jest.fn().mockResolvedValue(undefined),
      enqueueFaceRerun: jest.fn().mockResolvedValue(undefined),
      enqueueThumbnailRerun: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: MediaMetadataSyncService, useValue: mockSyncService },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: GEO_LOCATION_PROVIDER, useValue: mockGeoProvider },
        { provide: ForwardGeocodeService, useValue: mockForwardGeocodeService },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: MediaEnrichmentService, useValue: mockMediaEnrichmentService },
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
      // AND-composition: type lives inside where.AND[n]
      expect(inAnd(call[0].where, 'type')).toMatchObject({ type: 'photo' });
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
      // AND-composition: capturedAt lives inside where.AND[n]
      expect(inAnd(call[0].where, 'capturedAt').capturedAt).toMatchObject({ gte: from, lte: to });
    });

    it('filters by albumId via AlbumItem join', async () => {
      const albumId = randomUUID();

      await service.listMedia(
        { ...defaultMediaQuery, albumId },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // AND-composition: albumItems lives inside where.AND[n]
      expect(inAnd(call[0].where, 'albumItems').albumItems).toMatchObject({ some: { albumId } });
    });

    it('filters by favorite', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, favorite: true },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // AND-composition: favorite lives inside where.AND[n]
      expect(inAnd(call[0].where, 'favorite')).toMatchObject({ favorite: true });
    });

    it('filters by tag name via MediaTag join (case-insensitive)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, tag: 'nature' },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // AND-composition: mediaTags lives inside where.AND[n]
      expect(inAnd(call[0].where, 'mediaTags').mediaTags).toMatchObject({
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
      // AND-composition: country OR clause lives inside where.AND[n].OR
      expect(orInAnd(call[0].where, 'geoCountry').OR).toEqual(
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
      // AND-composition: geoAdmin1 lives inside where.AND[n]
      expect(inAnd(call[0].where, 'geoAdmin1')).toMatchObject({
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
      // AND-composition: geoLocality lives inside where.AND[n]
      expect(inAnd(call[0].where, 'geoLocality')).toMatchObject({
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
      // AND-composition: geoPlaceName lives inside where.AND[n]
      expect(inAnd(call[0].where, 'geoPlaceName')).toMatchObject({
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
      // AND-composition: location OR clause lives inside where.AND[n].OR
      expect(orInAnd(call[0].where, 'geoCountry').OR).toEqual(
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
      const updated = { ...item, favorite: true };

      // findUnique called by getMediaWithOwnershipCheck
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(
        item.id,
        { favorite: true },
        'user-1',
        ownPerms,
      );

      expect(result).toEqual(updated);
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: item.id },
          data: expect.objectContaining({ favorite: true }),
        }),
      );
    });

    it('should throw ForbiddenException for non-owner without _any permission', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('forbidden'));

      await expect(
        service.updateMedia(item.id, { description: 'hack' }, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should allow Admin with media:write_any to update another user\'s item', async () => {
      const item = makeMediaItem({ addedById: 'other-user' });
      const updated = { ...item, description: 'Admin Updated' };

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.mediaItem.update.mockResolvedValue(updated as any);

      const result = await service.updateMedia(
        item.id,
        { description: 'Admin Updated' },
        'user-1',
        anyPerms,
      );

      expect(result.description).toBe('Admin Updated');
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

    it('creates MediaTag with source=manual and promotes only ai rows to manual (never downgrades system/manual)', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      const tag = makeTag({ name: 'nature' });

      mockPrisma.mediaItem.findUnique.mockResolvedValue(item as any);
      mockPrisma.tag.upsert.mockResolvedValue(tag as any);
      mockPrisma.mediaTag.upsert.mockResolvedValue({} as any);
      mockPrisma.mediaTag.updateMany.mockResolvedValue({ count: 0 } as any);

      await service.attachTags(item.id, { names: ['nature'] }, 'user-1', ownPerms);

      // Create as manual; update is a no-op so an existing system/manual row is
      // never downgraded on conflict.
      expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ source: 'manual' }),
          update: {},
        }),
      );

      // A scoped updateMany promotes only source='ai' rows to 'manual'.
      expect(mockPrisma.mediaTag.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tagId: tag.id,
            mediaItemId: item.id,
            source: 'ai',
          }),
          data: { source: 'manual' },
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

    // -----------------------------------------------------------------------
    // itemCount / coverThumbnailUrl / dateRange enrichment
    // -----------------------------------------------------------------------

    it('returns itemCount matching the aggregated member count', async () => {
      const album = makeAlbum();
      mockPrisma.album.findMany.mockResolvedValue([album] as any);
      mockPrisma.album.count.mockResolvedValue(1);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({
        _count: { _all: 7 },
        _min: { capturedAt: null },
        _max: { capturedAt: null },
      } as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      expect(result.items[0].itemCount).toBe(7);
    });

    it('resolves coverThumbnailUrl to the explicitly-set cover item when coverMediaItemId is set', async () => {
      const coverId = randomUUID();
      const album = makeAlbum({ coverMediaItemId: coverId });
      mockPrisma.album.findMany.mockResolvedValue([album] as any);
      mockPrisma.album.count.mockResolvedValue(1);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({
        _count: { _all: 2 },
        _min: { capturedAt: null },
        _max: { capturedAt: null },
      } as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue({
        metadata: { thumbnailStorageKey: 'cover-thumb-key' },
      } as any);

      const result = await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: coverId }),
        }),
      );
      expect(result.items[0].coverThumbnailUrl).toBe('https://cdn.example.com/signed');
      expect(result.items[0].coverMediaItemId).toBe(coverId);
    });

    it('falls back to the most-recently-captured member thumbnail when no cover is set', async () => {
      const album = makeAlbum({ coverMediaItemId: null });
      mockPrisma.album.findMany.mockResolvedValue([album] as any);
      mockPrisma.album.count.mockResolvedValue(1);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _min: { capturedAt: null },
        _max: { capturedAt: null },
      } as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue({
        metadata: { thumbnailStorageKey: 'fallback-thumb-key' },
      } as any);

      const result = await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      // Fallback orders by capturedAt desc, then createdAt desc (most recent member).
      expect(mockPrisma.mediaItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
        }),
      );
      expect(result.items[0].coverThumbnailUrl).toBe('https://cdn.example.com/signed');
    });

    it('returns null coverThumbnailUrl when the album has no members', async () => {
      const album = makeAlbum({ coverMediaItemId: null });
      mockPrisma.album.findMany.mockResolvedValue([album] as any);
      mockPrisma.album.count.mockResolvedValue(1);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _min: { capturedAt: null },
        _max: { capturedAt: null },
      } as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      expect(result.items[0].coverThumbnailUrl).toBeNull();
    });

    it('returns dateRange as { min, max } across members', async () => {
      const album = makeAlbum();
      const min = new Date('2024-01-01T00:00:00.000Z');
      const max = new Date('2024-06-15T00:00:00.000Z');
      mockPrisma.album.findMany.mockResolvedValue([album] as any);
      mockPrisma.album.count.mockResolvedValue(1);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({
        _count: { _all: 2 },
        _min: { capturedAt: min },
        _max: { capturedAt: max },
      } as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      expect(result.items[0].dateRange).toEqual({
        min: min.toISOString(),
        max: max.toISOString(),
      });
    });

    it('returns dateRange as null for an empty album', async () => {
      const album = makeAlbum();
      mockPrisma.album.findMany.mockResolvedValue([album] as any);
      mockPrisma.album.count.mockResolvedValue(1);
      mockPrisma.mediaItem.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _min: { capturedAt: null },
        _max: { capturedAt: null },
      } as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.listAlbums(defaultAlbumQuery, 'user-1', ownPerms);

      expect(result.items[0].dateRange).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getAlbum
  // -------------------------------------------------------------------------

  describe('getAlbum', () => {
    it('should return album with items for the owner', async () => {
      const album = { ...makeAlbum(), items: [] };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      // No members → resolveAlbumCoverThumb's fallback findFirst finds nothing.
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.getAlbum(album.id, 'user-1', ownPerms);

      // getAlbum now also exposes coverThumbnailUrl (resolved from coverMediaItemId).
      expect(result).toEqual({ ...album, coverThumbnailUrl: null });
    });

    it('should sign a thumbnailUrl for each item and expose coverMediaItemId/coverThumbnailUrl', async () => {
      const mediaItem = makeMediaItem({
        metadata: { thumbnailStorageKey: 'item-thumb-key' },
      });
      const album = {
        ...makeAlbum({ addedById: 'user-1', coverMediaItemId: null }),
        items: [
          {
            id: randomUUID(),
            albumId: 'album-1',
            mediaItemId: mediaItem.id,
            addedAt: new Date(),
            mediaItem,
          },
        ],
      };
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.getAlbum(album.id, 'user-1', ownPerms);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: mediaItem.id,
        thumbnailUrl: 'https://cdn.example.com/signed',
      });
      expect(result.coverMediaItemId).toBeNull();
      expect(result.coverThumbnailUrl).toBeNull();
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
      mockPrisma.mediaItem.findFirst.mockResolvedValue(null);

      const result = await service.getAlbum(album.id, 'user-1', anyPerms);

      expect(result).toEqual({ ...album, coverThumbnailUrl: null });
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

    // -----------------------------------------------------------------------
    // coverMediaItemId (album cover pointer)
    // -----------------------------------------------------------------------

    it('sets the cover when coverMediaItemId is a member of the album', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      const mediaItemId = randomUUID();
      const updated = { ...album, coverMediaItemId: mediaItemId };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findFirst.mockResolvedValue({ id: 'album-item-1' } as any);
      mockPrisma.album.update.mockResolvedValue(updated as any);

      const result = await service.updateAlbum(
        album.id,
        { coverMediaItemId: mediaItemId },
        'user-1',
        ownPerms,
      );

      expect(mockPrisma.albumItem.findFirst).toHaveBeenCalledWith({
        where: { albumId: album.id, mediaItemId },
        select: { id: true },
      });
      expect(mockPrisma.album.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: album.id },
          data: expect.objectContaining({ coverMediaItemId: mediaItemId }),
        }),
      );
      expect(result.coverMediaItemId).toBe(mediaItemId);
    });

    it('throws BadRequestException when coverMediaItemId is not a member of the album', async () => {
      const album = makeAlbum({ addedById: 'user-1' });
      const mediaItemId = randomUUID();

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.albumItem.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAlbum(
          album.id,
          { coverMediaItemId: mediaItemId },
          'user-1',
          ownPerms,
        ),
      ).rejects.toThrow(
        new BadRequestException('Cover photo must be an item in this album'),
      );
      expect(mockPrisma.album.update).not.toHaveBeenCalled();
    });

    it('clears the cover when coverMediaItemId is null', async () => {
      const album = makeAlbum({ addedById: 'user-1', coverMediaItemId: randomUUID() });
      const updated = { ...album, coverMediaItemId: null };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.update.mockResolvedValue(updated as any);

      const result = await service.updateAlbum(
        album.id,
        { coverMediaItemId: null },
        'user-1',
        ownPerms,
      );

      // Member-check is skipped entirely when clearing the cover (null).
      expect(mockPrisma.albumItem.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.album.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ coverMediaItemId: null }),
        }),
      );
      expect(result.coverMediaItemId).toBeNull();
    });

    it('leaves the existing cover untouched when coverMediaItemId is omitted from the DTO', async () => {
      const existingCoverId = randomUUID();
      const album = makeAlbum({ addedById: 'user-1', coverMediaItemId: existingCoverId });
      const updated = { ...album, name: 'Renamed' };

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.album.update.mockResolvedValue(updated as any);

      await service.updateAlbum(album.id, { name: 'Renamed' }, 'user-1', ownPerms);

      expect(mockPrisma.albumItem.findFirst).not.toHaveBeenCalled();
      const [call] = (mockPrisma.album.update as jest.Mock).mock.calls;
      expect(call[0].data).not.toHaveProperty('coverMediaItemId');
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
  // addAlbumItemsByFilter
  // -------------------------------------------------------------------------

  describe('addAlbumItemsByFilter', () => {
    // Minimal valid DTO — circleId is present but the service ignores it in favour
    // of album.circleId (cross-circle safety).
    const dto = { circleId: CIRCLE_ID } as any;

    it('happy path: findMany called with album circleId and createMany called with skipDuplicates', async () => {
      const album = makeAlbum({ addedById: 'user-1', circleId: CIRCLE_ID });
      const matches = [{ id: 'item-a' }, { id: 'item-b' }, { id: 'item-c' }];

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue(matches as any);
      (mockPrisma.albumItem.createMany as jest.Mock).mockResolvedValue({ count: 3 });

      const result = await service.addAlbumItemsByFilter(album.id, dto, 'user-1', ownPerms);

      // findMany must have been called with the album's circleId, not any client-supplied one
      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(findManyCall[0].where).toMatchObject({ circleId: CIRCLE_ID });
      expect(findManyCall[0].select).toEqual({ id: true });

      // createMany must be called with skipDuplicates: true
      expect(mockPrisma.albumItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
          data: expect.arrayContaining([
            { albumId: album.id, mediaItemId: 'item-a' },
            { albumId: album.id, mediaItemId: 'item-b' },
            { albumId: album.id, mediaItemId: 'item-c' },
          ]),
        }),
      );

      expect(result).toEqual({ added: 3 });
    });

    it('cross-circle safety: where clause uses album.circleId even if dto carries a different circleId', async () => {
      const ALBUM_CIRCLE = 'album-circle-uuid-aaa';
      const CLIENT_CIRCLE = 'client-circle-uuid-bbb';
      const album = makeAlbum({ addedById: 'user-1', circleId: ALBUM_CIRCLE });

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      (mockPrisma.albumItem.createMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.addAlbumItemsByFilter(
        album.id,
        { circleId: CLIENT_CIRCLE } as any, // client supplies a different circleId
        'user-1',
        ownPerms,
      );

      const [findManyCall] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // Must use the album's circle, not the client-supplied one
      expect(findManyCall[0].where).toMatchObject({ circleId: ALBUM_CIRCLE });
      expect(findManyCall[0].where.circleId).not.toBe(CLIENT_CIRCLE);
    });

    it('role enforcement: viewer role causes rejection and createMany is NOT called', async () => {
      const album = makeAlbum({ addedById: 'other-user', circleId: CIRCLE_ID });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('insufficient circle role'),
      );

      await expect(
        service.addAlbumItemsByFilter(album.id, dto, 'viewer-user', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.albumItem.createMany).not.toHaveBeenCalled();
    });

    it('returns 0 when no media matches the filter', async () => {
      const album = makeAlbum({ addedById: 'user-1', circleId: CIRCLE_ID });
      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      (mockPrisma.albumItem.createMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.addAlbumItemsByFilter(album.id, dto, 'user-1', ownPerms);

      // createMany is still called (with empty data), count sums to 0
      expect(result).toEqual({ added: 0 });
    });

    it('chunking: 2500 matches triggers 3 createMany calls and sums their counts', async () => {
      const album = makeAlbum({ addedById: 'user-1', circleId: CIRCLE_ID });
      // Build 2500 fake matches
      const matches = Array.from({ length: 2500 }, (_, i) => ({ id: `item-${i}` }));

      mockPrisma.album.findUnique.mockResolvedValue(album as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue(matches as any);
      // Each createMany call counts exactly its chunk size: 1000 + 1000 + 500
      (mockPrisma.albumItem.createMany as jest.Mock)
        .mockResolvedValueOnce({ count: 1000 })
        .mockResolvedValueOnce({ count: 1000 })
        .mockResolvedValueOnce({ count: 500 });

      const result = await service.addAlbumItemsByFilter(album.id, dto, 'user-1', ownPerms);

      expect(mockPrisma.albumItem.createMany).toHaveBeenCalledTimes(3);

      // Verify each chunk carries the right slice
      const calls = (mockPrisma.albumItem.createMany as jest.Mock).mock.calls;
      expect(calls[0][0].data).toHaveLength(1000);
      expect(calls[1][0].data).toHaveLength(1000);
      expect(calls[2][0].data).toHaveLength(500);

      // Total added is the sum across all chunks
      expect(result).toEqual({ added: 2500 });
    });

    it('throws NotFoundException when the album does not exist', async () => {
      mockPrisma.album.findUnique.mockResolvedValue(null);

      await expect(
        service.addAlbumItemsByFilter(randomUUID(), dto, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.albumItem.createMany).not.toHaveBeenCalled();
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

    it('takenLat/takenLng are exactly {not:null} when no bbox is supplied', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.takenLat).toEqual({ not: null });
      expect(call[0].where.takenLng).toEqual({ not: null });
    });

    it('merges bbox range constraints into takenLat/takenLng when bbox is supplied', async () => {
      const bbox = { minLat: 9, minLng: -85, maxLat: 10, maxLng: -84 };
      await service.listLocations({ circleId: CIRCLE_ID, bbox } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.takenLat).toEqual({ not: null, gte: 9, lte: 10 });
      expect(call[0].where.takenLng).toEqual({ not: null, gte: -85, lte: -84 });
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

    it('AND-composes an albumItems filter when albumId is provided', async () => {
      const albumId = randomUUID();
      await service.listLocations({ circleId: CIRCLE_ID, albumId } as any, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({ albumItems: { some: { albumId } } });
    });

    it('does NOT add an albumItems filter when albumId is omitted', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).not.toHaveProperty('albumItems');
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

    it('selects only the 5 required fields (id, takenLat, takenLng, capturedAt, geoLocality) — no metadata', async () => {
      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].select).toEqual({
        id: true,
        takenLat: true,
        takenLng: true,
        capturedAt: true,
        geoLocality: true,
      });
    });

    // ----- Return shape: lightweight, no signing -----

    it('returns the 5-field MediaLocation shape (no thumbnailUrl)', async () => {
      const item = makeGeoItem();
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);

      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: item.id,
        takenLat: item.takenLat,
        takenLng: item.takenLng,
        capturedAt: item.capturedAt,
        geoLocality: item.geoLocality,
      });
    });

    it('does NOT call getSignedDownloadUrl (no per-row signing)', async () => {
      const item = makeGeoItem();
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);

      await service.listLocations(emptyLocQuery, 'user-1', ownPerms);

      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('returns an empty array when no geotagged items exist', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      const results = await service.listLocations(emptyLocQuery, 'user-1', ownPerms);
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // aggregateLocations
  // -------------------------------------------------------------------------

  describe('aggregateLocations', () => {
    const baseQuery = { circleId: CIRCLE_ID, precision: 3 } as any;

    function mockRawRow(overrides: Partial<any> = {}) {
      return {
        gy: 9,
        gx: -84,
        n: 3,
        lat: '9.928',
        lng: '-84.09',
        sample_id: randomUUID(),
        ...overrides,
      };
    }

    beforeEach(() => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    });

    it('calls assertCircleAccess with (userId, circleId, userPermissions, "viewer") before querying', async () => {
      await service.aggregateLocations(baseQuery, 'user-1', ownPerms);
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        CIRCLE_ID,
        ownPerms,
        'viewer',
      );
    });

    it('calls $queryRaw exactly once', async () => {
      await service.aggregateLocations(baseQuery, 'user-1', ownPerms);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('maps a raw row into { lat, lng, count, sampleId } with lat/lng coerced to JS numbers', async () => {
      const row = mockRawRow();
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([row]);

      const results = await service.aggregateLocations(baseQuery, 'user-1', ownPerms);

      expect(results).toEqual([{ lat: 9.928, lng: -84.09, count: 3, sampleId: row.sample_id }]);
      expect(typeof results[0].lat).toBe('number');
      expect(typeof results[0].lng).toBe('number');
    });

    it('returns [] when the raw query returns []', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      const results = await service.aggregateLocations(baseQuery, 'user-1', ownPerms);
      expect(results).toEqual([]);
    });

    it('does NOT include optional filter fragments when no filters are given', async () => {
      await service.aggregateLocations(baseQuery, 'user-1', ownPerms);
      const sqlObj = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;

      expect(sqlObj.text).not.toContain('AND captured_at >=');
      expect(sqlObj.text).not.toContain('AND captured_at <=');
      expect(sqlObj.text).not.toContain('AND type::text =');
      expect(sqlObj.text).not.toContain('AND taken_lat BETWEEN');
      // Only circleId is interpolated when no optional filter is supplied.
      expect(sqlObj.values).toEqual([CIRCLE_ID]);
    });

    it('interpolates capturedAtFrom into the query when supplied', async () => {
      const from = new Date('2024-01-01');
      await service.aggregateLocations({ ...baseQuery, capturedAtFrom: from }, 'user-1', ownPerms);
      const sqlObj = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;

      expect(sqlObj.text).toContain('AND captured_at >=');
      expect(sqlObj.values).toContain(from);
    });

    it('interpolates capturedAtTo into the query when supplied', async () => {
      const to = new Date('2024-12-31');
      await service.aggregateLocations({ ...baseQuery, capturedAtTo: to }, 'user-1', ownPerms);
      const sqlObj = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;

      expect(sqlObj.text).toContain('AND captured_at <=');
      expect(sqlObj.values).toContain(to);
    });

    it('interpolates type into the query when supplied', async () => {
      await service.aggregateLocations({ ...baseQuery, type: 'video' }, 'user-1', ownPerms);
      const sqlObj = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;

      expect(sqlObj.text).toContain('AND type::text =');
      expect(sqlObj.values).toContain('video');
    });

    it('interpolates all four bbox bounds into the query when supplied', async () => {
      const bbox = { minLat: 9, minLng: -85, maxLat: 10, maxLng: -84 };
      await service.aggregateLocations({ ...baseQuery, bbox }, 'user-1', ownPerms);
      const sqlObj = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;

      expect(sqlObj.text).toContain('AND taken_lat BETWEEN');
      expect(sqlObj.values).toEqual(
        expect.arrayContaining([bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng]),
      );
    });

    it('embeds precision as a raw numeric literal, never as a bound parameter', async () => {
      await service.aggregateLocations({ ...baseQuery, precision: 3 }, 'user-1', ownPerms);
      const sqlObj = (mockPrisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;

      expect(sqlObj.text).toContain('round(taken_lat::numeric, 3)');
      expect(sqlObj.values).not.toContain(3);
    });

    it('does not sign thumbnails or issue any additional query (single $queryRaw round-trip)', async () => {
      await service.aggregateLocations(baseQuery, 'user-1', ownPerms);

      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.findMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getThumbnails
  // -------------------------------------------------------------------------

  describe('getThumbnails', () => {
    const baseQuery = (ids: string[]) => ({ circleId: CIRCLE_ID, ids } as any);

    beforeEach(() => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('calls assertCircleAccess with (userId, circleId, userPermissions, "viewer")', async () => {
      const id = randomUUID();
      await service.getThumbnails(baseQuery([id]), 'user-1', ownPerms);
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        CIRCLE_ID,
        ownPerms,
        'viewer',
      );
    });

    it('calls mediaItem.findMany exactly once with the expected where/select', async () => {
      const ids = [randomUUID(), randomUUID()];
      await service.getThumbnails(baseQuery(ids), 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith({
        where: { id: { in: ids }, circleId: CIRCLE_ID },
        select: { id: true, metadata: true },
      });
    });

    it('signs a single thumbnail via the resolved provider, calling storageObject.findMany once', async () => {
      const id = randomUUID();
      const key = 'thumbs/a.jpg';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id, metadata: { thumbnailStorageKey: key } },
      ] as any);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: key, storageProvider: 's3', bucket: 'bucket-a' },
      ]);
      const signedUrl = jest.fn().mockResolvedValue('https://cdn.example.com/a-signed.jpg');
      mockResolver.getProviderFor.mockResolvedValue({ getSignedDownloadUrl: signedUrl });

      const results = await service.getThumbnails(baseQuery([id]), 'user-1', ownPerms);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith({
        where: { storageKey: { in: [key] } },
        select: { storageKey: true, storageProvider: true, bucket: true },
      });
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-a');
      expect(signedUrl).toHaveBeenCalledWith(key);
      expect(results).toEqual([{ id, thumbnailUrl: 'https://cdn.example.com/a-signed.jpg' }]);
    });

    it('omits ids with no matching MediaItem row from the result', async () => {
      const foundId = randomUUID();
      const missingId = randomUUID();
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: foundId, metadata: null },
      ] as any);

      const results = await service.getThumbnails(baseQuery([foundId, missingId]), 'user-1', ownPerms);

      expect(results).toHaveLength(1);
      expect(results.map((r) => r.id)).toEqual([foundId]);
    });

    it('returns thumbnailUrl: null and does not attempt signing when metadata has no thumbnailStorageKey', async () => {
      const idNullMeta = randomUUID();
      const idNoKey = randomUUID();
      const idNonObject = randomUUID();
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: idNullMeta, metadata: null },
        { id: idNoKey, metadata: { someOtherField: 'x' } },
        { id: idNonObject, metadata: 'not-an-object' },
      ] as any);

      const results = await service.getThumbnails(
        baseQuery([idNullMeta, idNoKey, idNonObject]),
        'user-1',
        ownPerms,
      );

      expect(results).toEqual([
        { id: idNullMeta, thumbnailUrl: null },
        { id: idNoKey, thumbnailUrl: null },
        { id: idNonObject, thumbnailUrl: null },
      ]);
      expect(mockPrisma.storageObject.findMany).not.toHaveBeenCalled();
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('dedups two items sharing the same key: one storageObject query, one getProviderFor call, both items signed', async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      const key = 'thumbs/shared.jpg';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: idA, metadata: { thumbnailStorageKey: key } },
        { id: idB, metadata: { thumbnailStorageKey: key } },
      ] as any);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: key, storageProvider: 's3', bucket: 'bucket-a' },
      ]);
      const signedUrl = jest.fn().mockResolvedValue('https://cdn.example.com/shared-signed.jpg');
      mockResolver.getProviderFor.mockResolvedValue({ getSignedDownloadUrl: signedUrl });

      const results = await service.getThumbnails(baseQuery([idA, idB]), 'user-1', ownPerms);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledTimes(1);
      expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        { id: idA, thumbnailUrl: 'https://cdn.example.com/shared-signed.jpg' },
        { id: idB, thumbnailUrl: 'https://cdn.example.com/shared-signed.jpg' },
      ]);
    });

    it('falls back to the legacy static storage provider when a key has no matching storageObject row', async () => {
      const id = randomUUID();
      const key = 'thumbs/orphan.jpg';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id, metadata: { thumbnailStorageKey: key } },
      ] as any);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]); // no matching row
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://cdn.example.com/orphan-signed.jpg',
      );

      const results = await service.getThumbnails(baseQuery([id]), 'user-1', ownPerms);

      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(key);
      expect(results).toEqual([{ id, thumbnailUrl: 'https://cdn.example.com/orphan-signed.jpg' }]);
    });

    it('swallows a signing error from the resolved provider and returns thumbnailUrl: null', async () => {
      const id = randomUUID();
      const key = 'thumbs/broken.jpg';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id, metadata: { thumbnailStorageKey: key } },
      ] as any);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: key, storageProvider: 's3', bucket: 'bucket-a' },
      ]);
      const signedUrl = jest.fn().mockRejectedValue(new Error('S3 error'));
      mockResolver.getProviderFor.mockResolvedValue({ getSignedDownloadUrl: signedUrl });

      const results = await service.getThumbnails(baseQuery([id]), 'user-1', ownPerms);

      expect(results).toEqual([{ id, thumbnailUrl: null }]);
    });

    it('swallows a signing error from the legacy fallback provider and returns thumbnailUrl: null', async () => {
      const id = randomUUID();
      const key = 'thumbs/orphan-broken.jpg';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id, metadata: { thumbnailStorageKey: key } },
      ] as any);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
      mockStorageProvider.getSignedDownloadUrl.mockRejectedValue(new Error('S3 error'));

      const results = await service.getThumbnails(baseQuery([id]), 'user-1', ownPerms);

      expect(results).toEqual([{ id, thumbnailUrl: null }]);
    });

    it('resolves distinct provider/bucket pairs independently for two different keys', async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      const keyA = 'thumbs/a.jpg';
      const keyB = 'thumbs/b.jpg';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: idA, metadata: { thumbnailStorageKey: keyA } },
        { id: idB, metadata: { thumbnailStorageKey: keyB } },
      ] as any);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: keyA, storageProvider: 's3', bucket: 'bucket-a' },
        { storageKey: keyB, storageProvider: 'r2', bucket: 'bucket-b' },
      ]);

      const signA = jest.fn().mockResolvedValue('https://cdn.example.com/a-signed.jpg');
      const signB = jest.fn().mockResolvedValue('https://cdn.example.com/b-signed.jpg');
      mockResolver.getProviderFor.mockImplementation(async (provider: string) => {
        if (provider === 's3') return { getSignedDownloadUrl: signA };
        if (provider === 'r2') return { getSignedDownloadUrl: signB };
        throw new Error(`unexpected provider ${provider}`);
      });

      const results = await service.getThumbnails(baseQuery([idA, idB]), 'user-1', ownPerms);

      expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(2);
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-a');
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'bucket-b');
      expect(results).toEqual([
        { id: idA, thumbnailUrl: 'https://cdn.example.com/a-signed.jpg' },
        { id: idB, thumbnailUrl: 'https://cdn.example.com/b-signed.jpg' },
      ]);
      expect(signA).toHaveBeenCalledWith(keyA);
      expect(signB).toHaveBeenCalledWith(keyB);
    });
  });

  // -------------------------------------------------------------------------
  // mediaThumbnailsQuerySchema (DTO-level validation)
  // -------------------------------------------------------------------------

  describe('mediaThumbnailsQuerySchema', () => {
    // circleId must itself be a valid uuid per the schema — CIRCLE_ID (the
    // mock constant used elsewhere in this file) is not, so use a real one.
    const validCircleId = randomUUID();

    it('parses a valid comma-separated ids string into a string array', () => {
      const idA = randomUUID();
      const idB = randomUUID();
      const result = mediaThumbnailsQuerySchema.safeParse({
        circleId: validCircleId,
        ids: `${idA},${idB}`,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ids).toEqual([idA, idB]);
      }
    });

    it('fails when more than 200 ids are supplied', () => {
      const ids = Array.from({ length: 201 }, () => randomUUID()).join(',');
      const result = mediaThumbnailsQuerySchema.safeParse({ circleId: validCircleId, ids });
      expect(result.success).toBe(false);
    });

    it('fails when the id list reduces to 0 entries after trim/filter', () => {
      const result = mediaThumbnailsQuerySchema.safeParse({
        circleId: validCircleId,
        ids: '  ,  ,',
      });
      expect(result.success).toBe(false);
    });

    it('fails when an entry is not a valid uuid', () => {
      const result = mediaThumbnailsQuerySchema.safeParse({
        circleId: validCircleId,
        ids: `${randomUUID()},not-a-uuid`,
      });
      expect(result.success).toBe(false);
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
        set: { favorite: true },
        ...overrides,
      };
    }

    it('assertAllInCircle rejects (NotFoundException) when not all ids belong to circle', async () => {
      const ids = makeIds(3);
      const dto = makeBulkUpdateDto({ ids, set: { favorite: true } });
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
        // A manual bulk location SET must always write coordSource:'manual' —
        // never 'inferred' — so location-inference provenance can never leak
        // onto a human-entered coordinate. See applyLocation() in
        // media/geo/apply-location.util.ts.
        coordSource: 'manual',
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
        // A bulk location CLEAR must always write coordSource:null — no
        // leftover provenance value should survive a clear. See
        // GEO_CLEAR_COLUMNS in media/geo/geo-result.mapper.ts.
        coordSource: null,
      });
    });

    it('updates favorite only (no location)', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({
        ids,
        set: { favorite: true },
      });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      expect(mockGeoProvider.reverseGeocode).not.toHaveBeenCalled();
      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toMatchObject({
        favorite: true,
      });
    });

    it('returns { updated: count }', async () => {
      const ids = makeIds(3);
      const dto = makeBulkUpdateDto({ ids, set: { favorite: false } });

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

    it('sets capturedAt in updateMany data when set.capturedAt is a Date', async () => {
      const ids = makeIds(2);
      const capturedAt = new Date('2024-06-15T10:00:00.000Z');
      const dto = makeBulkUpdateDto({ ids, set: { capturedAt } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toMatchObject({ capturedAt });
    });

    it('sets capturedAt: null in updateMany data when set.capturedAt is null (clear)', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({ ids, set: { capturedAt: null } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toHaveProperty('capturedAt', null);
    });

    it('includes both favorite and capturedAt in updateMany data when both are set', async () => {
      const ids = makeIds(2);
      const capturedAt = new Date('2023-12-25T08:30:00.000Z');
      const dto = makeBulkUpdateDto({ ids, set: { favorite: true, capturedAt } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).toMatchObject({ favorite: true, capturedAt });
    });

    it('does not include capturedAt key in updateMany data when set.capturedAt is absent', async () => {
      const ids = makeIds(2);
      const dto = makeBulkUpdateDto({ ids, set: { favorite: true } });

      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );
      mockPrisma.mediaItem.updateMany.mockResolvedValue({ count: 2 });

      await service.bulkUpdateMedia(dto, 'user-1', ownPerms);

      const [updateCall] = (mockPrisma.mediaItem.updateMany as jest.Mock).mock.calls;
      expect(updateCall[0].data).not.toHaveProperty('capturedAt');
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
  // bulkRerunTags / bulkRerunFaces / bulkRerunThumbnails
  // -------------------------------------------------------------------------

  describe('bulkRerunTags', () => {
    function makeBulkRerunDto(overrides: Partial<any> = {}): any {
      return {
        circleId: CIRCLE_ID,
        ids: [randomUUID(), randomUUID()],
        ...overrides,
      };
    }

    it('throws ForbiddenException when assertCircleAccess rejects and enqueues nothing', async () => {
      const dto = makeBulkRerunDto();
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Insufficient circle role'),
      );

      await expect(
        service.bulkRerunTags(dto, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockMediaEnrichmentService.enqueueTagRerun).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when not all ids belong to the circle and enqueues nothing', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      // assertAllInCircle's findMany returns only 2 of 3 ids
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: ids[0] },
        { id: ids[1] },
      ] as any);

      await expect(
        service.bulkRerunTags(dto, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);

      expect(mockMediaEnrichmentService.enqueueTagRerun).not.toHaveBeenCalled();
    });

    it('calls assertCircleAccess with role "collaborator"', async () => {
      const ids = [randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );

      await service.bulkRerunTags(dto, 'user-1', ownPerms);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        CIRCLE_ID,
        ownPerms,
        'collaborator',
      );
    });

    it('enqueues a tag rerun per id via enqueueTagRerun and returns { queued: N }', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );

      const result = await service.bulkRerunTags(dto, 'user-1', ownPerms);

      expect(mockMediaEnrichmentService.enqueueTagRerun).toHaveBeenCalledTimes(3);
      for (const id of ids) {
        expect(mockMediaEnrichmentService.enqueueTagRerun).toHaveBeenCalledWith({
          id,
          circleId: CIRCLE_ID,
        });
      }
      expect(result).toEqual({ queued: 3 });
    });
  });

  describe('bulkRerunFaces', () => {
    function makeBulkRerunDto(overrides: Partial<any> = {}): any {
      return {
        circleId: CIRCLE_ID,
        ids: [randomUUID(), randomUUID()],
        ...overrides,
      };
    }

    it('throws ForbiddenException when assertCircleAccess rejects and enqueues nothing', async () => {
      const dto = makeBulkRerunDto();
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Insufficient circle role'),
      );

      await expect(
        service.bulkRerunFaces(dto, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockMediaEnrichmentService.enqueueFaceRerun).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when not all ids belong to the circle and enqueues nothing', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      // assertAllInCircle's findMany returns only 2 of 3 ids — bulkRerunFaces
      // must never reach its own routing findMany call.
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: ids[0] },
        { id: ids[1] },
      ] as any);

      await expect(
        service.bulkRerunFaces(dto, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);

      expect(mockMediaEnrichmentService.enqueueFaceRerun).not.toHaveBeenCalled();
    });

    it('fetches item types via prisma.mediaItem.findMany scoped to circle + non-deleted', async () => {
      const ids = [randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      // Single mock backs both the assertAllInCircle existence check and the
      // routing fetch — both only require an `id` field to satisfy the
      // former, and this response additionally carries `type` for the latter.
      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id, type: 'photo' })) as any,
      );

      await service.bulkRerunFaces(dto, 'user-1', ownPerms);

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: ids },
            circleId: CIRCLE_ID,
            deletedAt: null,
          }),
          select: { id: true, type: true },
        }),
      );
    });

    it('routes a mix of photo and video items to enqueueFaceRerun with correct type per item', async () => {
      const photoId = randomUUID();
      const videoId = randomUUID();
      const dto = makeBulkRerunDto({ ids: [photoId, videoId] });

      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: photoId, type: 'photo' },
        { id: videoId, type: 'video' },
      ] as any);

      const result = await service.bulkRerunFaces(dto, 'user-1', ownPerms);

      expect(mockMediaEnrichmentService.enqueueFaceRerun).toHaveBeenCalledTimes(2);
      expect(mockMediaEnrichmentService.enqueueFaceRerun).toHaveBeenCalledWith({
        id: photoId,
        type: 'photo',
        circleId: CIRCLE_ID,
      });
      expect(mockMediaEnrichmentService.enqueueFaceRerun).toHaveBeenCalledWith({
        id: videoId,
        type: 'video',
        circleId: CIRCLE_ID,
      });
      expect(result).toEqual({ queued: 2 });
    });

    it('returns { queued } reflecting the number of items actually fetched/routed', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      // assertAllInCircle sees all 3 (passes the guard), but the routing
      // findMany call in this mock also returns all 3 with types.
      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id, type: 'photo' })) as any,
      );

      const result = await service.bulkRerunFaces(dto, 'user-1', ownPerms);

      expect(result).toEqual({ queued: 3 });
      expect(mockMediaEnrichmentService.enqueueFaceRerun).toHaveBeenCalledTimes(3);
    });
  });

  describe('bulkRerunThumbnails', () => {
    function makeBulkRerunDto(overrides: Partial<any> = {}): any {
      return {
        circleId: CIRCLE_ID,
        ids: [randomUUID(), randomUUID()],
        ...overrides,
      };
    }

    it('throws ForbiddenException when assertCircleAccess rejects and enqueues nothing', async () => {
      const dto = makeBulkRerunDto();
      mockCircleMembershipService.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('Insufficient circle role'),
      );

      await expect(
        service.bulkRerunThumbnails(dto, 'user-1', ownPerms),
      ).rejects.toThrow(ForbiddenException);

      expect(mockMediaEnrichmentService.enqueueThumbnailRerun).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when not all ids belong to the circle and enqueues nothing', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        { id: ids[0] },
        { id: ids[1] },
      ] as any);

      await expect(
        service.bulkRerunThumbnails(dto, 'user-1', ownPerms),
      ).rejects.toThrow(NotFoundException);

      expect(mockMediaEnrichmentService.enqueueThumbnailRerun).not.toHaveBeenCalled();
    });

    it('enqueues a thumbnail rerun per id via enqueueThumbnailRerun and returns { queued: N }', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const dto = makeBulkRerunDto({ ids });
      mockPrisma.mediaItem.findMany.mockResolvedValue(
        ids.map((id) => ({ id })) as any,
      );

      const result = await service.bulkRerunThumbnails(dto, 'user-1', ownPerms);

      expect(mockMediaEnrichmentService.enqueueThumbnailRerun).toHaveBeenCalledTimes(3);
      for (const id of ids) {
        expect(mockMediaEnrichmentService.enqueueThumbnailRerun).toHaveBeenCalledWith({
          id,
          circleId: CIRCLE_ID,
        });
      }
      expect(result).toEqual({ queued: 3 });
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
      // AND-composition: cameraMake lives inside where.AND[n]
      expect(inAnd(call[0].where, 'cameraMake')).toMatchObject({
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
      // AND-composition: cameraModel lives inside where.AND[n]
      expect(inAnd(call[0].where, 'cameraModel')).toMatchObject({
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
      // AND-composition: sourceDeviceName lives inside where.AND[n]
      expect(inAnd(call[0].where, 'sourceDeviceName')).toMatchObject({
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
      // AND-composition: sourceDeviceId lives inside where.AND[n]
      const entry = inAnd(call[0].where, 'sourceDeviceId');
      expect(entry).toMatchObject({ sourceDeviceId: 'dev-123' });
      // Exact match — NOT wrapped in { contains: ... }
      expect(entry.sourceDeviceId).toBe('dev-123');
    });

    it('missingGeo:true → { takenLat: null, takenLng: null } in where', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, missingGeo: true },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // AND-composition: takenLat/takenLng live inside where.AND[n]
      expect(inAnd(call[0].where, 'takenLat')).toMatchObject({ takenLat: null, takenLng: null });
    });

    it('missingGeo:false → { takenLat: { not: null }, takenLng: { not: null } } in where', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, missingGeo: false },
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // AND-composition: takenLat/takenLng live inside where.AND[n]
      expect(inAnd(call[0].where, 'takenLat')).toMatchObject({
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
      // systemSettings for burst config
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      // Promise.all: onThisDay hydration skipped (empty ids), recent, favorites
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([]) // recent
        .mockResolvedValueOnce([]); // favorites
      // count calls: total, missingGeo
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(10);
      // burstGroup count
      mockPrisma.burstGroup.count.mockResolvedValue(0);

      const result = await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      expect(result).toHaveProperty('onThisDay');
      expect(result).toHaveProperty('recent');
      expect(result).toHaveProperty('favorites');
      expect(result).toHaveProperty('counts');
      expect(result.counts).toMatchObject({
        total: 100,
        missingGeo: 10,
      });
    });

    it('getDashboard passes correct where to count queries', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(50)  // total
        .mockResolvedValueOnce(7);  // missingGeo
      mockPrisma.burstGroup.count.mockResolvedValue(0);

      await service.getDashboard(dashboardQuery, 'user-1', ownPerms);

      const countCalls = (mockPrisma.mediaItem.count as jest.Mock).mock.calls;

      // All count calls must include circleId and deletedAt: null
      for (const call of countCalls) {
        expect(call[0].where).toMatchObject({
          circleId: CIRCLE_ID,
          deletedAt: null,
        });
      }

      // Verify missingGeo filter
      const allWheres = countCalls.map((c: any) => c[0].where);
      const missingGeoWhere = allWheres.find(
        (w: any) => w.takenLat === null,
      );

      expect(missingGeoWhere).toBeDefined();
    });

    it('onThisDay uses $queryRaw and hydrates ids via findMany', async () => {
      const mediaId = randomUUID();
      const item = makeMediaItem({ id: mediaId });

      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ id: mediaId }]);
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      // First findMany call is for onThisDay hydration, then recent, then favorites
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([item] as any) // onThisDay hydration
        .mockResolvedValueOnce([])            // recent
        .mockResolvedValueOnce([]);           // favorites
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(1)  // total
        .mockResolvedValueOnce(0); // missingGeo
      mockPrisma.burstGroup.count.mockResolvedValue(0);

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
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([])  // recent
        .mockResolvedValueOnce([]); // favorites
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(0)  // total
        .mockResolvedValueOnce(0); // missingGeo
      mockPrisma.burstGroup.count.mockResolvedValue(0);

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
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.mediaItem.findMany
        .mockResolvedValueOnce([])  // recent
        .mockResolvedValueOnce([]); // favorites
      mockPrisma.mediaItem.count
        .mockResolvedValueOnce(0)  // total
        .mockResolvedValueOnce(0); // missingGeo
      mockPrisma.burstGroup.count.mockResolvedValue(0);

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

    it('includes faces.some.personId.in in the where clause when personId is provided (via wherePeople)', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, personId: 'person-uuid-123' } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        faces: { some: { personId: { in: ['person-uuid-123'] } } },
      });
    });

    it('omits the faces filter when personId is not provided', async () => {
      await service.listMedia({ ...defaultMediaQuery } as any, 'user-1', ownPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.faces).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listMedia — personIds multi-person filter
  // -------------------------------------------------------------------------

  describe('listMedia — personIds multi-person filter', () => {
    const PERSON_A = '11111111-1111-1111-1111-111111111111';
    const PERSON_B = '22222222-2222-2222-2222-222222222222';

    beforeEach(() => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);
    });

    it('uses OR (faces.some.personId.in) when peopleMatch is "any"', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, personIds: [PERSON_A, PERSON_B], peopleMatch: 'any' } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        faces: { some: { personId: { in: [PERSON_A, PERSON_B] } } },
      });
    });

    it('uses AND clause when peopleMatch is "all"', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, personIds: [PERSON_A, PERSON_B], peopleMatch: 'all' } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        AND: [
          { faces: { some: { personId: PERSON_A } } },
          { faces: { some: { personId: PERSON_B } } },
        ],
      });
    });

    it('defaults to "any" mode when peopleMatch is omitted', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, personIds: [PERSON_A, PERSON_B] } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // Default 'any' → OR via personId.in
      expect(call[0].where).toMatchObject({
        faces: { some: { personId: { in: [PERSON_A, PERSON_B] } } },
      });
    });

    it('personIds takes precedence over single personId when both provided', async () => {
      await service.listMedia(
        {
          ...defaultMediaQuery,
          personId: PERSON_A,
          personIds: [PERSON_A, PERSON_B],
          peopleMatch: 'any',
        } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      // personIds wins: both persons in the IN clause
      expect(call[0].where).toMatchObject({
        faces: { some: { personId: { in: [PERSON_A, PERSON_B] } } },
      });
    });

    it('falls back to single personId when personIds is empty', async () => {
      await service.listMedia(
        { ...defaultMediaQuery, personId: PERSON_A, personIds: [] } as any,
        'user-1',
        ownPerms,
      );

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where).toMatchObject({
        faces: { some: { personId: { in: [PERSON_A] } } },
      });
    });

    it('omits faces filter when both personId and personIds are absent', async () => {
      await service.listMedia({ ...defaultMediaQuery } as any, 'user-1', ownPerms);

      const [call] = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.faces).toBeUndefined();
      // listMedia always adds { archivedAt: null } to AND (browse surfaces exclude archived by default).
      // Verify that no AND entry adds a faces filter.
      const and = (call[0].where.AND as any[]) ?? [];
      expect(and.some((c: any) => 'faces' in c)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // signThumb — via getMedia so we can exercise the private method
  // -------------------------------------------------------------------------

  describe('signThumb (via getMedia thumbnailUrl)', () => {
    it('routes signing through resolver.getProviderFor when the thumbnail StorageObject row exists', async () => {
      const item = makeMediaItem({
        metadata: { thumbnailStorageKey: 'thumbnails/obj-1.jpg' },
      });
      const r2MockProvider = { getSignedDownloadUrl: jest.fn().mockResolvedValue('https://r2.example.com/signed') };

      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        ...item,
        mediaTags: [],
      } as any);
      // getMedia calls storageObject.findUnique twice:
      //   1. to get the original object's storageKey (for downloadUrl)
      //   2. inside signThumb to look up the thumbnail object's provider+bucket
      // We use mockResolvedValueOnce for the first call and mockResolvedValue for subsequent calls.
      mockPrisma.storageObject.findUnique
        .mockResolvedValueOnce({ storageKey: 'uploads/photo.jpg' } as any)   // original object
        .mockResolvedValue({ storageProvider: 'r2', bucket: 'r2-bucket' } as any); // thumbnail lookup

      mockResolver.getProviderFor.mockResolvedValue(r2MockProvider);

      const result = await service.getMedia(item.id, 'user-1', anyPerms);

      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'r2-bucket');
      expect(r2MockProvider.getSignedDownloadUrl).toHaveBeenCalledWith('thumbnails/obj-1.jpg');
      expect(result.thumbnailUrl).toBe('https://r2.example.com/signed');
    });

    it('falls back to the static storageProvider when the thumbnail StorageObject row does not exist', async () => {
      const item = makeMediaItem({
        metadata: { thumbnailStorageKey: 'thumbnails/obj-missing.jpg' },
      });

      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        ...item,
        mediaTags: [],
      } as any);
      // First findUnique: download-URL object not found (null → downloadUrl=null, resolver skipped);
      // second: thumbnail lookup also returns null → falls back to storageProvider.
      mockPrisma.storageObject.findUnique
        .mockResolvedValueOnce(null)   // download-URL object absent
        .mockResolvedValue(null);       // thumbnail row not found

      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://s3.example.com/fallback');

      const result = await service.getMedia(item.id, 'user-1', anyPerms);

      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'thumbnails/obj-missing.jpg',
      );
      expect(result.thumbnailUrl).toBe('https://s3.example.com/fallback');
    });

    it('returns null thumbnailUrl when metadata has no thumbnailStorageKey', async () => {
      const item = makeMediaItem({ metadata: null });

      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        ...item,
        mediaTags: [],
      } as any);
      mockPrisma.storageObject.findUnique.mockResolvedValue({ storageKey: 'uploads/photo.jpg' } as any);

      const result = await service.getMedia(item.id, 'user-1', anyPerms);

      // resolver.getProviderFor IS called for the download-URL path (FIX 1); we only
      // assert on the thumbnail outcome here.
      expect(result.thumbnailUrl).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getMedia — downloadUrl per-object provider routing (FIX 1)
  // -------------------------------------------------------------------------

  describe('getMedia — downloadUrl provider routing', () => {
    it('routes the download URL through resolver.getProviderFor using the per-object storageProvider and bucket', async () => {
      const item = makeMediaItem({ addedById: 'user-1' });
      const routedProvider = {
        getSignedDownloadUrl: jest.fn().mockResolvedValue('https://r2.example/signed'),
      };

      mockPrisma.mediaItem.findUnique.mockResolvedValue({ ...item, mediaTags: [] } as any);
      // Return a storage object that belongs to the 'r2' provider in bucket 'my-r2-bucket'
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        storageKey: 'uploads/photo.jpg',
        storageProvider: 'r2',
        bucket: 'my-r2-bucket',
      } as any);
      mockResolver.getProviderFor.mockResolvedValue(routedProvider);

      const result = await service.getMedia(item.id, 'user-1', ownPerms);

      // resolver.getProviderFor must be called with the per-object provider and bucket
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'my-r2-bucket');
      // the returned downloadUrl comes from the routed provider, not the default injected one
      expect(result.downloadUrl).toBe('https://r2.example/signed');
      // the default injected storageProvider.getSignedDownloadUrl was NOT used for the download key
      // (item.metadata is null so signThumb is a no-op and the fallback is also not triggered)
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalledWith('uploads/photo.jpg');
    });
  });

  // -------------------------------------------------------------------------
  // createMedia — upload enrichment trigger (direct service call replacing event emission)
  // -------------------------------------------------------------------------

  describe('createMedia — upload enrichment enqueue', () => {
    it('calls enqueueUploadEnrichment with the created item fields after a successful create', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1' });
      const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null); // not already linked
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

      expect(mockMediaEnrichmentService.enqueueUploadEnrichment).toHaveBeenCalledTimes(1);
      expect(mockMediaEnrichmentService.enqueueUploadEnrichment).toHaveBeenCalledWith(
        expect.objectContaining({
          id: createdItem.id,
          type: createdItem.type,
          circleId: createdItem.circleId,
        }),
      );
    });

    it('does NOT call enqueueUploadEnrichment on the dedup path (pre-check finds an existing item)', async () => {
      const storageObject = makeStorageObject({ uploadedById: 'user-1', storageKey: 'uploads/dup.jpg' });
      const existingItem = makeMediaItem({ addedById: 'user-1', contentHash: TEST_HASH });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      // not already linked by storageObjectId
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      // dedup pre-check: existing item with same hash found → short-circuits before create
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

      // Dedup hit must be returned
      expect(result.deduplicated).toBe(true);
      expect(result.id).toBe(existingItem.id);
      // Enrichment must NOT be triggered on the dedup path
      expect(mockMediaEnrichmentService.enqueueUploadEnrichment).not.toHaveBeenCalled();
    });
  });
});

