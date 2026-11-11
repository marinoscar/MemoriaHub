/**
 * Unit tests for GeoLocationService.
 *
 * Tests dynamic active-provider resolution:
 *   - reads geo.reverseProvider from system settings
 *   - routes to offline / nominatim / google
 *   - for 'google': decrypts credential and calls the google provider
 *   - falls back to offline when google credential is absent or disabled
 *   - uses offline as default when setting is unset
 *
 * All dependencies are mocked — no DB, no network. The key comes from GeoGoogleCredentialResolver
 * (the credential store, RETRO-B4); `null` means absent or disabled.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { GeoLocationService } from '../../../src/location/geo/geo-location.service.js';
import { OfflineGeoLocationProvider } from '../../../src/location/geo/offline-geo-location.provider.js';
import { NominatimGeoLocationProvider } from '../../../src/location/geo/nominatim-geo-location.provider.js';
import { GoogleGeoLocationProvider } from '../../../src/location/geo/google-geo-location.provider.js';
import { GeoGoogleCredentialResolver } from '../../../src/location/geo/geo-google-credential.resolver.js';
import { MEMORIAHUB_SETTINGS } from '../../../src/ports/index.js';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OFFLINE_RESULT = {
  country: 'Costa Rica',
  countryCode: 'CR',
  locality: 'La Fortuna',
  placeName: 'La Fortuna, Costa Rica',
};

const GOOGLE_RESULT = {
  country: 'United States',
  countryCode: 'US',
  locality: 'San Francisco',
  placeName: 'San Francisco, CA, USA',
};

const NOMINATIM_RESULT = {
  country: 'Germany',
  countryCode: 'DE',
  locality: 'Berlin',
  placeName: 'Berlin, Germany',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeoLocationService', () => {
  let service: GeoLocationService;
  let mockGoogleCredential: { resolveApiKey: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock; readSystem: jest.Mock };
  let mockOffline: { reverseGeocode: jest.Mock };
  let mockNominatim: { reverseGeocode: jest.Mock };
  let mockGoogle: { reverseGeocodeWithKey: jest.Mock };
  beforeEach(async () => {
    mockGoogleCredential = { resolveApiKey: jest.fn().mockResolvedValue(null) };

    // The settings port answers one namespace at a time; the document is what each case seeds.
    const getSettings = jest.fn();
    mockSystemSettings = {
      getSettings,
      readSystem: jest.fn(async (name: string) => ({ value: ((await getSettings()) ?? {})[name], version: 1 })),
    };
    mockOffline = { reverseGeocode: jest.fn().mockResolvedValue(OFFLINE_RESULT) };
    mockNominatim = { reverseGeocode: jest.fn().mockResolvedValue(NOMINATIM_RESULT) };
    mockGoogle = { reverseGeocodeWithKey: jest.fn().mockResolvedValue(GOOGLE_RESULT) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeoLocationService,
        { provide: GeoGoogleCredentialResolver, useValue: mockGoogleCredential },
        { provide: MEMORIAHUB_SETTINGS, useValue: mockSystemSettings },
        { provide: OfflineGeoLocationProvider, useValue: mockOffline },
        { provide: NominatimGeoLocationProvider, useValue: mockNominatim },
        { provide: GoogleGeoLocationProvider, useValue: mockGoogle },
      ],
    }).compile();

    service = module.get<GeoLocationService>(GeoLocationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Non-finite coordinate guard (choke point for all providers)
  // -------------------------------------------------------------------------

  describe('when called with non-finite coordinates', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({});
    });

    it.each([
      ['NaN lat', NaN, -84.0907],
      ['NaN lng', 9.9281, NaN],
      ['both NaN', NaN, NaN],
      ['null lat', null as unknown as number, -84.0907],
      ['undefined lng', 9.9281, undefined as unknown as number],
      ['Infinity lat', Infinity, -84.0907],
      ['-Infinity lng', 9.9281, -Infinity],
    ])('short-circuits to a null result for %s', async (_label, lat, lng) => {
      const { result, source } = await service.reverseGeocode(lat, lng);

      expect(result).toBeNull();
      expect(source).toBe('none');
    });

    it('does not read system settings or call any provider', async () => {
      await service.reverseGeocode(NaN, NaN);

      expect(mockSystemSettings.readSystem).not.toHaveBeenCalled();
      expect(mockOffline.reverseGeocode).not.toHaveBeenCalled();
      expect(mockNominatim.reverseGeocode).not.toHaveBeenCalled();
      expect(mockGoogle.reverseGeocodeWithKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Default: offline
  // -------------------------------------------------------------------------

  describe('when geo.reverseProvider is not set in system settings', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({});
    });

    it('routes to the offline provider', async () => {
      const { result } = await service.reverseGeocode(9.9281, -84.0907);

      expect(mockOffline.reverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
      expect(result).toEqual(OFFLINE_RESULT);
    });

    it('returns source=geonames-offline', async () => {
      const { source } = await service.reverseGeocode(9.9281, -84.0907);

      expect(source).toBe('geonames-offline');
    });

    it('does not call nominatim or google', async () => {
      await service.reverseGeocode(9.9, -84.0);

      expect(mockNominatim.reverseGeocode).not.toHaveBeenCalled();
      expect(mockGoogle.reverseGeocodeWithKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Explicit offline
  // -------------------------------------------------------------------------

  describe('when geo.reverseProvider is "offline"', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'offline' } });
    });

    it('routes to the offline provider', async () => {
      const { result, source } = await service.reverseGeocode(9.9281, -84.0907);

      expect(mockOffline.reverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
      expect(source).toBe('geonames-offline');
      expect(result).toEqual(OFFLINE_RESULT);
    });
  });

  // -------------------------------------------------------------------------
  // Nominatim
  // -------------------------------------------------------------------------

  describe('when geo.reverseProvider is "nominatim"', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'nominatim' } });
    });

    it('routes to the nominatim provider', async () => {
      const { result, source } = await service.reverseGeocode(52.52, 13.405);

      expect(mockNominatim.reverseGeocode).toHaveBeenCalledWith(52.52, 13.405);
      expect(source).toBe('nominatim');
      expect(result).toEqual(NOMINATIM_RESULT);
    });

    it('does not call offline or google', async () => {
      await service.reverseGeocode(52.52, 13.405);

      expect(mockOffline.reverseGeocode).not.toHaveBeenCalled();
      expect(mockGoogle.reverseGeocodeWithKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Google — happy path
  // -------------------------------------------------------------------------

  describe('when geo.reverseProvider is "google" with a valid enabled credential', () => {
    const plainApiKey = 'AIzaSy-test-key';

    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'google' } });

      mockGoogleCredential.resolveApiKey.mockResolvedValue(plainApiKey);
    });

    it('resolves the stored key and calls the google provider', async () => {
      await service.reverseGeocode(37.7749, -122.4194);

      expect(mockGoogle.reverseGeocodeWithKey).toHaveBeenCalledWith(
        37.7749,
        -122.4194,
        plainApiKey,
      );
    });

    it('returns source=google', async () => {
      const { source } = await service.reverseGeocode(37.7749, -122.4194);

      expect(source).toBe('google');
    });

    it('returns the google provider result', async () => {
      const { result } = await service.reverseGeocode(37.7749, -122.4194);

      expect(result).toEqual(GOOGLE_RESULT);
    });

    it('does not call offline or nominatim', async () => {
      await service.reverseGeocode(37.7749, -122.4194);

      expect(mockOffline.reverseGeocode).not.toHaveBeenCalled();
      expect(mockNominatim.reverseGeocode).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Google — fallback when credential missing
  // -------------------------------------------------------------------------

  describe('when geo.reverseProvider is "google" but credential is absent', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'google' } });
      mockGoogleCredential.resolveApiKey.mockResolvedValue(null);
    });

    it('falls back to the offline provider', async () => {
      await service.reverseGeocode(9.9281, -84.0907);

      expect(mockOffline.reverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
    });

    it('returns source=geonames-offline on fallback', async () => {
      const { source } = await service.reverseGeocode(9.9281, -84.0907);

      expect(source).toBe('geonames-offline');
    });

    it('does not call the google provider', async () => {
      await service.reverseGeocode(9.9281, -84.0907);

      expect(mockGoogle.reverseGeocodeWithKey).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Google — fallback when credential is disabled
  // -------------------------------------------------------------------------

  describe('when geo.reverseProvider is "google" but credential is disabled', () => {
    beforeEach(() => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'google' } });
      mockGoogleCredential.resolveApiKey.mockResolvedValue(null); // switched off in settings
    });

    it('falls back to the offline provider', async () => {
      await service.reverseGeocode(9.9281, -84.0907);

      expect(mockOffline.reverseGeocode).toHaveBeenCalledWith(9.9281, -84.0907);
    });

    it('returns source=geonames-offline on fallback', async () => {
      const { source } = await service.reverseGeocode(9.9281, -84.0907);

      expect(source).toBe('geonames-offline');
    });
  });
});
