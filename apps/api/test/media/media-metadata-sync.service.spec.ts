/**
 * Unit / integration-style tests — MediaMetadataSyncService
 *
 * NOTE: This test file uses a mocked PrismaService (no live database).
 * The project's storage.integration.spec.ts and media.integration.spec.ts
 * both follow the mocked-Prisma pattern (useMockDatabase: true), and no
 * test-DB connection string is configured in this environment.  This file
 * mirrors that same convention.
 *
 * Test coverage:
 *   - Full mapping of every _processing block onto MediaItem typed columns
 *   - Present-only semantics: absent block does NOT overwrite existing column
 *   - Graceful no-op when no MediaItem is linked to the StorageObject
 *   - Graceful no-op when StorageObject not found
 *   - Graceful no-op when _processing metadata key is missing
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaMetadataSyncService } from '../../src/media/sync/media-metadata-sync.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  ObjectProcessedEvent,
  OBJECT_PROCESSED_EVENT,
} from '../../src/storage/processing/events/object-processed.event';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const STORAGE_OBJ_ID = 'storage-obj-uuid-001';
const MEDIA_ITEM_ID = 'media-item-uuid-001';

/** Builds a StorageObject with fully-populated _processing metadata */
function makeStorageObjectWithAllProcessors() {
  return {
    id: STORAGE_OBJ_ID,
    metadata: {
      _processing: {
        'content-hash': {
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        exif: {
          capturedAt: '2024-06-15T10:30:00.000Z',
          capturedAtOffset: -360,
          latitude: 9.9281,
          longitude: -84.0907,
          altitude: 1247.5,
          cameraMake: 'Apple',
          cameraModel: 'iPhone 15 Pro',
          orientation: 6,
        },
        dimensions: {
          width: 4032,
          height: 3024,
        },
        geocode: {
          country: 'Costa Rica',
          countryCode: 'CR',
          admin1: 'Alajuela',
          admin2: 'San Carlos',
          locality: 'La Fortuna',
          placeName: 'Arenal Volcano',
          source: 'geonames-offline',
          geocodedAt: '2024-06-15T10:35:00.000Z',
        },
      },
    },
  };
}

/** Builds a StorageObject with video-probe instead of dimensions */
function makeStorageObjectWithVideoProbe() {
  return {
    id: STORAGE_OBJ_ID,
    metadata: {
      _processing: {
        'content-hash': {
          sha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
        'video-probe': {
          durationMs: 12400,
          width: 1920,
          height: 1080,
        },
      },
    },
  };
}

/** Builds a StorageObject with only the content-hash block (no exif/dimensions/geocode) */
function makeStorageObjectHashOnly() {
  return {
    id: STORAGE_OBJ_ID,
    metadata: {
      _processing: {
        'content-hash': {
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    },
  };
}

const THUMB_OBJ_ID = 'thumb-obj-uuid-001';
const THUMB_STORAGE_KEY = `thumbnails/${STORAGE_OBJ_ID}.jpg`;

/** Builds a StorageObject that includes a thumbnail block in _processing */
function makeStorageObjectWithThumbnail() {
  return {
    id: STORAGE_OBJ_ID,
    metadata: {
      _processing: {
        'content-hash': {
          sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        thumbnail: {
          thumbnailObjectId: THUMB_OBJ_ID,
          thumbnailStorageKey: THUMB_STORAGE_KEY,
        },
      },
    },
  };
}

const mockMediaItem = { id: MEDIA_ITEM_ID };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MediaMetadataSyncService', () => {
  let service: MediaMetadataSyncService;
  let prisma: any; // typed as any to allow jest mock calls

  function makePrismaMock() {
    return {
      storageObject: {
        findUnique: jest.fn(),
      },
      mediaItem: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaMetadataSyncService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        EventEmitter2,
      ],
    }).compile();

    service = module.get<MediaMetadataSyncService>(MediaMetadataSyncService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Full mapping — all processor blocks present
  // -------------------------------------------------------------------------

  describe('handleObjectProcessed — full mapping (all processor blocks)', () => {
    beforeEach(() => {
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectWithAllProcessors());
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockResolvedValue({});
    });

    it('should call mediaItem.update once', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      expect(prisma.mediaItem.update).toHaveBeenCalledTimes(1);
    });

    it('should update with the correct where clause', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      expect(prisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: MEDIA_ITEM_ID } }),
      );
    });

    it('should map contentHash from content-hash.sha256', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.contentHash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('should map capturedAt as Date from exif.capturedAt ISO string', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.capturedAt).toEqual(new Date('2024-06-15T10:30:00.000Z'));
    });

    it('should map capturedAtOffset from exif.capturedAtOffset', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.capturedAtOffset).toBe(-360);
    });

    it('should map takenLat from exif.latitude', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.takenLat).toBeCloseTo(9.9281);
    });

    it('should map takenLng from exif.longitude', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.takenLng).toBeCloseTo(-84.0907);
    });

    it('should map takenAltitude from exif.altitude', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.takenAltitude).toBeCloseTo(1247.5);
    });

    it('should map cameraMake from exif.cameraMake', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.cameraMake).toBe('Apple');
    });

    it('should map cameraModel from exif.cameraModel', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.cameraModel).toBe('iPhone 15 Pro');
    });

    it('should map orientation from exif.orientation', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.orientation).toBe(6);
    });

    it('should map width from dimensions.width', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.width).toBe(4032);
    });

    it('should map height from dimensions.height', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.height).toBe(3024);
    });

    it('should map geoCountry from geocode.country', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoCountry).toBe('Costa Rica');
    });

    it('should map geoCountryCode from geocode.countryCode', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoCountryCode).toBe('CR');
    });

    it('should map geoAdmin1 from geocode.admin1', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoAdmin1).toBe('Alajuela');
    });

    it('should map geoAdmin2 from geocode.admin2', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoAdmin2).toBe('San Carlos');
    });

    it('should map geoLocality from geocode.locality', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoLocality).toBe('La Fortuna');
    });

    it('should map geoPlaceName from geocode.placeName', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoPlaceName).toBe('Arenal Volcano');
    });

    it('should map geoSource from geocode.source', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoSource).toBe('geonames-offline');
    });

    it('should map geocodedAt as Date from geocode.geocodedAt ISO string', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geocodedAt).toEqual(new Date('2024-06-15T10:35:00.000Z'));
    });
  });

  // -------------------------------------------------------------------------
  // Video-probe block maps width/height/durationMs
  // -------------------------------------------------------------------------

  describe('handleObjectProcessed — video-probe block', () => {
    beforeEach(() => {
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectWithVideoProbe());
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockResolvedValue({});
    });

    it('should map durationMs from video-probe.durationMs', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.durationMs).toBe(12400);
    });

    it('should map width from video-probe.width', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.width).toBe(1920);
    });

    it('should map height from video-probe.height', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.height).toBe(1080);
    });
  });

  // -------------------------------------------------------------------------
  // Present-only semantics
  // -------------------------------------------------------------------------

  describe('handleObjectProcessed — absent blocks do not overwrite', () => {
    it('should not include capturedAt in update when exif block is absent', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectHashOnly());
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockResolvedValue({});

      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.capturedAt).toBeUndefined();
    });

    it('should not include width in update when neither dimensions nor video-probe block is present', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectHashOnly());
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockResolvedValue({});

      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.width).toBeUndefined();
      expect(data.height).toBeUndefined();
    });

    it('should not include geo columns in update when geocode block is absent', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectHashOnly());
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockResolvedValue({});

      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoCountry).toBeUndefined();
      expect(data.geoLocality).toBeUndefined();
      expect(data.geocodedAt).toBeUndefined();
    });

    it('should not call mediaItem.update when no fields map to a value', async () => {
      // StorageObject with _processing present but no recognised block values
      prisma.storageObject.findUnique.mockResolvedValue({
        id: STORAGE_OBJ_ID,
        metadata: { _processing: {} },
      });
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);

      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      // No fields to update → no DB write
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Graceful no-ops
  // -------------------------------------------------------------------------

  describe('handleObjectProcessed — graceful no-ops', () => {
    it('should no-op gracefully when StorageObject not found', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(null);

      // Should not throw
      await expect(
        service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID)),
      ).resolves.toBeUndefined();

      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should no-op gracefully when no MediaItem is linked', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: STORAGE_OBJ_ID,
        metadata: {
          _processing: {
            'content-hash': { sha256: 'abc123' },
          },
        },
      });
      prisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(
        service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID)),
      ).resolves.toBeUndefined();

      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should no-op gracefully when metadata is null', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: STORAGE_OBJ_ID,
        metadata: null,
      });
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);

      await expect(
        service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID)),
      ).resolves.toBeUndefined();

      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should no-op gracefully when _processing key is missing from metadata', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: STORAGE_OBJ_ID,
        metadata: { someOtherKey: 'value' },
      });
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);

      await expect(
        service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID)),
      ).resolves.toBeUndefined();

      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('should not throw when mediaItem.update rejects (error swallowed)', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectWithAllProcessors());
      prisma.mediaItem.findUnique.mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockRejectedValue(new Error('DB constraint'));

      // Service must swallow errors and not propagate them
      await expect(
        service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID)),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Thumbnail block → MediaItem.metadata merge
  // -------------------------------------------------------------------------

  describe('handleObjectProcessed — thumbnail block', () => {
    beforeEach(() => {
      // findUnique is called twice when thumbnail block is present:
      //   1. to load the StorageObject
      //   2. to read the current MediaItem.metadata before merging
      prisma.storageObject.findUnique.mockResolvedValue(makeStorageObjectWithThumbnail());
      prisma.mediaItem.findUnique
        .mockResolvedValueOnce(mockMediaItem)         // first call: linked media check
        .mockResolvedValueOnce({ id: MEDIA_ITEM_ID, metadata: null }); // second call: read current metadata
      prisma.mediaItem.update.mockResolvedValue({});
    });

    it('should call mediaItem.update once when thumbnail block is present', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      expect(prisma.mediaItem.update).toHaveBeenCalledTimes(1);
    });

    it('should merge thumbnailObjectId into MediaItem.metadata', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.metadata).toMatchObject({ thumbnailObjectId: THUMB_OBJ_ID });
    });

    it('should merge thumbnailStorageKey into MediaItem.metadata', async () => {
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.metadata).toMatchObject({ thumbnailStorageKey: THUMB_STORAGE_KEY });
    });

    it('should preserve existing MediaItem.metadata keys during merge', async () => {
      // Override the second findUnique call so the current metadata has an existing key
      prisma.mediaItem.findUnique
        .mockReset()
        .mockResolvedValueOnce(mockMediaItem)
        .mockResolvedValueOnce({ id: MEDIA_ITEM_ID, metadata: { customKey: 'preserved' } });

      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.metadata).toMatchObject({
        customKey: 'preserved',
        thumbnailObjectId: THUMB_OBJ_ID,
        thumbnailStorageKey: THUMB_STORAGE_KEY,
      });
    });

    it('should not set metadata when thumbnail block is absent', async () => {
      // Use a StorageObject with only the content-hash block
      prisma.storageObject.findUnique.mockReset().mockResolvedValue(makeStorageObjectHashOnly());
      prisma.mediaItem.findUnique.mockReset().mockResolvedValue(mockMediaItem);
      prisma.mediaItem.update.mockResolvedValue({});

      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      const data = prisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.metadata).toBeUndefined();
    });

    it('should not set metadata when thumbnail block has partial fields (missing thumbnailObjectId)', async () => {
      prisma.storageObject.findUnique.mockReset().mockResolvedValue({
        id: STORAGE_OBJ_ID,
        metadata: {
          _processing: {
            thumbnail: { thumbnailStorageKey: THUMB_STORAGE_KEY }, // missing thumbnailObjectId
          },
        },
      });
      prisma.mediaItem.findUnique.mockReset().mockResolvedValue(mockMediaItem);
      // If no other typed fields update, no DB write is expected
      await service.handleObjectProcessed(new ObjectProcessedEvent(STORAGE_OBJ_ID));
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Event constant
  // -------------------------------------------------------------------------

  describe('OBJECT_PROCESSED_EVENT constant', () => {
    it('should equal "storage.object.processed"', () => {
      expect(OBJECT_PROCESSED_EVENT).toBe('storage.object.processed');
    });
  });
});
