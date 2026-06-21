/**
 * Unit tests for GoogleGeoLocationProvider.
 *
 * Tests reverseGeocodeWithKey — parses address_components and formatted_address
 * into GeoLocationResult, and returns null on non-OK statuses.
 * Mocks global fetch.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { GoogleGeoLocationProvider } from './google-geo-location.provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeAddressComponent(
  longName: string,
  shortName: string,
  types: string[],
) {
  return { long_name: longName, short_name: shortName, types };
}

const FULL_RESULT = {
  status: 'OK',
  results: [
    {
      formatted_address: 'La Fortuna, Costa Rica',
      address_components: [
        makeAddressComponent('Costa Rica', 'CR', ['country', 'political']),
        makeAddressComponent('Alajuela Province', 'Alajuela Province', [
          'administrative_area_level_1',
          'political',
        ]),
        makeAddressComponent('San Carlos Canton', 'San Carlos Canton', [
          'administrative_area_level_2',
          'political',
        ]),
        makeAddressComponent('La Fortuna', 'La Fortuna', [
          'locality',
          'political',
        ]),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleGeoLocationProvider', () => {
  let provider: GoogleGeoLocationProvider;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GoogleGeoLocationProvider],
    }).compile();

    provider = module.get<GoogleGeoLocationProvider>(GoogleGeoLocationProvider);
  });

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — full result
  // -------------------------------------------------------------------------

  describe('successful geocoding', () => {
    it('parses country and countryCode from address_components', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(FULL_RESULT));

      const result = await provider.reverseGeocodeWithKey(9.9281, -84.0907, 'test-key');

      expect(result).not.toBeNull();
      expect(result!.country).toBe('Costa Rica');
      expect(result!.countryCode).toBe('CR');
    });

    it('parses admin1 (administrative_area_level_1 long_name)', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(FULL_RESULT));

      const result = await provider.reverseGeocodeWithKey(9.9281, -84.0907, 'test-key');

      expect(result!.admin1).toBe('Alajuela Province');
    });

    it('parses admin2 (administrative_area_level_2 long_name)', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(FULL_RESULT));

      const result = await provider.reverseGeocodeWithKey(9.9281, -84.0907, 'test-key');

      expect(result!.admin2).toBe('San Carlos Canton');
    });

    it('parses locality from address_components', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(FULL_RESULT));

      const result = await provider.reverseGeocodeWithKey(9.9281, -84.0907, 'test-key');

      expect(result!.locality).toBe('La Fortuna');
    });

    it('sets placeName to formatted_address', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(FULL_RESULT));

      const result = await provider.reverseGeocodeWithKey(9.9281, -84.0907, 'test-key');

      expect(result!.placeName).toBe('La Fortuna, Costa Rica');
    });

    it('falls back to postal_town when locality is absent', async () => {
      const responseWithPostalTown = {
        status: 'OK',
        results: [
          {
            formatted_address: 'Somewhere, UK',
            address_components: [
              makeAddressComponent('United Kingdom', 'GB', ['country', 'political']),
              makeAddressComponent('Brighton', 'Brighton', ['postal_town']),
            ],
          },
        ],
      };

      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(responseWithPostalTown));

      const result = await provider.reverseGeocodeWithKey(50.82, -0.14, 'test-key');

      expect(result!.locality).toBe('Brighton');
    });

    it('builds the URL with lat, lng and apiKey', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(FULL_RESULT));

      await provider.reverseGeocodeWithKey(9.9281, -84.0907, 'my-api-key');

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('latlng=9.9281,-84.0907');
      expect(calledUrl).toContain('key=my-api-key');
      expect(calledUrl).toContain('maps.googleapis.com');
    });
  });

  // -------------------------------------------------------------------------
  // Non-OK statuses — must return null
  // -------------------------------------------------------------------------

  describe('ZERO_RESULTS', () => {
    it('returns null', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse({ status: 'ZERO_RESULTS', results: [] }));

      const result = await provider.reverseGeocodeWithKey(0, 0, 'key');

      expect(result).toBeNull();
    });
  });

  describe('REQUEST_DENIED', () => {
    it('returns null', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeResponse({
          status: 'REQUEST_DENIED',
          results: [],
          error_message: 'API key not authorized',
        }),
      );

      const result = await provider.reverseGeocodeWithKey(9.9, -84.0, 'bad-key');

      expect(result).toBeNull();
    });

    it('does not throw even with an error_message', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        makeResponse({
          status: 'REQUEST_DENIED',
          results: [],
          error_message: 'Billing disabled',
        }),
      );

      await expect(
        provider.reverseGeocodeWithKey(9.9, -84.0, 'key'),
      ).resolves.toBeNull();
    });
  });

  describe('non-OK status (e.g. OVER_QUERY_LIMIT)', () => {
    it('returns null', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse({ status: 'OVER_QUERY_LIMIT', results: [] }));

      const result = await provider.reverseGeocodeWithKey(9.9, -84.0, 'key');

      expect(result).toBeNull();
    });
  });

  describe('empty results array on OK status', () => {
    it('returns null when results array is empty', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse({ status: 'OK', results: [] }));

      const result = await provider.reverseGeocodeWithKey(9.9, -84.0, 'key');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Fetch error
  // -------------------------------------------------------------------------

  describe('network error', () => {
    it('returns null when fetch throws', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('Network timeout'));

      const result = await provider.reverseGeocodeWithKey(9.9, -84.0, 'key');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Partial address_components (missing types)
  // -------------------------------------------------------------------------

  describe('partial address components', () => {
    it('returns undefined for missing component types', async () => {
      const partial = {
        status: 'OK',
        results: [
          {
            formatted_address: 'Costa Rica',
            address_components: [
              makeAddressComponent('Costa Rica', 'CR', ['country', 'political']),
              // No admin1, admin2, locality
            ],
          },
        ],
      };

      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeResponse(partial));

      const result = await provider.reverseGeocodeWithKey(9.0, -84.0, 'key');

      expect(result!.country).toBe('Costa Rica');
      expect(result!.admin1).toBeUndefined();
      expect(result!.admin2).toBeUndefined();
      expect(result!.locality).toBeUndefined();
    });
  });
});
