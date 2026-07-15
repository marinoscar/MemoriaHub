/**
 * Unit tests for MediaService.facetsLocations
 *
 * Tests focus on the pure in-JS fold-and-sort logic. The groupBy call is
 * mocked so no real DB is needed, making this a true unit test.
 */
import { Test, TestingModule } from '@nestjs/testing';
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

const CIRCLE_ID = 'circle-facets-test';
const USER_ID = 'user-facets-test';

/**
 * Build a groupBy row as Prisma would return it.
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

describe('MediaService.facetsLocations', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockCircleMembership: { assertCircleAccess: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockCircleMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: { getSignedDownloadUrl: jest.fn() } },
        { provide: MediaMetadataSyncService, useValue: {} },
        { provide: CircleMembershipService, useValue: mockCircleMembership },
        { provide: GEO_LOCATION_PROVIDER, useValue: {} },
        { provide: ForwardGeocodeService, useValue: {} },
        { provide: StorageProviderResolver, useValue: { getProviderFor: jest.fn() } },
        { provide: MediaEnrichmentService, useValue: {} },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  it('calls assertCircleAccess with the supplied circleId, userId, and permissions', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([]);

    await service.facetsLocations(CIRCLE_ID, USER_ID, ['circles:read']);

    expect(mockCircleMembership.assertCircleAccess).toHaveBeenCalledWith(
      USER_ID,
      CIRCLE_ID,
      ['circles:read'],
      'viewer',
    );
  });

  it('returns empty array when groupBy returns no rows', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    expect(result).toEqual([]);
  });

  it('folds multiple rows for the same country into a single country entry', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    expect(result).toHaveLength(1);
    expect(result[0].country).toBe('Costa Rica');
    expect(result[0].countryCode).toBe('CR');
    expect(result[0].count).toBe(10); // 3 + 7
  });

  it('folds multiple countries into separate entries', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 5),
      makeRow('France', 'FR', 'Île-de-France', 'Paris', 12),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    const countries = result.map((c) => c.country).sort();
    expect(countries).toEqual(['Costa Rica', 'France'].sort());
  });

  it('folds multiple regions within a country', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 4),
      makeRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 6),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    expect(result).toHaveLength(1);
    const cr = result[0];
    expect(cr.regions).toHaveLength(2);
    const regionNames = cr.regions.map((r) => r.name).sort();
    expect(regionNames).toEqual(['Guanacaste', 'San José'].sort());
  });

  it('folds localities within the same region', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    const sj = result[0].regions.find((r) => r.name === 'San José');
    expect(sj).toBeDefined();
    expect(sj!.localities).toHaveLength(2);
    const localityNames = sj!.localities.map((l) => l.name).sort();
    expect(localityNames).toEqual(['Heredia', 'Liberia'].sort());
  });

  it('correctly accumulates region count from all its localities', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    const sj = result[0].regions[0]; // only one region
    expect(sj.count).toBe(10); // 3 + 7
  });

  it('sorts countries by count descending', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('France', 'FR', 'Île-de-France', 'Paris', 12),
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
      makeRow('Costa Rica', 'CR', 'Guanacaste', null, 5),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    // Costa Rica: 3+7+5 = 15, France: 12 → Costa Rica first
    expect(result[0].country).toBe('Costa Rica');
    expect(result[0].count).toBe(15);
    expect(result[1].country).toBe('France');
    expect(result[1].count).toBe(12);
  });

  it('sorts regions within a country by count descending', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 5),
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Ciudad Colón', 7),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    const cr = result[0];
    // San José: 3+7=10, Guanacaste: 5 → San José first
    expect(cr.regions[0].name).toBe('San José');
    expect(cr.regions[0].count).toBe(10);
    expect(cr.regions[1].name).toBe('Guanacaste');
    expect(cr.regions[1].count).toBe(5);
  });

  it('sorts localities within a region by count descending', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
      makeRow('Costa Rica', 'CR', 'San José', 'Ciudad Colón', 11),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    const sj = result[0].regions[0];
    expect(sj.localities[0].name).toBe('Ciudad Colón'); // 11, highest
    expect(sj.localities[1].name).toBe('Liberia');      // 7
    expect(sj.localities[2].name).toBe('Heredia');      // 3
  });

  it('handles a row with null region (country-level items only)', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', null, null, 8),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    expect(result).toHaveLength(1);
    expect(result[0].country).toBe('Costa Rica');
    expect(result[0].count).toBe(8);
    // A null region row should NOT create a region entry
    expect(result[0].regions).toHaveLength(0);
  });

  it('handles a row with region but null locality', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', null, 4),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    const cr = result[0];
    expect(cr.regions).toHaveLength(1);
    expect(cr.regions[0].name).toBe('San José');
    expect(cr.regions[0].count).toBe(4);
    // Null locality should NOT appear in localities array
    expect(cr.regions[0].localities).toHaveLength(0);
  });

  it('full hierarchical structure: two countries, two regions each, two localities each', async () => {
    (mockPrisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
      makeRow('Costa Rica', 'CR', 'San José', 'Heredia', 3),
      makeRow('Costa Rica', 'CR', 'San José', 'Liberia', 7),
      makeRow('Costa Rica', 'CR', 'Guanacaste', 'Nicoya', 5),
      makeRow('Costa Rica', 'CR', 'Guanacaste', 'Tamarindo', 2),
      makeRow('France', 'FR', 'Île-de-France', 'Paris', 20),
      makeRow('France', 'FR', 'Île-de-France', 'Versailles', 4),
      makeRow('France', 'FR', 'Bretagne', 'Rennes', 6),
      makeRow('France', 'FR', 'Bretagne', 'Brest', 3),
    ] as any);

    const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

    // France: 20+4+6+3=33 > Costa Rica: 3+7+5+2=17 → France first
    expect(result[0].country).toBe('France');
    expect(result[0].count).toBe(33);
    expect(result[1].country).toBe('Costa Rica');
    expect(result[1].count).toBe(17);

    // Within France: Île-de-France (24) > Bretagne (9)
    expect(result[0].regions[0].name).toBe('Île-de-France');
    expect(result[0].regions[0].count).toBe(24);
    expect(result[0].regions[1].name).toBe('Bretagne');

    // Within Île-de-France: Paris (20) > Versailles (4)
    expect(result[0].regions[0].localities[0].name).toBe('Paris');
    expect(result[0].regions[0].localities[0].count).toBe(20);
    expect(result[0].regions[0].localities[1].name).toBe('Versailles');

    // Within Costa Rica: San José (10) > Guanacaste (7)
    expect(result[1].regions[0].name).toBe('San José');
    expect(result[1].regions[1].name).toBe('Guanacaste');

    // Within San José: Liberia (7) > Heredia (3)
    expect(result[1].regions[0].localities[0].name).toBe('Liberia');
    expect(result[1].regions[0].localities[1].name).toBe('Heredia');
  });
});
