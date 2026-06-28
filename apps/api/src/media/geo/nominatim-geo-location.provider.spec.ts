/**
 * Unit tests for NominatimGeoLocationProvider.
 *
 * Mocks global fetch. The provider is constructed with a stub ConfigService
 * that returns the default Nominatim base URL.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { RateLimitError } from '../../enrichment/rate-limit.error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(nominatimUrl = 'https://nominatim.openstreetmap.org'): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'NOMINATIM_BASE_URL') return nominatimUrl;
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

/** Minimal successful Nominatim reverse-geocoding response. */
const FULL_RESPONSE = {
  display_name: 'La Fortuna, San Carlos, Alajuela, Costa Rica',
  address: {
    country: 'Costa Rica',
    country_code: 'cr',
    state: 'Alajuela Province',
    county: 'San Carlos',
    city: 'La Fortuna',
  },
};

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeHttpErrorResponse(
  status: number,
  retryAfter?: string,
): Response {
  const headerMap = new Map<string, string>();
  if (retryAfter) headerMap.set('retry-after', retryAfter);
  return {
    ok: false,
    status,
    headers: {
      get: (key: string) => headerMap.get(key.toLowerCase()) ?? null,
    },
    json: jest.fn().mockResolvedValue({}),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NominatimGeoLocationProvider', () => {
  let provider: NominatimGeoLocationProvider;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NominatimGeoLocationProvider,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    provider = module.get<NominatimGeoLocationProvider>(NominatimGeoLocationProvider);
  });

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('successful reverse geocoding', () => {
    it('returns a GeoLocationResult with country and countryCode', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result).not.toBeNull();
      expect(result!.country).toBe('Costa Rica');
      expect(result!.countryCode).toBe('CR'); // uppercased
    });

    it('returns admin1 from address.state', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result!.admin1).toBe('Alajuela Province');
    });

    it('returns admin2 from address.county', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result!.admin2).toBe('San Carlos');
    });

    it('returns locality from address.city', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result!.locality).toBe('La Fortuna');
    });

    it('falls back to town when city is absent', async () => {
      const response = {
        display_name: 'Some Town, Region',
        address: { country: 'Test Country', country_code: 'tc', town: 'MyTown' },
      };
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(response));

      const result = await provider.reverseGeocode(0, 0);

      expect(result!.locality).toBe('MyTown');
    });

    it('falls back to village when city and town are absent', async () => {
      const response = {
        display_name: 'Some Village',
        address: { country: 'Test Country', country_code: 'tc', village: 'MyVillage' },
      };
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(response));

      const result = await provider.reverseGeocode(0, 0);

      expect(result!.locality).toBe('MyVillage');
    });

    it('uppercases the country_code', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result!.countryCode).toBe('CR');
    });

    it('sets placeName from display_name', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result!.placeName).toBe(FULL_RESPONSE.display_name);
    });

    it('includes lat/lng in the request URL', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      await provider.reverseGeocode(10.47, -84.64);

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('lat=10.47');
      expect(calledUrl).toContain('lon=-84.64');
    });
  });

  // -------------------------------------------------------------------------
  // Rate-limit / server error — must throw RateLimitError
  // -------------------------------------------------------------------------

  describe('HTTP 429 (throttled)', () => {
    it('throws RateLimitError', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(429));

      await expect(provider.reverseGeocode(10.47, -84.64)).rejects.toBeInstanceOf(
        RateLimitError,
      );
    });

    it('thrown RateLimitError carries "nominatim" providerKey', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(429));

      await expect(provider.reverseGeocode(10.47, -84.64)).rejects.toMatchObject({
        providerKey: 'nominatim',
      });
    });

    it('parses Retry-After header into retryAfterMs', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(429, '30'));

      const err = await provider.reverseGeocode(10.47, -84.64).catch((e) => e);
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30_000);
    });

    it('retryAfterMs is undefined when Retry-After header is absent', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(429));

      const err = await provider.reverseGeocode(10.47, -84.64).catch((e) => e);
      expect((err as RateLimitError).retryAfterMs).toBeUndefined();
    });
  });

  describe('HTTP 5xx (server error)', () => {
    it('throws RateLimitError on HTTP 503', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(503));

      await expect(provider.reverseGeocode(10.47, -84.64)).rejects.toBeInstanceOf(
        RateLimitError,
      );
    });

    it('throws RateLimitError on HTTP 500', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(500));

      await expect(provider.reverseGeocode(10.47, -84.64)).rejects.toBeInstanceOf(
        RateLimitError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Non-throttle non-ok responses — must return null (not throw)
  // -------------------------------------------------------------------------

  describe('other non-ok HTTP status (e.g. 400)', () => {
    it('returns null without throwing', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(400));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result).toBeNull();
    });

    it('returns null for HTTP 404', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeHttpErrorResponse(404));

      const result = await provider.reverseGeocode(10.47, -84.64);

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Missing or empty address field — return null
  // -------------------------------------------------------------------------

  describe('response missing address field', () => {
    it('returns null when address is absent from response body', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(makeOkResponse({ display_name: 'Somewhere' }));

      const result = await provider.reverseGeocode(0, 0);

      expect(result).toBeNull();
    });

    it('returns null when response body is null/empty', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(null));

      const result = await provider.reverseGeocode(0, 0);

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Network errors — swallowed into null
  // -------------------------------------------------------------------------

  describe('network / fetch error', () => {
    it('returns null when fetch throws a network error', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.reverseGeocode(0, 0);

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Custom base URL
  // -------------------------------------------------------------------------

  describe('custom base URL from ConfigService', () => {
    it('uses the base URL returned by ConfigService', async () => {
      const customModule: TestingModule = await Test.createTestingModule({
        providers: [
          NominatimGeoLocationProvider,
          { provide: ConfigService, useValue: makeConfigService('https://nominatim.example.com') },
        ],
      }).compile();

      const customProvider = customModule.get<NominatimGeoLocationProvider>(
        NominatimGeoLocationProvider,
      );

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(makeOkResponse(FULL_RESPONSE));

      await customProvider.reverseGeocode(10.47, -84.64);

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('https://nominatim.example.com');
    });
  });
});
