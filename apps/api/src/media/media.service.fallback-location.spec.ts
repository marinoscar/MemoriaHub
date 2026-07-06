/**
 * Unit tests for the fallback-location block inside MediaService.createMedia
 * (apps/api/src/media/media.service.ts, ~lines 229-261).
 *
 * The CLI's per-folder memoriahub.json can supply a FALLBACK takenLat/takenLng
 * (EXIF always wins per field). createMedia must only apply the client-supplied
 * fallback when a FRESH re-read of the just-created row shows EXIF sync did not
 * already write coordinates. Any failure while applying the fallback (including
 * a geoProvider.reverseGeocode throw) must be swallowed and logged, never
 * propagated out of createMedia.
 *
 * Mirrors the beforeEach/module wiring and test factory style used in
 * media.service.spec.ts (see its createMedia describe block) and the smaller,
 * single-purpose file structure used in media.service.locations.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
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
import { MediaUrlSigningService } from './signing/media-url-signing.service';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';

const CIRCLE_ID = 'circle-uuid-0001-0002-0003';

// ---------------------------------------------------------------------------
// Test factories (copied from media.service.spec.ts — not exported there)
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

// Permissions helper
const ownPerms = [
  PERMISSIONS.MEDIA_READ,
  PERMISSIONS.MEDIA_WRITE,
  PERMISSIONS.MEDIA_DELETE,
];

describe('MediaService.createMedia — fallback location', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock; delete: jest.Mock };
  let mockSyncService: jest.Mocked<Pick<MediaMetadataSyncService, 'syncFromStorageObject'>>;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockGeoProvider: { reverseGeocode: jest.Mock };
  let mockForwardGeocodeService: { searchPlaces: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockMediaEnrichmentService: { enqueueUploadEnrichment: jest.Mock; enqueueForStorageObject: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
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
    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue({
        getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
      }),
    };
    mockMediaEnrichmentService = {
      enqueueUploadEnrichment: jest.fn().mockResolvedValue(undefined),
      enqueueForStorageObject: jest.fn().mockResolvedValue(undefined),
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
        { provide: MediaUrlSigningService, useValue: { enabled: false } },
        { provide: MediaEnrichmentService, useValue: mockMediaEnrichmentService },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const FALLBACK_LAT = 37.7749;
  const FALLBACK_LNG = -122.4194;

  function baseDto(overrides: Partial<any> = {}, storageObjectId: string) {
    return {
      storageObjectId,
      type: 'photo' as const,
      source: 'cli' as const,
      originalFilename: 'photo.jpg',
      circleId: CIRCLE_ID,
      ...overrides,
    };
  }

  it('1. applies the fallback location when the fresh re-read shows EXIF did not set coordinates', async () => {
    const storageObject = makeStorageObject({ uploadedById: 'user-1' });
    const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

    mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
    // "already linked" check → null, then fresh post-sync re-read → takenLat null
    mockPrisma.mediaItem.findUnique
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ takenLat: null } as any);
    mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);
    mockPrisma.mediaItem.update.mockResolvedValue({} as any);

    const dto = baseDto(
      { takenLat: FALLBACK_LAT, takenLng: FALLBACK_LNG, takenAltitude: 12.5 },
      storageObject.id,
    );

    const result = await service.createMedia(dto, 'user-1', ownPerms);

    expect(result.deduplicated).toBe(false);
    expect(mockGeoProvider.reverseGeocode).toHaveBeenCalledWith(FALLBACK_LAT, FALLBACK_LNG);
    expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: createdItem.id },
        data: expect.objectContaining({
          takenLat: FALLBACK_LAT,
          takenLng: FALLBACK_LNG,
          coordSource: 'manual',
        }),
      }),
    );
    // Fresh re-read must use the created item's id and select only takenLat
    expect(mockPrisma.mediaItem.findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: createdItem.id },
      select: { takenLat: true },
    });
  });

  it('2. skips the fallback when the fresh re-read shows EXIF already set coordinates', async () => {
    const storageObject = makeStorageObject({ uploadedById: 'user-1' });
    const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

    mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
    mockPrisma.mediaItem.findUnique
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ takenLat: 40.7128 } as any);
    mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

    const dto = baseDto(
      { takenLat: FALLBACK_LAT, takenLng: FALLBACK_LNG },
      storageObject.id,
    );

    const result = await service.createMedia(dto, 'user-1', ownPerms);

    expect(result.deduplicated).toBe(false);
    expect(mockGeoProvider.reverseGeocode).not.toHaveBeenCalled();
    expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
  });

  it('3. never attempts the fresh re-read when the DTO has no fallback coordinates', async () => {
    const storageObject = makeStorageObject({ uploadedById: 'user-1' });
    const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

    mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
    // Only the "already linked" check should occur.
    mockPrisma.mediaItem.findUnique.mockResolvedValueOnce(null as any);
    mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);

    const dto = baseDto({}, storageObject.id);

    await service.createMedia(dto, 'user-1', ownPerms);

    expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledTimes(1);
    expect(mockGeoProvider.reverseGeocode).not.toHaveBeenCalled();
    expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
  });

  it('4. swallows an error thrown while applying the fallback location and still resolves', async () => {
    const storageObject = makeStorageObject({ uploadedById: 'user-1' });
    const createdItem = makeMediaItem({ storageObjectId: storageObject.id });

    mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
    mockPrisma.mediaItem.findUnique
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ takenLat: null } as any);
    mockPrisma.mediaItem.create.mockResolvedValue(createdItem as any);
    mockGeoProvider.reverseGeocode.mockRejectedValue(new Error('geo provider down'));

    const dto = baseDto(
      { takenLat: FALLBACK_LAT, takenLng: FALLBACK_LNG },
      storageObject.id,
    );

    const result = await service.createMedia(dto, 'user-1', ownPerms);

    // createMedia must still resolve successfully with the created item
    expect(result).toMatchObject(createdItem);
    expect(result.deduplicated).toBe(false);
    expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
  });

  it('5. dedup pre-check short-circuits before the fallback-location block runs', async () => {
    const TEST_HASH = 'b'.repeat(64);
    const storageObject = makeStorageObject({ uploadedById: 'user-1', storageKey: 'uploads/new.jpg' });
    const existingItem = makeMediaItem({ addedById: 'user-1', contentHash: TEST_HASH });

    mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
    // "already linked" check on storageObjectId → no match
    mockPrisma.mediaItem.findUnique.mockResolvedValue(null as any);
    // Dedup pre-check by (circleId, contentHash) → existing item found
    mockPrisma.mediaItem.findFirst.mockResolvedValue(existingItem as any);

    const dto = baseDto(
      { contentHash: TEST_HASH, takenLat: FALLBACK_LAT, takenLng: FALLBACK_LNG },
      storageObject.id,
    );

    const result = await service.createMedia(dto, 'user-1', ownPerms);

    expect(result.deduplicated).toBe(true);
    expect(result.id).toBe(existingItem.id);
    // Dedup return happens well before mediaItem.create / the fallback block
    expect(mockPrisma.mediaItem.create).not.toHaveBeenCalled();
    expect(mockGeoProvider.reverseGeocode).not.toHaveBeenCalled();
    expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
  });
});
