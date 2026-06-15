import { geoResultToMediaColumns, GEO_CLEAR_COLUMNS } from './geo-result.mapper';

describe('geoResultToMediaColumns', () => {
  it('maps all tiers and sets geoSource and geocodedAt', () => {
    const result = geoResultToMediaColumns(
      {
        country: 'Costa Rica',
        countryCode: 'CR',
        admin1: 'San Jose',
        admin2: 'Central',
        locality: 'Escazu',
        placeName: 'Mall',
      },
      'manual',
    );

    expect(result.geoCountry).toBe('Costa Rica');
    expect(result.geoCountryCode).toBe('CR');
    expect(result.geoAdmin1).toBe('San Jose');
    expect(result.geoAdmin2).toBe('Central');
    expect(result.geoLocality).toBe('Escazu');
    expect(result.geoPlaceName).toBe('Mall');
    expect(result.geoSource).toBe('manual');
    expect(result.geocodedAt).toBeInstanceOf(Date);
  });

  it('absent tiers are set to null', () => {
    const result = geoResultToMediaColumns({}, 'manual');

    expect(result.geoCountry).toBeNull();
    expect(result.geoCountryCode).toBeNull();
    expect(result.geoAdmin1).toBeNull();
    expect(result.geoAdmin2).toBeNull();
    expect(result.geoLocality).toBeNull();
    expect(result.geoPlaceName).toBeNull();
  });

  it('geoSource is set from the source argument', () => {
    const result = geoResultToMediaColumns({}, 'automatic');

    expect(result.geoSource).toBe('automatic');
  });
});

describe('GEO_CLEAR_COLUMNS', () => {
  it('nulls all coordinate and geo fields', () => {
    expect(GEO_CLEAR_COLUMNS).toMatchObject({
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
    });
  });
});
