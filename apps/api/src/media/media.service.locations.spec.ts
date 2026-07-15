/**
 * Unit tests for MediaService.exploreLocations / exploreLocationLevel
 * (tiered Countries / Regions / Cities Explore browsing).
 *
 * Mirrors the structure of media.service.facets.spec.ts: the shared
 * `prisma.mediaItem.groupBy` call is mocked so no real DB is needed, and the
 * per-tier fold-sort-cap logic (private `buildLocationLevel`, exercised only
 * through the two public methods) is asserted via its observable output.
 * `prisma.mediaItem.findFirst` (cover lookup) and the storage provider's
 * `getSignedDownloadUrl` are mocked separately for the cover-signing tests.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { GEO_LOCATION_PROVIDER } from './geo/geo-location-provider.interface';
import { ForwardGeocodeService } from './geo/forward-geocode.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { MediaEnrichmentService } from './enrichment/media-enrichment.service';
import { MediaThumbnailService } from './media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const CIRCLE_ID = 'circle-locations-test';
const USER_ID = 'user-locations-test';

/**
 * Build a groupBy row as Prisma would return it for the shared
 * fetchGeoGroupRows() call (geoCountry / geoCountryCode / geoAdmin1 /
 * geoLocality + _count._all).
 */
function makeRow(
  geoCountry: string,
  geoCountryCode: string | null,
  geoAdmin1: string | null,
  geoLocality: string | null,
  count: number,
) {
  return {
    geoCountry,
    geoCountryCode,
    geoAdmin1,
    geoLocality,
    _count: { _all: count },
  };
}

describe('MediaService.exploreLocations / exploreLocationLevel', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockCircleMembership: { assertCircleAccess: jest.Mock };
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock; getBucket: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockCircleMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue(undefined),
    };
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue(null),
      // MediaThumbnailService's legacy-fallback signing path calls
      // storageProvider.getBucket() to build its URL-cache key.
      getBucket: jest.fn().mockReturnValue('legacy-static-bucket'),
    };
    // Batched thumbnail signing (MediaThumbnailService.signThumbsBatched, used
    // by buildLocationLevel's tier item enrichment) issues one
    // storageObject.findMany call. Default to no matching rows -> falls back
    // to the legacy static provider.
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: MediaMetadataSyncService, useValue: {} },
        { provide: CircleMembershipService, useValue: mockCircleMembership },
        { provide: GEO_LOCATION_PROVIDER, useValue: {} },
        { provide: ForwardGeocodeService, useValue: {} },
        { provide: StorageProviderResolver, useValue: { getProviderFor: jest.fn() } },
        { provide: MediaEnrichmentService, useValue: {} },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);

    // Default: no groupBy rows unless a test overrides it.
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([]);
  });

  // ---------------------------------------------------------------------------
  // exploreLocations
  // ---------------------------------------------------------------------------

  describe('exploreLocations', () => {
    it('calls assertCircleAccess with the supplied circleId, userId, permissions, and viewer role', async () => {
      await service.exploreLocations(CIRCLE_ID, USER_ID, ['circles:read']);

      expect(mockCircleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        ['circles:read'],
        'viewer',
      );
    });

    it('invokes the shared groupBy with deletedAt/archivedAt exclusion and geoCountry not-null filter', async () => {
      await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(mockPrisma.mediaItem.groupBy).toHaveBeenCalledWith({
        by: ['geoCountry', 'geoCountryCode', 'geoAdmin1', 'geoLocality'],
        where: {
          circleId: CIRCLE_ID,
          deletedAt: null,
          archivedAt: null,
          geoCountry: { not: null },
        },
        _count: { _all: true },
      });
    });

    it('returns empty tiers when there are no rows', async () => {
      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result).toEqual({ countries: [], regions: [], cities: [] });
    });

    it('sums counts across sub-groups within the same country', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
        makeRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 7),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.countries).toHaveLength(1);
      expect(result.countries[0]).toMatchObject({ name: 'Costa Rica', count: 10 });
    });

    it('folds multiple regions within a country into separate region entries with summed counts', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
        makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
        makeRow('Costa Rica', 'CR', 'Guanacaste', 'Nicoya', 5),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      const sanJose = result.regions.find((r) => r.name === 'San José');
      const guanacaste = result.regions.find((r) => r.name === 'Guanacaste');
      expect(sanJose?.count).toBe(10); // 3 + 7
      expect(guanacaste?.count).toBe(5);
    });

    it('sorts countries by count descending', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('France', 'FR', 'Île-de-France', 'Paris', 12),
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
        makeRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 20),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      // Costa Rica: 3 + 20 = 23 > France: 12
      expect(result.countries[0].name).toBe('Costa Rica');
      expect(result.countries[0].count).toBe(23);
      expect(result.countries[1].name).toBe('France');
    });

    it('sorts regions by count descending', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 4),
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 9),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.regions[0].name).toBe('San José');
      expect(result.regions[1].name).toBe('Guanacaste');
    });

    it('sorts cities by count descending', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 2),
        makeRow('Costa Rica', 'CR', 'San José', 'Ciudad Colón', 15),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.cities[0].name).toBe('Ciudad Colón');
      expect(result.cities[1].name).toBe('Heredia');
    });

    it('caps each tier at 12 entries', async () => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        makeRow(`Country${i}`, `C${i}`, `Region${i}`, `City${i}`, i + 1),
      );
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue(rows);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.countries).toHaveLength(12);
      expect(result.regions).toHaveLength(12);
      expect(result.cities).toHaveLength(12);
    });

    it('the 12-cap keeps the highest-count entries, not an arbitrary slice', async () => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        makeRow(`Country${i}`, `C${i}`, null, null, i + 1),
      );
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue(rows);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      // Highest counts are Country19 (20) down to Country8 (9) — 12 entries.
      const names = result.countries.map((c) => c.name);
      expect(names).toContain('Country19');
      expect(names).not.toContain('Country0');
    });

    it('countries carry a countryCode', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.countries[0].countryCode).toBe('CR');
    });

    it('regions and cities omit countryCode from the returned shape', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.regions[0]).not.toHaveProperty('countryCode');
      expect(result.cities[0]).not.toHaveProperty('countryCode');
      expect(Object.keys(result.regions[0]).sort()).toEqual(
        ['coverThumbnailUrl', 'count', 'name'].sort(),
      );
      expect(Object.keys(result.cities[0]).sort()).toEqual(
        ['coverThumbnailUrl', 'count', 'name'].sort(),
      );
    });

    it('signs a cover thumbnail for a surviving group via the storage provider fallback', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      ]);
      (mockPrisma.mediaItem.findFirst as jest.Mock).mockResolvedValue({
        metadata: { thumbnailStorageKey: 'thumb-key-1' },
      });
      // No StorageObject row found for the key → signThumb falls back to the
      // legacy static provider (STORAGE_PROVIDER token), matching the
      // documented fallback path in signThumb().
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed.example.com/thumb-key-1',
      );

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith('thumb-key-1', {
        expiresIn: 86400,
      });
      expect(result.countries[0].coverThumbnailUrl).toBe(
        'https://signed.example.com/thumb-key-1',
      );
    });

    it('returns null coverThumbnailUrl when the cover lookup finds no metadata', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      ]);
      (mockPrisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.countries[0].coverThumbnailUrl).toBeNull();
    });

    it('looks up the country cover using the indexed countryCode when present', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      ]);
      (mockPrisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);

      await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(mockPrisma.mediaItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleId: CIRCLE_ID,
            deletedAt: null,
            archivedAt: null,
            geoCountryCode: 'CR',
          }),
          orderBy: { capturedAt: 'desc' },
          select: { metadata: true },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // exploreLocationLevel
  // ---------------------------------------------------------------------------

  describe('exploreLocationLevel', () => {
    it.each(['countries', 'regions', 'cities'] as const)(
      'calls assertCircleAccess with viewer role for a valid level (%s)',
      async (level) => {
        await service.exploreLocationLevel(CIRCLE_ID, level, USER_ID, ['circles:read']);

        expect(mockCircleMembership.assertCircleAccess).toHaveBeenCalledWith(
          USER_ID,
          CIRCLE_ID,
          ['circles:read'],
          'viewer',
        );
      },
    );

    it('throws BadRequestException for an invalid level', async () => {
      await expect(
        service.exploreLocationLevel(CIRCLE_ID, 'planets', USER_ID, []),
      ).rejects.toThrow(BadRequestException);
    });

    it('does NOT call assertCircleAccess when the level is invalid (validation runs first)', async () => {
      await expect(
        service.exploreLocationLevel(CIRCLE_ID, 'planets', USER_ID, []),
      ).rejects.toThrow(BadRequestException);

      expect(mockCircleMembership.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('does NOT hit the database when the level is invalid', async () => {
      await expect(
        service.exploreLocationLevel(CIRCLE_ID, 'planets', USER_ID, []),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.mediaItem.groupBy).not.toHaveBeenCalled();
    });

    it('returns the countries tier capped at 500 with countryCode present', async () => {
      const rows = Array.from({ length: 600 }, (_, i) =>
        makeRow(`Country${i}`, `C${i}`, null, null, i + 1),
      );
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue(rows);

      const result = await service.exploreLocationLevel(
        CIRCLE_ID,
        'countries',
        USER_ID,
        [],
      );

      expect(result).toHaveLength(500);
      expect(result[0]).toHaveProperty('countryCode');
    });

    it('returns the regions tier capped at 500 without countryCode', async () => {
      const rows = Array.from({ length: 10 }, (_, i) =>
        makeRow('Costa Rica', 'CR', `Region${i}`, null, i + 1),
      );
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue(rows);

      const result = await service.exploreLocationLevel(
        CIRCLE_ID,
        'regions',
        USER_ID,
        [],
      );

      expect(result.length).toBeLessThanOrEqual(500);
      expect(result[0]).not.toHaveProperty('countryCode');
    });

    it('returns the cities tier sorted by count descending', async () => {
      (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 2),
        makeRow('Costa Rica', 'CR', 'San José', 'Ciudad Colón', 9),
      ]);

      const result = await service.exploreLocationLevel(CIRCLE_ID, 'cities', USER_ID, []);

      expect(result[0].name).toBe('Ciudad Colón');
      expect(result[1].name).toBe('Heredia');
    });

    it('invokes the shared groupBy with the same where clause as exploreLocations', async () => {
      await service.exploreLocationLevel(CIRCLE_ID, 'countries', USER_ID, []);

      expect(mockPrisma.mediaItem.groupBy).toHaveBeenCalledWith({
        by: ['geoCountry', 'geoCountryCode', 'geoAdmin1', 'geoLocality'],
        where: {
          circleId: CIRCLE_ID,
          deletedAt: null,
          archivedAt: null,
          geoCountry: { not: null },
        },
        _count: { _all: true },
      });
    });
  });
});
