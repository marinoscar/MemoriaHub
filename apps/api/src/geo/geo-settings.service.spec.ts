/**
 * Unit tests for GeoSettingsService.
 *
 * Tests:
 *   - getSettings masks credential to last4 (never exposes encryptedKey or plaintext)
 *   - upsertCredential encrypts apiKey + stores last4; rejects unknown providers
 *   - setActiveReverseProvider rejects 'google' without an enabled credential (400)
 *   - deleteCredential removes the row; throws 404 when not found
 *   - testProvider delegates to the correct provider
 *
 * SECRETS_ENCRYPTION_KEY is set to a valid test value so encrypt/decrypt round-trips work.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GeoSettingsService } from './geo-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { GoogleGeoLocationProvider } from '../media/geo/google-geo-location.provider';
import { OfflineGeoLocationProvider } from '../media/geo/offline-geo-location.provider';
import { NominatimGeoLocationProvider } from '../media/geo/nominatim-geo-location.provider';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { encryptSecret } from '../common/crypto/secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeoSettingsService', () => {
  let service: GeoSettingsService;
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let mockGoogle: { reverseGeocodeWithKey: jest.Mock };
  let mockOffline: { reverseGeocode: jest.Mock };
  let mockNominatim: { reverseGeocode: jest.Mock };
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
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({}),
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };
    mockGoogle = { reverseGeocodeWithKey: jest.fn() };
    mockOffline = { reverseGeocode: jest.fn() };
    mockNominatim = { reverseGeocode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeoSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: GoogleGeoLocationProvider, useValue: mockGoogle },
        { provide: OfflineGeoLocationProvider, useValue: mockOffline },
        { provide: NominatimGeoLocationProvider, useValue: mockNominatim },
      ],
    }).compile();

    service = module.get<GeoSettingsService>(GeoSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getSettings
  // -------------------------------------------------------------------------

  describe('getSettings', () => {
    it('never exposes encryptedKey in the response', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        enabled: true,
        last4: 'abcd',
        baseUrl: null,
        encryptedKey: 'some-cipher-text',
      } as any);

      const result = await service.getSettings();

      const str = JSON.stringify(result);
      expect(str).not.toContain('encryptedKey');
      expect(str).not.toContain('some-cipher-text');
    });

    it('returns configured:true and last4 when credential exists', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        enabled: true,
        last4: '1234',
        baseUrl: null,
      } as any);

      const result = await service.getSettings();

      const googleProvider = result.providers.find((p) => p.provider === 'google');
      expect(googleProvider).toBeDefined();
      expect(googleProvider!.configured).toBe(true);
      expect(googleProvider!.last4).toBe('1234');
    });

    it('returns configured:false and last4:null when no credential', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

      const result = await service.getSettings();

      const googleProvider = result.providers.find((p) => p.provider === 'google');
      expect(googleProvider!.configured).toBe(false);
      expect(googleProvider!.last4).toBeNull();
    });

    it('returns activeReverseProvider from system settings', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ geo: { reverseProvider: 'nominatim' } });
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

      const result = await service.getSettings();

      expect(result.activeReverseProvider).toBe('nominatim');
    });

    it('defaults activeReverseProvider to "offline" when not set', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({});
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

      // Override env to ensure deterministic default
      const saved = process.env['GEO_PROVIDER'];
      delete process.env['GEO_PROVIDER'];

      const result = await service.getSettings();

      if (saved !== undefined) process.env['GEO_PROVIDER'] = saved;

      expect(result.activeReverseProvider).toBe('offline');
    });
  });

  // -------------------------------------------------------------------------
  // upsertCredential
  // -------------------------------------------------------------------------

  describe('upsertCredential', () => {
    it('stores last4 (final 4 chars of apiKey)', async () => {
      const upserted = {
        provider: 'google',
        encryptedKey: 'cipher',
        last4: '5678',
        baseUrl: null,
        enabled: true,
        updatedByUserId: 'user-1',
      };
      mockPrisma.geoProviderCredential.upsert.mockResolvedValue(upserted as any);

      await service.upsertCredential('google', { apiKey: 'AIza-test-5678' }, 'user-1');

      const call = mockPrisma.geoProviderCredential.upsert.mock.calls[0][0];
      expect(call.create.last4).toBe('5678');
    });

    it('encrypts the apiKey (does not store plaintext)', async () => {
      const plainApiKey = 'AIza-test-9999';
      mockPrisma.geoProviderCredential.upsert.mockResolvedValue({
        provider: 'google',
        encryptedKey: 'cipher',
        last4: '9999',
        baseUrl: null,
        enabled: true,
        updatedByUserId: 'user-1',
      } as any);

      await service.upsertCredential('google', { apiKey: plainApiKey }, 'user-1');

      const call = mockPrisma.geoProviderCredential.upsert.mock.calls[0][0];
      expect(call.create.encryptedKey).not.toBe(plainApiKey);
      expect(typeof call.create.encryptedKey).toBe('string');
    });

    it('does not expose encryptedKey in the return value', async () => {
      mockPrisma.geoProviderCredential.upsert.mockResolvedValue({
        provider: 'google',
        encryptedKey: 'secret-cipher-text',
        last4: 'abcd',
        baseUrl: null,
        enabled: true,
        updatedByUserId: 'user-1',
      } as any);

      const result = await service.upsertCredential(
        'google',
        { apiKey: 'AIza-test-abcd' },
        'user-1',
      );

      expect(JSON.stringify(result)).not.toContain('encryptedKey');
      expect(JSON.stringify(result)).not.toContain('secret-cipher-text');
    });

    it('returns configured:true', async () => {
      mockPrisma.geoProviderCredential.upsert.mockResolvedValue({
        provider: 'google',
        encryptedKey: 'cipher',
        last4: '1234',
        baseUrl: null,
        enabled: true,
        updatedByUserId: 'user-1',
      } as any);

      const result = await service.upsertCredential('google', { apiKey: 'test-1234' }, 'u1');

      expect(result.configured).toBe(true);
    });

    it('passes baseUrl through when provided', async () => {
      mockPrisma.geoProviderCredential.upsert.mockResolvedValue({
        provider: 'google',
        encryptedKey: 'cipher',
        last4: '0000',
        baseUrl: 'https://custom.example.com',
        enabled: true,
        updatedByUserId: 'user-1',
      } as any);

      await service.upsertCredential(
        'google',
        { apiKey: 'AIza-0000', baseUrl: 'https://custom.example.com' },
        'user-1',
      );

      const call = mockPrisma.geoProviderCredential.upsert.mock.calls[0][0];
      expect(call.create.baseUrl).toBe('https://custom.example.com');
    });

    it('throws BadRequestException for unsupported provider', async () => {
      await expect(
        service.upsertCredential('unsupported', { apiKey: 'test' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // setActiveReverseProvider
  // -------------------------------------------------------------------------

  describe('setActiveReverseProvider', () => {
    it('calls patchSettings with the selected provider', async () => {
      await service.setActiveReverseProvider('offline', 'user-1');

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ geo: { reverseProvider: 'offline' } }),
        'user-1',
      );
    });

    it('accepts "nominatim" without credential check', async () => {
      await expect(
        service.setActiveReverseProvider('nominatim', 'user-1'),
      ).resolves.toEqual({ reverseProvider: 'nominatim' });

      expect(mockPrisma.geoProviderCredential.findUnique).not.toHaveBeenCalled();
    });

    it('returns { reverseProvider } on success', async () => {
      const result = await service.setActiveReverseProvider('offline', 'user-1');

      expect(result).toEqual({ reverseProvider: 'offline' });
    });

    describe('setting google without an enabled credential', () => {
      it('throws BadRequestException when credential is absent', async () => {
        mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

        await expect(
          service.setActiveReverseProvider('google', 'user-1'),
        ).rejects.toThrow(BadRequestException);
      });

      it('throws BadRequestException when credential is disabled', async () => {
        mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
          provider: 'google',
          encryptedKey: encryptSecret('some-key'),
          enabled: false,
          last4: 'abcd',
          baseUrl: null,
        } as any);

        await expect(
          service.setActiveReverseProvider('google', 'user-1'),
        ).rejects.toThrow(BadRequestException);
      });

      it('does not call patchSettings when validation fails', async () => {
        mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

        await expect(
          service.setActiveReverseProvider('google', 'user-1'),
        ).rejects.toThrow(BadRequestException);

        expect(mockSystemSettings.patchSettings).not.toHaveBeenCalled();
      });
    });

    it('accepts "google" when credential exists and is enabled', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        encryptedKey: encryptSecret('AIza-valid'),
        enabled: true,
        last4: 'alid',
        baseUrl: null,
      } as any);

      await expect(
        service.setActiveReverseProvider('google', 'user-1'),
      ).resolves.toEqual({ reverseProvider: 'google' });
    });
  });

  // -------------------------------------------------------------------------
  // deleteCredential
  // -------------------------------------------------------------------------

  describe('deleteCredential', () => {
    it('deletes the credential when it exists', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        encryptedKey: 'cipher',
        last4: 'abcd',
        baseUrl: null,
        enabled: true,
      } as any);
      mockPrisma.geoProviderCredential.delete.mockResolvedValue({} as any);

      await service.deleteCredential('google', 'user-1');

      expect(mockPrisma.geoProviderCredential.delete).toHaveBeenCalledWith({
        where: { provider: 'google' },
      });
    });

    it('throws NotFoundException when credential does not exist', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

      await expect(service.deleteCredential('google', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException for unsupported provider', async () => {
      await expect(service.deleteCredential('unsupported', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // testProvider
  // -------------------------------------------------------------------------

  describe('testProvider', () => {
    it('calls the google provider and returns ok:true with a sample', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue({
        provider: 'google',
        encryptedKey: encryptSecret('AIza-test-key'),
        enabled: true,
        last4: 'tkey',
        baseUrl: null,
      } as any);
      mockGoogle.reverseGeocodeWithKey.mockResolvedValue({
        country: 'Costa Rica',
        locality: 'San José',
        placeName: 'San José, Costa Rica',
      });

      const result = await service.testProvider({ provider: 'google' });

      expect(result.ok).toBe(true);
      expect(result).toHaveProperty('sample');
      expect((result as any).sample.country).toBe('Costa Rica');
    });

    it('returns ok:false for google when credential is absent', async () => {
      mockPrisma.geoProviderCredential.findUnique.mockResolvedValue(null);

      const result = await service.testProvider({ provider: 'google' });

      expect(result.ok).toBe(false);
      expect((result as any).error).toBeTruthy();
    });

    it('calls the offline provider and returns ok:true', async () => {
      mockOffline.reverseGeocode.mockResolvedValue({
        country: 'Costa Rica',
        locality: 'La Fortuna',
        placeName: 'La Fortuna, CR',
      });

      const result = await service.testProvider({ provider: 'offline' });

      expect(mockOffline.reverseGeocode).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('calls nominatim and returns ok:true', async () => {
      mockNominatim.reverseGeocode.mockResolvedValue({
        country: 'Germany',
        locality: 'Berlin',
        placeName: 'Berlin, Germany',
      });

      const result = await service.testProvider({ provider: 'nominatim' });

      expect(mockNominatim.reverseGeocode).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it('returns ok:false when provider returns null', async () => {
      mockOffline.reverseGeocode.mockResolvedValue(null);

      const result = await service.testProvider({ provider: 'offline' });

      expect(result.ok).toBe(false);
    });

    it('returns ok:false when provider throws', async () => {
      mockOffline.reverseGeocode.mockRejectedValue(new Error('Provider exploded'));

      const result = await service.testProvider({ provider: 'offline' });

      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('Provider exploded');
    });

    it('uses the provided lat/lng override', async () => {
      mockOffline.reverseGeocode.mockResolvedValue({
        country: 'X',
        locality: 'Y',
        placeName: 'Y, X',
      });

      await service.testProvider({ provider: 'offline', lat: 1.23, lng: 4.56 });

      expect(mockOffline.reverseGeocode).toHaveBeenCalledWith(1.23, 4.56);
    });
  });
});
