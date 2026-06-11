import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaMetadataSyncService } from './media-metadata-sync.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeStorageObject(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    metadata: null,
    ...overrides,
  };
}

function makeMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    metadata: null,
    ...overrides,
  };
}

/**
 * Build a representative _processing block that exercises every mapped field.
 * Values are chosen to be unambiguously typed so the present-only checks pass.
 */
function makeFullProcessingBlock() {
  return {
    'content-hash': {
      sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
    },
    exif: {
      capturedAt: '2023-07-15T10:30:00.000Z',
      capturedAtOffset: -300,
      latitude: 9.9281,
      longitude: -84.0907,
      altitude: 1150.5,
      cameraMake: 'Apple',
      cameraModel: 'iPhone 14 Pro',
      orientation: 1,
    },
    dimensions: {
      width: 4032,
      height: 3024,
    },
    geocode: {
      country: 'Costa Rica',
      countryCode: 'CR',
      admin1: 'San José Province',
      admin2: 'San José Canton',
      locality: 'San José',
      placeName: 'Plaza de la Cultura',
      source: 'nominatim',
      geocodedAt: '2023-07-15T11:00:00.000Z',
    },
    thumbnail: {
      thumbnailObjectId: 'thumb-obj-id-123',
      thumbnailStorageKey: 'thumbs/abc123/thumb.webp',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaMetadataSyncService', () => {
  let service: MediaMetadataSyncService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaMetadataSyncService,
        { provide: PrismaService, useValue: mockPrisma },
        // EventEmitter2 is required by @OnEvent decorator at module init time
        { provide: EventEmitter2, useValue: { on: jest.fn(), emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<MediaMetadataSyncService>(MediaMetadataSyncService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — full _processing block maps to all typed columns
  // -------------------------------------------------------------------------

  describe('happy path: full _processing block', () => {
    it('calls mediaItem.update with all mapped typed columns and merged thumbnail metadata', async () => {
      const processing = makeFullProcessingBlock();
      const storageObjectId = randomUUID();
      const mediaItemId = randomUUID();

      const storageObject = makeStorageObject({
        id: storageObjectId,
        metadata: { _processing: processing },
      });
      const mediaItem = makeMediaItem({
        id: mediaItemId,
        metadata: { existingKey: 'keep-me' },
      });

      // First findUnique: StorageObject
      // Second findUnique: MediaItem by storageObjectId
      // Third findUnique: MediaItem by id (for metadata read-modify-write)
      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique
        .mockResolvedValueOnce(mediaItem as any) // lookup by storageObjectId
        .mockResolvedValueOnce(mediaItem as any); // lookup by id for thumbnail merge
      mockPrisma.mediaItem.update.mockResolvedValue(mediaItem as any);

      await service.syncFromStorageObject(storageObjectId);

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledTimes(1);

      const updateArgs = (mockPrisma.mediaItem.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: mediaItemId });

      const data = updateArgs.data;

      // content-hash
      expect(data.contentHash).toBe(processing['content-hash'].sha256);

      // exif
      expect(data.capturedAt).toEqual(new Date(processing.exif.capturedAt));
      expect(data.capturedAtOffset).toBe(processing.exif.capturedAtOffset);
      expect(data.takenLat).toBe(processing.exif.latitude);
      expect(data.takenLng).toBe(processing.exif.longitude);
      expect(data.takenAltitude).toBe(processing.exif.altitude);
      expect(data.cameraMake).toBe(processing.exif.cameraMake);
      expect(data.cameraModel).toBe(processing.exif.cameraModel);
      expect(data.orientation).toBe(processing.exif.orientation);

      // dimensions
      expect(data.width).toBe(processing.dimensions.width);
      expect(data.height).toBe(processing.dimensions.height);

      // geocode
      expect(data.geoCountry).toBe(processing.geocode.country);
      expect(data.geoCountryCode).toBe(processing.geocode.countryCode);
      expect(data.geoAdmin1).toBe(processing.geocode.admin1);
      expect(data.geoAdmin2).toBe(processing.geocode.admin2);
      expect(data.geoLocality).toBe(processing.geocode.locality);
      expect(data.geoPlaceName).toBe(processing.geocode.placeName);
      expect(data.geoSource).toBe(processing.geocode.source);
      expect(data.geocodedAt).toEqual(new Date(processing.geocode.geocodedAt));

      // thumbnail merged into metadata (preserving existing keys)
      expect(data.metadata).toMatchObject({
        existingKey: 'keep-me',
        thumbnailObjectId: processing.thumbnail.thumbnailObjectId,
        thumbnailStorageKey: processing.thumbnail.thumbnailStorageKey,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Present-only: absent sub-blocks do NOT produce null columns
  // -------------------------------------------------------------------------

  describe('present-only mapping: absent sub-blocks are skipped', () => {
    it('does NOT include exif columns when exif block is absent', async () => {
      const storageObjectId = randomUUID();
      const mediaItemId = randomUUID();

      // Only content-hash is present; no exif, dimensions, geocode, thumbnail
      const storageObject = makeStorageObject({
        id: storageObjectId,
        metadata: {
          _processing: {
            'content-hash': { sha256: 'hashonly' },
          },
        },
      });
      const mediaItem = makeMediaItem({ id: mediaItemId });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(mediaItem as any);
      mockPrisma.mediaItem.update.mockResolvedValue(mediaItem as any);

      await service.syncFromStorageObject(storageObjectId);

      const data = (mockPrisma.mediaItem.update as jest.Mock).mock.calls[0][0].data;

      // content-hash present
      expect(data.contentHash).toBe('hashonly');

      // exif columns must be absent (not explicitly nulled out)
      expect(data).not.toHaveProperty('capturedAt');
      expect(data).not.toHaveProperty('capturedAtOffset');
      expect(data).not.toHaveProperty('takenLat');
      expect(data).not.toHaveProperty('takenLng');
      expect(data).not.toHaveProperty('takenAltitude');
      expect(data).not.toHaveProperty('cameraMake');
      expect(data).not.toHaveProperty('cameraModel');
      expect(data).not.toHaveProperty('orientation');

      // dimensions absent
      expect(data).not.toHaveProperty('width');
      expect(data).not.toHaveProperty('height');

      // geocode absent
      expect(data).not.toHaveProperty('geoCountry');
      expect(data).not.toHaveProperty('geoCountryCode');
      expect(data).not.toHaveProperty('geoAdmin1');
      expect(data).not.toHaveProperty('geoAdmin2');
      expect(data).not.toHaveProperty('geoLocality');
      expect(data).not.toHaveProperty('geoPlaceName');
      expect(data).not.toHaveProperty('geoSource');
      expect(data).not.toHaveProperty('geocodedAt');

      // thumbnail absent
      expect(data).not.toHaveProperty('metadata');
    });

    it('uses video-probe width/height when video-probe block is present (overrides dimensions)', async () => {
      const storageObjectId = randomUUID();
      const mediaItemId = randomUUID();

      const storageObject = makeStorageObject({
        id: storageObjectId,
        metadata: {
          _processing: {
            dimensions: { width: 1280, height: 720 },
            'video-probe': { width: 1920, height: 1080, durationMs: 12345 },
          },
        },
      });
      const mediaItem = makeMediaItem({ id: mediaItemId });

      mockPrisma.storageObject.findUnique.mockResolvedValue(storageObject as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue(mediaItem as any);
      mockPrisma.mediaItem.update.mockResolvedValue(mediaItem as any);

      await service.syncFromStorageObject(storageObjectId);

      const data = (mockPrisma.mediaItem.update as jest.Mock).mock.calls[0][0].data;

      // video-probe overrides dimensions
      expect(data.width).toBe(1920);
      expect(data.height).toBe(1080);
      expect(data.durationMs).toBe(12345);
    });
  });

  // -------------------------------------------------------------------------
  // No linked MediaItem — no update, no throw
  // -------------------------------------------------------------------------

  describe('no linked MediaItem', () => {
    it('does NOT call mediaItem.update and does NOT throw', async () => {
      const storageObjectId = randomUUID();

      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({
          id: storageObjectId,
          metadata: { _processing: makeFullProcessingBlock() },
        }) as any,
      );
      // No MediaItem linked
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(service.syncFromStorageObject(storageObjectId)).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No _processing metadata — no-op, no throw
  // -------------------------------------------------------------------------

  describe('no _processing metadata', () => {
    it('does NOT call mediaItem.update when metadata is null', async () => {
      const storageObjectId = randomUUID();
      const mediaItemId = randomUUID();

      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: storageObjectId, metadata: null }) as any,
      );
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ id: mediaItemId }) as any,
      );

      await expect(service.syncFromStorageObject(storageObjectId)).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('does NOT call mediaItem.update when metadata has no _processing key', async () => {
      const storageObjectId = randomUUID();
      const mediaItemId = randomUUID();

      mockPrisma.storageObject.findUnique.mockResolvedValue(
        makeStorageObject({ id: storageObjectId, metadata: { someOtherKey: true } }) as any,
      );
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({ id: mediaItemId }) as any,
      );

      await expect(service.syncFromStorageObject(storageObjectId)).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('does NOT throw when storageObject is not found', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(service.syncFromStorageObject(randomUUID())).resolves.toBeUndefined();

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });
});
