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
import { LocationGroupResolverService } from '../location-groups/location-group-resolver.service';

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
  let mockLocationGroupResolver: { resolve: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = createMockPrismaService();
    mockGeoLocationService = { reverseGeocode: jest.fn() };
    // Default: the identity resolver (feature off / no groups configured).
    mockLocationGroupResolver = {
      resolve: jest.fn().mockImplementation((raw) =>
        Promise.resolve({
          geoCanonicalCountry: raw.geoCountry,
          geoCanonicalAdmin1: raw.geoAdmin1,
          geoCanonicalLocality: raw.geoLocality,
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeocodeHandler,
        EnrichmentHandlerRegistry,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GeoLocationService, useValue: mockGeoLocationService },
        { provide: LocationGroupResolverService, useValue: mockLocationGroupResolver },
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
        { provide: LocationGroupResolverService, useValue: mockLocationGroupResolver },
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

  // -------------------------------------------------------------------------
  // nodeResultSchema — node-eligibility surface
  // -------------------------------------------------------------------------

  describe('nodeResultSchema', () => {
    it('is the shared geocodeResultSchema from @memoriahub/enrichment-compute/dto', async () => {
      const { geocodeResultSchema } = await import('@memoriahub/enrichment-compute/dto');
      expect(handler.nodeResultSchema).toBe(geocodeResultSchema);
    });
  });

  // -------------------------------------------------------------------------
  // persistGeocode — direct / node-result path.
  //
  // A distributed worker node resolves transient provider credentials via
  // POST /nodes/:id/jobs/:jobId/credentials, calls the provider's HTTP API
  // directly using @memoriahub/enrichment-compute/geo's fetch*/map* helpers,
  // and submits the resulting GeocodeResult via
  // POST /nodes/:id/jobs/:jobId/result. NodesService.submitJobResult calls
  // GeocodeHandler.persistNodeResult -> this.persistGeocode(job, parsed) with
  // NO preloaded MediaItem (unlike process() above, which passes one to avoid
  // a redundant query) — these tests exercise that reload-from-scratch path
  // directly and assert it writes the IDENTICAL geo columns as the in-process
  // path exercised above via process().
  // -------------------------------------------------------------------------

  describe('persistGeocode (direct / node-result path, no preloaded MediaItem)', () => {
    const nodeMediaItem = {
      id: 'media-1',
      circleId: 'circle-1',
      deletedAt: null,
    };

    const canned = {
      country: 'Costa Rica',
      countryCode: 'CR',
      admin1: 'Provincia de San José',
      admin2: 'San José',
      locality: 'San José',
      placeName: 'San José, Provincia de San José, Costa Rica',
      source: 'nominatim',
    };

    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(nodeMediaItem as any);
      mockPrisma.mediaItem.update.mockResolvedValue({} as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
    });

    it('reloads the MediaItem itself when no preloaded item is passed', async () => {
      await handler.persistGeocode(makeJob(), canned);

      expect(mockPrisma.mediaItem.findUnique).toHaveBeenCalledWith({
        where: { id: 'media-1' },
        select: {
          id: true,
          circleId: true,
          deletedAt: true,
          // Location Grouping (issue #373): coordinates are loaded so the
          // resolver can apply radius capture on the node-result path too.
          takenLat: true,
          takenLng: true,
        },
      });
    });

    it('writes all geo columns identically to the in-process path', async () => {
      await handler.persistGeocode(makeJob(), canned);

      const updateCall = mockPrisma.mediaItem.update.mock.calls[0][0];
      expect(updateCall.data.geoCountry).toBe('Costa Rica');
      expect(updateCall.data.geoCountryCode).toBe('CR');
      expect(updateCall.data.geoAdmin1).toBe('Provincia de San José');
      expect(updateCall.data.geoAdmin2).toBe('San José');
      expect(updateCall.data.geoLocality).toBe('San José');
      expect(updateCall.data.geoPlaceName).toBe('San José, Provincia de San José, Costa Rica');
      expect(updateCall.data.geoSource).toBe('nominatim');
      expect(updateCall.data.geocodedAt).toBeInstanceOf(Date);
    });

    it('upserts media_geocode_status to processed', async () => {
      await handler.persistGeocode(makeJob(), canned);

      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      const finalCall = calls[calls.length - 1][0];
      expect(finalCall.update.status).toBe(MediaMetadataStatusType.processed);
    });

    it('does not write geo columns when the result is all-null (provider found nothing)', async () => {
      await handler.persistGeocode(makeJob(), {
        country: null,
        countryCode: null,
        admin1: null,
        admin2: null,
        locality: null,
        placeName: null,
        source: 'nominatim',
      });

      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
      const calls = mockPrisma.mediaGeocodeStatus.upsert.mock.calls;
      expect(calls[calls.length - 1][0].update.status).toBe(MediaMetadataStatusType.processed);
    });

    it('throws when job.mediaItemId is missing', async () => {
      await expect(
        handler.persistGeocode(makeJob({ mediaItemId: null }), canned),
      ).rejects.toThrow(/missing mediaItemId/);
    });

    it('throws when the MediaItem no longer exists', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(null);

      await expect(handler.persistGeocode(makeJob(), canned)).rejects.toThrow(/not found or deleted/);
    });

    it('throws when the MediaItem is soft-deleted', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        ...nodeMediaItem,
        deletedAt: new Date(),
      } as any);

      await expect(handler.persistGeocode(makeJob(), canned)).rejects.toThrow(/not found or deleted/);
    });

    it('performs no geocoder call — the node already computed the result', async () => {
      await handler.persistGeocode(makeJob(), canned);

      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // persistNodeResult — schema re-parse + delegation
  // -------------------------------------------------------------------------

  describe('persistNodeResult', () => {
    const nodeMediaItem = {
      id: 'media-1',
      circleId: 'circle-1',
      deletedAt: null,
    };

    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue(nodeMediaItem as any);
      mockPrisma.mediaItem.update.mockResolvedValue({} as any);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as any);
    });

    it('parses the payload against geocodeResultSchema and calls persistGeocode', async () => {
      const job = makeJob();
      const result = {
        country: 'Costa Rica',
        countryCode: 'CR',
        admin1: null,
        admin2: null,
        locality: null,
        placeName: null,
        source: 'google',
      };

      await handler.persistNodeResult(job, result);

      const updateCall = mockPrisma.mediaItem.update.mock.calls[0][0];
      expect(updateCall.data.geoCountry).toBe('Costa Rica');
      expect(updateCall.data.geoSource).toBe('google');
    });

    it('throws (does not persist) when the payload fails schema validation', async () => {
      const job = makeJob();

      await expect(handler.persistNodeResult(job, { country: 123 })).rejects.toThrow();
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
    });
  });
  // -------------------------------------------------------------------------
  // Location Grouping (issue #373)
  // -------------------------------------------------------------------------

  describe('canonical location columns', () => {
    beforeEach(() => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        circleId: 'circle-1',
        deletedAt: null,
        takenLat: 9.93,
        takenLng: -84.08,
      } as never);
      mockPrisma.mediaItem.update.mockResolvedValue({} as never);
      mockPrisma.mediaGeocodeStatus.upsert.mockResolvedValue({} as never);
    });

    const result = {
      country: 'Costa Rica',
      countryCode: 'CR',
      admin1: 'Provincia de Heredia',
      admin2: null,
      locality: 'SAN JOSE',
      placeName: null,
      source: 'google',
    };

    it('writes canonical columns in the SAME update as the raw ones', async () => {
      mockLocationGroupResolver.resolve.mockResolvedValue({
        geoCanonicalCountry: 'Costa Rica',
        geoCanonicalAdmin1: 'Heredia',
        geoCanonicalLocality: 'San José',
      });

      await handler.persistGeocode(makeJob(), result);

      const data = mockPrisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoCanonicalCountry).toBe('Costa Rica');
      expect(data.geoCanonicalAdmin1).toBe('Heredia');
      expect(data.geoCanonicalLocality).toBe('San José');
    });

    it('NEVER writes a canonical name into a raw column', async () => {
      mockLocationGroupResolver.resolve.mockResolvedValue({
        geoCanonicalCountry: 'Costa Rica',
        geoCanonicalAdmin1: 'Heredia',
        geoCanonicalLocality: 'San José',
      });

      await handler.persistGeocode(makeJob(), result);

      // The raw columns keep the geocoder's own strings verbatim. This is the
      // whole reason canonical names live in separate columns: persistGeocode
      // is overwrite-all, so a canonical name in geo_admin1 would be silently
      // reverted on the very next re-geocode.
      const data = mockPrisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoAdmin1).toBe('Provincia de Heredia');
      expect(data.geoLocality).toBe('SAN JOSE');
    });

    it('a geocode RERUN after a rebuild leaves the canonical names intact', async () => {
      mockLocationGroupResolver.resolve.mockResolvedValue({
        geoCanonicalCountry: 'Costa Rica',
        geoCanonicalAdmin1: 'Heredia',
        geoCanonicalLocality: 'San José',
      });

      // First pass (e.g. right after a rebuild established the groups) …
      await handler.persistGeocode(makeJob(), result);
      // … and a second, identical rerun.
      await handler.persistGeocode(makeJob(), result);

      const second = mockPrisma.mediaItem.update.mock.calls[1][0].data;
      expect(second.geoCanonicalAdmin1).toBe('Heredia');
      expect(second.geoCanonicalLocality).toBe('San José');
      expect(second.geoAdmin1).toBe('Provincia de Heredia');
    });

    it('passes the item coordinates to the resolver so radius capture can apply', async () => {
      await handler.persistGeocode(makeJob(), result);

      expect(mockLocationGroupResolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ geoAdmin1: 'Provincia de Heredia' }),
        { lat: 9.93, lng: -84.08 },
      );
    });

    it('passes null coordinates when the item has none', async () => {
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        id: 'media-1',
        circleId: 'circle-1',
        deletedAt: null,
        takenLat: null,
        takenLng: null,
      } as never);

      await handler.persistGeocode(makeJob(), result);

      expect(mockLocationGroupResolver.resolve).toHaveBeenCalledWith(expect.anything(), null);
    });

    it('with grouping OFF (identity resolver) canonical equals raw verbatim', async () => {
      // mockLocationGroupResolver defaults to the identity implementation.
      await handler.persistGeocode(makeJob(), result);

      const data = mockPrisma.mediaItem.update.mock.calls[0][0].data;
      expect(data.geoCanonicalCountry).toBe(data.geoCountry);
      expect(data.geoCanonicalAdmin1).toBe(data.geoAdmin1);
      expect(data.geoCanonicalLocality).toBe(data.geoLocality);
    });
  });
});
