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
 * All dependencies are mocked — no DB, no network.
 * SECRETS_ENCRYPTION_KEY is set to a valid test value.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { GeoLocationService } from './geo-location.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { OfflineGeoLocationProvider } from './offline-geo-location.provider';
import { NominatimGeoLocationProvider } from './nominatim-geo-location.provider';
import { GoogleGeoLocationProvider } from './google-geo-location.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { encryptSecret } from '../../common/crypto/secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

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
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockOffline: { reverseGeocode: jest.Mock };
  let mockNominatim: { reverseGeocode: jest.Mock };
  let mockGoogle: { reverseGeocodeWithKey: jest.Mock };
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env['SECRETS_ENCRYPTION_KEY'];
    process.env['SECRETS_ENCRYPTION_KEY'] = VALID_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env['SECRETS_ENCRYPTION_KEY'];
    } else {
      process.env['SECRETS_ENCRYPTION_KEY'] = originalKey;
    }
  });

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockSystemSettings = { getSettings: jest.fn() };
    mockOffline = { reverseGeocode: jest.fn().mockResolvedValue(OFFLINE_RESULT) };
    mockNominatim = { reverseGeocode: jest.fn().mockResolvedValue(NOMINATIM_RESULT) };
    mockGoogle = { reverseGeocodeWithKey: jest.fn().mockResolvedValue(GOOGLE_RESULT) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeoLocationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
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

      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
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

      const encryptedKey = encryptSecret(plainApiKey);
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        encryptedKey,
        enabled: true,
        last4: 'test',
        baseUrl: null,
      } as any);
    });

    it('decrypts the credential and calls the google provider', async () => {
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
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);
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
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        encryptedKey: encryptSecret('some-key'),
        enabled: false,
        last4: 'abcd',
        baseUrl: null,
      } as any);
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
