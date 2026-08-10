/**
 * Read-path migration tests for Location Grouping (issue #374).
 *
 * ─── The most important test in the issue is READ-PATH NEUTRALITY ──────────
 *
 * With NO location groups defined, `explore/locations`, `explore/places`,
 * `facets/locations`, the map-pin labels and `GET /media?region=` must return
 * results IDENTICAL to the pre-change behaviour. That is not a hopeful
 * assertion: the #373 migration seeded `geo_canonical_* = geo_*` for every
 * existing row and the resolver is the identity function while the feature is
 * off, so "no groups" means canonical equals raw byte-for-byte. Every neutrality
 * test below feeds exactly that state and asserts the pre-#374 output verbatim.
 *
 * The `describe('with groups applied')` block is the POSITIVE CONTROL: it proves
 * the neutrality above comes from canonical genuinely equalling raw, not from
 * the read paths quietly ignoring the canonical columns.
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
import { UploadNotificationService } from '../notifications/producers/upload-notification.service';
import { MediaTouchService } from './media-touch.service';
import { MediaThumbnailService } from './media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { LocationGroupResolverService } from '../location-groups/location-group-resolver.service';
import { createMockLocationGroupResolver } from '../../test/mocks/location-group-resolver.mock';
import { buildMediaWhere } from '../search/media-where.builder';

const CIRCLE_ID = 'circle-lg';
const USER_ID = 'user-lg';

/**
 * A groupBy row in the UNGROUPED state — canonical mirrors raw exactly, which
 * is what the database really holds when no group claims the value.
 */
function ungroupedRow(
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
    geoCanonicalCountry: geoCountry,
    geoCanonicalAdmin1: geoAdmin1,
    geoCanonicalLocality: geoLocality,
    _count: { _all: count },
  };
}

/** A groupBy row whose raw spelling has been folded into a group. */
function groupedRow(
  geoCountry: string,
  geoCountryCode: string | null,
  raw: { admin1: string | null; locality: string | null },
  canonical: { admin1: string | null; locality: string | null },
  count: number,
) {
  return {
    geoCountry,
    geoCountryCode,
    geoAdmin1: raw.admin1,
    geoLocality: raw.locality,
    geoCanonicalCountry: geoCountry,
    geoCanonicalAdmin1: canonical.admin1,
    geoCanonicalLocality: canonical.locality,
    _count: { _all: count },
  };
}

describe('MediaService — Location Grouping read paths (issue #374)', () => {
  let service: MediaService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: LocationGroupResolverService, useValue: createMockLocationGroupResolver() },
        MediaService,
        MediaThumbnailService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: STORAGE_PROVIDER,
          useValue: {
            getSignedDownloadUrl: jest.fn().mockResolvedValue(null),
            getBucket: jest.fn().mockReturnValue('bucket'),
          },
        },
        { provide: MediaMetadataSyncService, useValue: {} },
        {
          provide: CircleMembershipService,
          useValue: { assertCircleAccess: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: GEO_LOCATION_PROVIDER, useValue: {} },
        { provide: ForwardGeocodeService, useValue: {} },
        { provide: StorageProviderResolver, useValue: { getProviderFor: jest.fn() } },
        {
          provide: UploadNotificationService,
          useValue: { recordUploadAsync: jest.fn(), recordUpload: jest.fn() },
        },
        {
          provide: MediaTouchService,
          useValue: { touchMediaItems: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: MediaEnrichmentService, useValue: {} },
      ],
    }).compile();

    service = module.get(MediaService);

    (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);
    // No groups defined — the neutrality precondition.
    (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([]);
  });

  // =========================================================================
  // NEUTRALITY: no groups ⇒ pre-#374 output, verbatim
  // =========================================================================

  describe('read-path neutrality (no groups defined)', () => {
    it('explore/locations returns exactly the raw tier names and counts', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        ungroupedRow('Costa Rica', 'CR', 'Heredia', 'Heredia', 3),
        ungroupedRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 7),
        ungroupedRow('United States', 'US', 'Texas', 'Conroe', 2),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.countries).toEqual([
        { name: 'Costa Rica', countryCode: 'CR', count: 10, coverThumbnailUrl: null },
        { name: 'United States', countryCode: 'US', count: 2, coverThumbnailUrl: null },
      ]);
      expect(result.regions).toEqual([
        { name: 'Guanacaste', count: 7, coverThumbnailUrl: null },
        { name: 'Heredia', count: 3, coverThumbnailUrl: null },
        { name: 'Texas', count: 2, coverThumbnailUrl: null },
      ]);
      expect(result.cities).toEqual([
        { name: 'Liberia', count: 7, coverThumbnailUrl: null },
        { name: 'Heredia', count: 3, coverThumbnailUrl: null },
        { name: 'Conroe', count: 2, coverThumbnailUrl: null },
      ]);
    });

    it('explore/places returns exactly the raw locality names and counts', async () => {
      (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        { geoCanonicalLocality: 'Heredia', geoLocality: 'Heredia', geoPlaceName: null, metadata: null },
        { geoCanonicalLocality: 'Heredia', geoLocality: 'Heredia', geoPlaceName: null, metadata: null },
        { geoCanonicalLocality: 'Liberia', geoLocality: 'Liberia', geoPlaceName: null, metadata: null },
      ]);

      const result = await service.explorePlaces(CIRCLE_ID, USER_ID, []);

      expect(result).toEqual([
        { name: 'Heredia', count: 2, coverThumbnailUrl: null },
        { name: 'Liberia', count: 1, coverThumbnailUrl: null },
      ]);
    });

    it('explore/places still falls back to geoPlaceName when there is no locality at all', async () => {
      (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        {
          geoCanonicalLocality: null,
          geoLocality: null,
          geoPlaceName: 'Yosemite National Park',
          metadata: null,
        },
      ]);

      const result = await service.explorePlaces(CIRCLE_ID, USER_ID, []);

      expect(result).toEqual([
        { name: 'Yosemite National Park', count: 1, coverThumbnailUrl: null },
      ]);
    });

    it('facets/locations returns exactly the raw country → region → locality tree', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        ungroupedRow('Costa Rica', 'CR', 'Heredia', 'Heredia', 3),
        ungroupedRow('Costa Rica', 'CR', 'Heredia', 'Barva', 4),
        ungroupedRow('Costa Rica', 'CR', 'Guanacaste', 'Liberia', 7),
      ]);

      const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

      expect(result).toEqual([
        {
          country: 'Costa Rica',
          countryCode: 'CR',
          count: 14,
          // Tied counts keep insertion order (Array#sort is stable), so
          // Heredia precedes Guanacaste — unchanged pre-#374 behaviour.
          regions: [
            {
              name: 'Heredia',
              count: 7,
              localities: [
                { name: 'Barva', count: 4 },
                { name: 'Heredia', count: 3 },
              ],
            },
            { name: 'Guanacaste', count: 7, localities: [{ name: 'Liberia', count: 7 }] },
          ],
        },
      ]);
    });

    it('map pins keep their raw locality label', async () => {
      (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'i1',
          takenLat: 10,
          takenLng: -84,
          capturedAt: new Date('2026-01-01T00:00:00.000Z'),
          geoLocality: 'Heredia',
          geoCanonicalLocality: 'Heredia',
        },
      ]);

      const result = await service.listLocations(
        { circleId: CIRCLE_ID } as any,
        USER_ID,
        [],
      );

      expect(result[0].geoLocality).toBe('Heredia');
    });

    it('GET /media?region= still matches an item carrying only the raw name', () => {
      // The filter is an OR over canonical AND raw, so a pre-existing deep
      // link, bookmark, or Android/CLI client passing a raw name keeps working
      // — including after that name has been folded into a group.
      const where = buildMediaWhere(CIRCLE_ID, { region: 'Heredia' });
      const and = (where as any).AND as any[];
      const clause = and.find((c) => Array.isArray(c.OR));

      expect(clause.OR).toEqual([
        { geoCanonicalAdmin1: { contains: 'Heredia', mode: 'insensitive' } },
        { geoAdmin1: { contains: 'Heredia', mode: 'insensitive' } },
      ]);
      expect(where).toMatchObject({ circleId: CIRCLE_ID, deletedAt: null });
    });

    it('the tier cover heuristic is unchanged when no group carries a cover', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        ungroupedRow('Costa Rica', 'CR', 'Heredia', 'Heredia', 3),
      ]);

      await service.exploreLocationLevel(CIRCLE_ID, 'cities', USER_ID, []);

      // One bounded findFirst ordered by capturedAt desc, exactly as before.
      expect(prisma.mediaItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { capturedAt: 'desc' },
          select: { metadata: true },
        }),
      );
    });
  });

  // =========================================================================
  // The archived divergence between search facets and browse is PRESERVED
  // =========================================================================

  describe('archived-item divergence', () => {
    it('facets/locations does NOT filter archivedAt (search includes archived)', async () => {
      await service.facetsLocations(CIRCLE_ID, USER_ID, []);

      const [call] = (prisma.mediaItem.groupBy as jest.Mock).mock.calls;
      expect(call[0].where).toEqual({
        circleId: CIRCLE_ID,
        deletedAt: null,
        geoCountry: { not: null },
      });
      expect(call[0].where.archivedAt).toBeUndefined();
    });

    it('explore/locations DOES filter archivedAt (browse hides archived)', async () => {
      await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      const [call] = (prisma.mediaItem.groupBy as jest.Mock).mock.calls;
      expect(call[0].where.archivedAt).toBeNull();
    });

    it('explore/places DOES filter archivedAt (browse hides archived)', async () => {
      await service.explorePlaces(CIRCLE_ID, USER_ID, []);

      const [call] = (prisma.mediaItem.findMany as jest.Mock).mock.calls;
      expect(call[0].where.archivedAt).toBeNull();
    });
  });

  // =========================================================================
  // POSITIVE CONTROL: grouping really does take effect
  // =========================================================================

  describe('with groups applied', () => {
    it('collapses three region spellings into one tier entry with summed counts', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        groupedRow(
          'Costa Rica',
          'CR',
          { admin1: 'Heredia', locality: null },
          { admin1: 'Heredia', locality: null },
          3,
        ),
        groupedRow(
          'Costa Rica',
          'CR',
          { admin1: 'Heredia Province', locality: null },
          { admin1: 'Heredia', locality: null },
          5,
        ),
        groupedRow(
          'Costa Rica',
          'CR',
          { admin1: 'Provincia de Heredia', locality: null },
          { admin1: 'Heredia', locality: null },
          2,
        ),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.regions).toEqual([
        { name: 'Heredia', count: 10, coverThumbnailUrl: null },
      ]);
    });

    it('collapses suburb localities into the group name a person actually uses', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        groupedRow(
          'United States',
          'US',
          { admin1: 'Texas', locality: 'Conroe' },
          { admin1: 'Texas', locality: 'The Woodlands' },
          4,
        ),
        groupedRow(
          'United States',
          'US',
          { admin1: 'Texas', locality: 'Shenandoah' },
          { admin1: 'Texas', locality: 'The Woodlands' },
          6,
        ),
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.cities).toEqual([
        { name: 'The Woodlands', count: 10, coverThumbnailUrl: null },
      ]);
    });

    it("renaming a COUNTRY group changes the display name but not the grouping key", async () => {
      // Countries stay keyed by geoCountryCode: an ISO code is already
      // canonical, so two spellings were never two entries to begin with.
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        {
          ...groupedRow(
            'United States of America',
            'US',
            { admin1: 'Texas', locality: null },
            { admin1: 'Texas', locality: null },
            4,
          ),
          geoCanonicalCountry: 'USA',
        },
      ]);

      const result = await service.exploreLocations(CIRCLE_ID, USER_ID, []);

      expect(result.countries).toEqual([
        { name: 'USA', countryCode: 'US', count: 4, coverThumbnailUrl: null },
      ]);
    });

    it('a group cover OVERRIDES the capturedAt heuristic and skips the findFirst', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        ungroupedRow('Costa Rica', 'CR', 'Heredia', 'Heredia', 3),
      ]);
      (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([
        {
          countryCode: '',
          normalizedName: 'heredia',
          coverMediaItem: {
            metadata: { thumbnailStorageKey: 'chosen-cover' },
            deletedAt: null,
          },
        },
      ]);

      await service.exploreLocationLevel(CIRCLE_ID, 'cities', USER_ID, []);

      // The heuristic lookup is not merely discarded — it never runs.
      expect(prisma.mediaItem.findFirst).not.toHaveBeenCalled();
      const [signCall] = (prisma.storageObject.findMany as jest.Mock).mock.calls;
      expect(signCall[0].where.storageKey.in).toContain('chosen-cover');
    });

    it('a SOFT-DELETED group cover falls back to the heuristic', async () => {
      // The SetNull FK only fires on a HARD delete, so a trashed photo would
      // otherwise keep being served as a group cover after the user removed it.
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        ungroupedRow('Costa Rica', 'CR', 'Heredia', 'Heredia', 3),
      ]);
      (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([
        {
          countryCode: '',
          normalizedName: 'heredia',
          coverMediaItem: {
            metadata: { thumbnailStorageKey: 'chosen-cover' },
            deletedAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        },
      ]);

      await service.exploreLocationLevel(CIRCLE_ID, 'cities', USER_ID, []);

      expect(prisma.mediaItem.findFirst).toHaveBeenCalled();
    });

    it('a map pin is labelled with the canonical locality', async () => {
      (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'i1',
          takenLat: 30.15,
          takenLng: -95.48,
          capturedAt: new Date('2026-01-01T00:00:00.000Z'),
          geoLocality: 'Shenandoah',
          geoCanonicalLocality: 'The Woodlands',
        },
      ]);

      const result = await service.listLocations(
        { circleId: CIRCLE_ID } as any,
        USER_ID,
        [],
      );

      expect(result[0].geoLocality).toBe('The Woodlands');
    });

    it('facets/locations reports the canonical tree', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        groupedRow(
          'Costa Rica',
          'CR',
          { admin1: 'Heredia Province', locality: 'Barva' },
          { admin1: 'Heredia', locality: 'Barva' },
          4,
        ),
        groupedRow(
          'Costa Rica',
          'CR',
          { admin1: 'Provincia de Heredia', locality: 'Barva' },
          { admin1: 'Heredia', locality: 'Barva' },
          2,
        ),
      ]);

      const result = await service.facetsLocations(CIRCLE_ID, USER_ID, []);

      expect(result).toEqual([
        {
          country: 'Costa Rica',
          countryCode: 'CR',
          count: 6,
          regions: [
            { name: 'Heredia', count: 6, localities: [{ name: 'Barva', count: 6 }] },
          ],
        },
      ]);
    });
  });
});
