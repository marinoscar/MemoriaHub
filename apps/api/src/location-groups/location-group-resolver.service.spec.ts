import { LocationGroupResolverService } from './location-group-resolver.service';

/** Shape of one row as returned by the resolver's snapshot query. */
interface GroupRow {
  level: 'country' | 'region' | 'locality';
  countryCode: string;
  canonicalName: string;
  centerLat: number | null;
  centerLng: number | null;
  radiusKm: number | null;
  aliases: { level: string; countryCode: string; normalizedValue: string }[];
}

function makeService(groups: GroupRow[], settingsOverride: Record<string, unknown> = {}) {
  const findMany = jest.fn().mockResolvedValue(groups);
  const prisma = { locationGroup: { findMany } } as never;

  const getSettings = jest.fn().mockResolvedValue({
    features: { locationGrouping: true },
    locationGrouping: { radiusCaptureEnabled: true, maxRadiusKm: 50, suggestionMinItems: 1 },
    ...settingsOverride,
  });
  const systemSettings = { getSettings } as never;

  return {
    service: new LocationGroupResolverService(prisma, systemSettings),
    findMany,
    getSettings,
  };
}

const NO_GEO = {
  geoCountry: null,
  geoCountryCode: null,
  geoAdmin1: null,
  geoLocality: null,
};

describe('LocationGroupResolverService', () => {
  const OLD_ENV = process.env['LOCATION_GROUPING_ENABLED'];

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env['LOCATION_GROUPING_ENABLED'];
    else process.env['LOCATION_GROUPING_ENABLED'] = OLD_ENV;
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // The invariant
  // -------------------------------------------------------------------------

  it('an unmatched raw value passes through VERBATIM', async () => {
    const { service } = makeService([]);

    const out = await service.resolve(
      {
        geoCountry: 'Costa Rica',
        geoCountryCode: 'CR',
        geoAdmin1: 'Heredia',
        geoLocality: 'Barva',
      },
      null,
    );

    expect(out).toEqual({
      geoCanonicalCountry: 'Costa Rica',
      geoCanonicalAdmin1: 'Heredia',
      geoCanonicalLocality: 'Barva',
    });
  });

  it('a null raw tier yields a null canonical tier', async () => {
    const { service } = makeService([]);
    const out = await service.resolve(NO_GEO, null);
    expect(out).toEqual({
      geoCanonicalCountry: null,
      geoCanonicalAdmin1: null,
      geoCanonicalLocality: null,
    });
  });

  // -------------------------------------------------------------------------
  // Alias resolution
  // -------------------------------------------------------------------------

  it('resolves a raw value through an alias, case/accent-insensitively', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'New York City',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'locality', countryCode: 'US', normalizedValue: 'nyc' }],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'NYC' },
      null,
    );
    expect(out.geoCanonicalLocality).toBe('New York City');
  });

  it("a group's own canonical name resolves to itself without an explicit alias", async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'CR',
        canonicalName: 'San José',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'CR', geoAdmin1: null, geoLocality: 'SAN JOSE' },
      null,
    );
    expect(out.geoCanonicalLocality).toBe('San José');
  });

  it('country-level aliases are scoped by the empty string, not the item country code', async () => {
    const { service } = makeService([
      {
        level: 'country',
        countryCode: '',
        canonicalName: 'United States',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'country', countryCode: '', normalizedValue: 'usa' }],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: 'USA', geoCountryCode: 'US', geoAdmin1: null, geoLocality: null },
      null,
    );
    expect(out.geoCanonicalCountry).toBe('United States');
  });

  it('an exactly-scoped alias beats an unscoped one', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: '',
        canonicalName: 'Unscoped Springfield',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'locality', countryCode: '', normalizedValue: 'springfield' }],
      },
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'Springfield, IL',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'locality', countryCode: 'US', normalizedValue: 'springfield' }],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Springfield' },
      null,
    );
    expect(out.geoCanonicalLocality).toBe('Springfield, IL');
  });

  // -------------------------------------------------------------------------
  // Radius resolution
  // -------------------------------------------------------------------------

  it('claims an item by radius when no alias matches', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'Greater Houston',
        centerLat: 29.76,
        centerLng: -95.37,
        radiusKm: 40,
        aliases: [],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Bellaire' },
      { lat: 29.7, lng: -95.46 },
    );
    expect(out.geoCanonicalLocality).toBe('Greater Houston');
  });

  it('the SMALLEST radius wins among overlapping areas', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'Greater Houston',
        centerLat: 30.16,
        centerLng: -95.46,
        radiusKm: 45,
        aliases: [],
      },
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'The Woodlands',
        centerLat: 30.16,
        centerLng: -95.46,
        radiusKm: 8,
        aliases: [],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Sterling Ridge' },
      { lat: 30.16, lng: -95.46 },
    );
    expect(out.geoCanonicalLocality).toBe('The Woodlands');
  });

  it('ALIAS BEATS RADIUS — an explicit admin listing outranks containment', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'The Woodlands',
        centerLat: 30.16,
        centerLng: -95.46,
        radiusKm: 8,
        aliases: [],
      },
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'Sterling Ridge (kept separate)',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'locality', countryCode: 'US', normalizedValue: 'sterling ridge' }],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Sterling Ridge' },
      // The point is squarely inside The Woodlands' radius — the alias must win anyway.
      { lat: 30.16, lng: -95.46 },
    );
    expect(out.geoCanonicalLocality).toBe('Sterling Ridge (kept separate)');
  });

  it('a point outside the radius is NOT claimed (exact haversine, not the bbox)', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'The Woodlands',
        centerLat: 30.16,
        centerLng: -95.46,
        radiusKm: 5,
        aliases: [],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Far Away' },
      { lat: 31.5, lng: -95.46 },
    );
    expect(out.geoCanonicalLocality).toBe('Far Away');
  });

  it('radius capture is skipped entirely when radiusCaptureEnabled is false', async () => {
    const { service } = makeService(
      [
        {
          level: 'locality',
          countryCode: 'US',
          canonicalName: 'The Woodlands',
          centerLat: 30.16,
          centerLng: -95.46,
          radiusKm: 8,
          aliases: [],
        },
      ],
      { locationGrouping: { radiusCaptureEnabled: false, maxRadiusKm: 50, suggestionMinItems: 1 } },
    );

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Sterling Ridge' },
      { lat: 30.16, lng: -95.46 },
    );
    expect(out.geoCanonicalLocality).toBe('Sterling Ridge');
  });

  it("a group's radius is clamped to maxRadiusKm", async () => {
    const { service } = makeService(
      [
        {
          level: 'locality',
          countryCode: 'US',
          canonicalName: 'Overreaching Group',
          centerLat: 30.0,
          centerLng: -95.0,
          radiusKm: 5000,
          aliases: [],
        },
      ],
      { locationGrouping: { radiusCaptureEnabled: true, maxRadiusKm: 10, suggestionMinItems: 1 } },
    );

    // ~110 km away: inside the declared 5000 km, outside the clamped 10 km.
    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'Somewhere' },
      { lat: 31.0, lng: -95.0 },
    );
    expect(out.geoCanonicalLocality).toBe('Somewhere');
  });

  it('a radius area only claims items at its own level', async () => {
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'The Woodlands',
        centerLat: 30.16,
        centerLng: -95.46,
        radiusKm: 8,
        aliases: [],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: 'Texas', geoLocality: null },
      { lat: 30.16, lng: -95.46 },
    );
    expect(out.geoCanonicalAdmin1).toBe('Texas');
    expect(out.geoCanonicalLocality).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Feature gate
  // -------------------------------------------------------------------------

  it('is the IDENTITY FUNCTION when the feature flag is off', async () => {
    const { service, findMany } = makeService(
      [
        {
          level: 'locality',
          countryCode: 'US',
          canonicalName: 'New York City',
          centerLat: null,
          centerLng: null,
          radiusKm: null,
          aliases: [{ level: 'locality', countryCode: 'US', normalizedValue: 'nyc' }],
        },
      ],
      { features: { locationGrouping: false } },
    );

    const out = await service.resolve(
      { geoCountry: 'USA', geoCountryCode: 'US', geoAdmin1: 'NY', geoLocality: 'NYC' },
      null,
    );

    expect(out).toEqual({
      geoCanonicalCountry: 'USA',
      geoCanonicalAdmin1: 'NY',
      geoCanonicalLocality: 'NYC',
    });
    // Identity means it never even loads the group table.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is the IDENTITY FUNCTION when LOCATION_GROUPING_ENABLED=false overrides an ON flag', async () => {
    process.env['LOCATION_GROUPING_ENABLED'] = 'false';
    const { service } = makeService([
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'New York City',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'locality', countryCode: 'US', normalizedValue: 'nyc' }],
      },
    ]);

    const out = await service.resolve(
      { geoCountry: null, geoCountryCode: 'US', geoAdmin1: null, geoLocality: 'NYC' },
      null,
    );
    expect(out.geoCanonicalLocality).toBe('NYC');
  });

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  describe('snapshot cache', () => {
    const groups: GroupRow[] = [
      {
        level: 'locality',
        countryCode: 'US',
        canonicalName: 'New York City',
        centerLat: null,
        centerLng: null,
        radiusKm: null,
        aliases: [{ level: 'locality', countryCode: 'US', normalizedValue: 'nyc' }],
      },
    ];

    it('does NOT re-query within the TTL', async () => {
      const { service, findMany } = makeService(groups);

      await service.getSnapshot();
      await service.getSnapshot();
      await service.getSnapshot();

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates CONCURRENT cold loads into one query', async () => {
      const { service, findMany } = makeService(groups);

      await Promise.all([service.getSnapshot(), service.getSnapshot(), service.getSnapshot()]);

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('invalidate() forces a re-query on the very next read', async () => {
      const { service, findMany } = makeService(groups);

      await service.getSnapshot();
      expect(findMany).toHaveBeenCalledTimes(1);

      service.invalidate();
      await service.getSnapshot();
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('re-queries once the TTL has elapsed', async () => {
      const { service, findMany } = makeService(groups);

      const now = Date.now();
      const spy = jest.spyOn(Date, 'now');
      spy.mockReturnValue(now);
      await service.getSnapshot();
      expect(findMany).toHaveBeenCalledTimes(1);

      spy.mockReturnValue(now + 31_000); // > 30 s TTL
      await service.getSnapshot();
      expect(findMany).toHaveBeenCalledTimes(2);

      spy.mockRestore();
    });
  });
});
