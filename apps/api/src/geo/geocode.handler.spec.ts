/**
 * Unit tests for GeocodeHandler.
 *
 * Tests:
 *   - skips/no-ops when job.mediaItemId is null
 *   - sets status to failed when mediaItem not found or soft-deleted
 *   - when takenLat/takenLng is null: marks status processed without calling geocoder
 *   - on success: writes geo* columns + geocodedAt + geoSource and sets status processed
 *   - on provider exception: sets status failed + lastError and re-throws
 *   - does not download the image (no storage/image calls)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob, JobReason, JobStatus, MediaMetadataStatusType } from '@prisma/client';
import { GeocodeHandler } from './geocode.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { GeoLocationService } from '../media/geo/geo-location.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'geocode',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.backfill,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeocodeHandler', () => {
  let handler: GeocodeHandler;
  let mockPrisma: MockPrismaService;
  let mockGeoLocationService: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    mockGeoLocationService = { reverseGeocode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeocodeHandler,
        EnrichmentHandlerRegistry,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GeoLocationService, useValue: mockGeoLocationService },
      ],
    }).compile();

    // Trigger OnModuleInit so the handler registers itself
    await module.init();

    handler = module.get<GeocodeHandler>(GeocodeHandler);
  });

  // -------------------------------------------------------------------------
  // type constant
  // -------------------------------------------------------------------------

  describe('type', () => {
    it("has type 'geocode'", () => {
      expect(handler.type).toBe('geocode');
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — registers with EnrichmentHandlerRegistry
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    it('registers itself in the EnrichmentHandlerRegistry', async () => {
      const module = await Test.createTestingModule({
        providers: [
          GeocodeHandler,
          EnrichmentHandlerRegistry,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: GeoLocationService, useValue: mockGeoLocationService },
        ],
      }).compile();

      await module.init();

      const registry = module.get<EnrichmentHandlerRegistry>(EnrichmentHandlerRegistry);
      expect(registry.get('geocode')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // No-op when mediaItemId is null
  // -------------------------------------------------------------------------

  describe('when job.mediaItemId is null', () => {
    it('returns without touching the DB or geocoder', async () => {
      const job = makeJob({ mediaItemId: null });

      await handler.process(job);

      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
      expect(mockPrisma.mediaGeocodeStatus.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // MediaItem not found
  // -------------------------------------------------------------------------

  describe('when mediaItem is not found', () => {
    it('upserts status=failed and returns without throwing', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await handler.process(makeJob());

      const upsertCall = mockPrisma.mediaGeocodeStatus.upsert.mock.calls[0][0];
      expect(upsertCall.create.status).toBe(MediaMetadataStatusType.failed);
      expect(upsertCall.create.lastError).toBeTruthy();
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // MediaItem soft-deleted
  // -------------------------------------------------------------------------

  describe('when mediaItem is soft-deleted', () => {
    it('upserts status=failed and returns without throwing', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat: 9.9,
        takenLng: -84.0,
        circleId: 'circle-1',
        deletedAt: new Date(),
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await handler.process(makeJob());

      const upsertCall = mockPrisma.mediaGeocodeStatus.upsert.mock.calls[0][0];
      expect(upsertCall.create.status).toBe(MediaMetadataStatusType.failed);
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No GPS coordinates
  // -------------------------------------------------------------------------

  describe('when mediaItem has null takenLat/takenLng', () => {
    it('marks status processed without calling the geocoder', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat: null,
        takenLng: null,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await handler.process(makeJob());

      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();

      // Status should be marked processed
      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      const finalStatus = calls[calls.length - 1][0];
      expect(finalStatus.update.status).toBe(MediaMetadataStatusType.processed);
    });

    it('does not update mediaItem geo columns', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat: null,
        takenLng: null,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await handler.process(makeJob());

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-finite GPS coordinates (NaN slips past a plain null check)
  // -------------------------------------------------------------------------

  describe('when mediaItem has non-finite takenLat/takenLng', () => {
    it.each([
      ['NaN lat', NaN, -84.0907],
      ['NaN lng', 9.9281, NaN],
      ['both NaN', NaN, NaN],
      ['Infinity lat', Infinity, -84.0907],
    ])('marks status processed without calling the geocoder for %s', async (_label, takenLat, takenLng) => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat,
        takenLng,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);

      await handler.process(makeJob());

      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();

      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      const finalStatus = calls[calls.length - 1][0];
      expect(finalStatus.update.status).toBe(MediaMetadataStatusType.processed);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — successful geocoding
  // -------------------------------------------------------------------------

  describe('when geocoding succeeds', () => {
    const mediaItem = {
      id: 'media-1',
      takenLat: 9.9281,
      takenLng: -84.0907,
      circleId: 'circle-1',
      deletedAt: null,
    };

    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(mediaItem as any);
      mockPrisma.mediaItem.update.mockResolvedValue({} as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
    });

    it('calls GeoLocationService.reverseGeocode with lat/lng', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: {
          country: 'Costa Rica',
          countryCode: 'CR',
          admin1: 'Alajuela',
          admin2: 'San Carlos',
          locality: 'La Fortuna',
          placeName: 'La Fortuna, Costa Rica',
        },
        source: 'geonames-offline',
      });

      await handler.process(makeJob());

      expect(mockGeoLocationService.reverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
    });

    it('writes all geo columns to the media item', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: {
          country: 'Costa Rica',
          countryCode: 'CR',
          admin1: 'Alajuela',
          admin2: 'San Carlos',
          locality: 'La Fortuna',
          placeName: 'La Fortuna, Costa Rica',
        },
        source: 'geonames-offline',
      });

      await handler.process(makeJob());

      const updateCall = mockPrisma.mediaItem.update.mock.calls[0][0];
      expect(updateCall.data.geoCountry).toBe('Costa Rica');
      expect(updateCall.data.geoCountryCode).toBe('CR');
      expect(updateCall.data.geoAdmin1).toBe('Alajuela');
      expect(updateCall.data.geoAdmin2).toBe('San Carlos');
      expect(updateCall.data.geoLocality).toBe('La Fortuna');
      expect(updateCall.data.geoPlaceName).toBe('La Fortuna, Costa Rica');
    });

    it('writes geoSource and a non-null geocodedAt', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: { country: 'CR', locality: 'X', placeName: 'X, CR' },
        source: 'geonames-offline',
      });

      await handler.process(makeJob());

      const updateCall = mockPrisma.mediaItem.update.mock.calls[0][0];
      expect(updateCall.data.geoSource).toBe('geonames-offline');
      expect(updateCall.data.geocodedAt).toBeInstanceOf(Date);
    });

    it('sets status=processed after a successful run', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: { country: 'CR', locality: 'X', placeName: 'X, CR' },
        source: 'google',
      });

      await handler.process(makeJob());

      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      const finalCall = calls[calls.length - 1][0];
      expect(finalCall.update.status).toBe(MediaMetadataStatusType.processed);
    });

    it('does not download the image (no storage object lookups)', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: { country: 'CR' },
        source: 'geonames-offline',
      });

      await handler.process(makeJob());

      // The handler reads takenLat/takenLng from the already-loaded mediaItem row;
      // it must not fetch the storage object (no image download required for geocoding).
      expect(mockPrisma.storageObject.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.findFirst).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Provider returns null result
  // -------------------------------------------------------------------------

  describe('when geocoder returns null result', () => {
    it('does not update mediaItem geo columns', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat: 0,
        takenLng: 0,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: null,
        source: 'geonames-offline',
      });

      await handler.process(makeJob());

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('still sets status=processed', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat: 0,
        takenLng: 0,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: null,
        source: 'geonames-offline',
      });

      await handler.process(makeJob());

      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      const finalCall = calls[calls.length - 1][0];
      expect(finalCall.update.status).toBe(MediaMetadataStatusType.processed);
    });
  });

  // -------------------------------------------------------------------------
  // Provider exception
  // -------------------------------------------------------------------------

  describe('when geocoder throws', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        takenLat: 9.9281,
        takenLng: -84.0907,
        circleId: 'circle-1',
        deletedAt: null,
      } as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
      mockGeoLocationService.reverseGeocode.mockRejectedValue(new Error('Provider exploded'));
    });

    it('upserts status=failed with lastError', async () => {
      await expect(handler.process(makeJob())).rejects.toThrow('Provider exploded');

      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      const failedCall = calls[calls.length - 1][0];
      expect(failedCall.update.status).toBe(MediaMetadataStatusType.failed);
      expect(failedCall.update.lastError).toBe('Provider exploded');
    });

    it('re-throws the error so the enrichment worker can retry', async () => {
      await expect(handler.process(makeJob())).rejects.toThrow('Provider exploded');
    });

    it('does not update mediaItem geo columns', async () => {
      await expect(handler.process(makeJob())).rejects.toThrow();

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });
});
