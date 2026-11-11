/**
 * Unit tests for GeoSettingsService (credential store edition, RETRO-B4 #617).
 *
 *   - the Google key is the platform credential `geo_provider/google`; the legacy table is never touched
 *   - getSettings keeps the wire shape (configured / enabled / last4 / baseUrl) and never returns a secret
 *   - upsertCredential writes the secret to the store and the non-secret half to the `geo` settings
 *   - setActiveReverseProvider rejects 'google' without an enabled credential (400)
 *   - deleteCredential removes the secret; 404 when none
 *   - testProvider resolves the key through the resolver
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { GeoSettingsService } from './geo-settings.service';
import { GoogleGeoLocationProvider } from '../media/geo/google-geo-location.provider';
import { OfflineGeoLocationProvider } from '../media/geo/offline-geo-location.provider';
import { NominatimGeoLocationProvider } from '../media/geo/nominatim-geo-location.provider';
import { GeoGoogleCredentialResolver } from '../media/geo/geo-google-credential.resolver';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import { FakeCredentials } from '../../test/helpers/fake-credentials';

const PURPOSE = 'geo_provider';

describe('GeoSettingsService', () => {
  let service: GeoSettingsService;
  let creds: FakeCredentials;
  let geo: Record<string, unknown>;
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let mockGoogle: { reverseGeocodeWithKey: jest.Mock };
  let mockOffline: { reverseGeocode: jest.Mock };
  let mockNominatim: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    creds = new FakeCredentials();
    geo = {};
    mockSystemSettings = {
      getSettings: jest.fn(async () => ({ geo })),
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };
    mockGoogle = { reverseGeocodeWithKey: jest.fn() };
    mockOffline = { reverseGeocode: jest.fn() };
    mockNominatim = { reverseGeocode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeoSettingsService,
        GeoGoogleCredentialResolver,
        { provide: CredentialsService, useValue: creds },
        { provide: AppSystemSettingsService, useValue: mockSystemSettings },
        { provide: GoogleGeoLocationProvider, useValue: mockGoogle },
        { provide: OfflineGeoLocationProvider, useValue: mockOffline },
        { provide: NominatimGeoLocationProvider, useValue: mockNominatim },
      ],
    }).compile();
    service = module.get(GeoSettingsService);
  });

  describe('getSettings', () => {
    it('reports configured:false, enabled:false and no last4 without a credential', async () => {
      const result = await service.getSettings();
      expect(result.providers).toEqual([
        { provider: 'google', configured: false, enabled: false, last4: null, baseUrl: null },
      ]);
    });

    it('reports configured:true with last4 from the store hint and the non-secret settings', async () => {
      creds.seed(PURPOSE, 'google', 'AIza-test-5678');
      geo = { google: { enabled: false, baseUrl: 'https://maps.example.test' } };

      const result = await service.getSettings();

      expect(result.providers[0]).toEqual({
        provider: 'google',
        configured: true,
        enabled: false,
        last4: '5678',
        baseUrl: 'https://maps.example.test',
      });
    });

    it('maps a short secret (fully masked hint) to last4:null', async () => {
      creds.seed(PURPOSE, 'google', 'abc');
      const result = await service.getSettings();
      expect(result.providers[0].last4).toBeNull();
    });

    it('never exposes the secret anywhere in the response', async () => {
      creds.seed(PURPOSE, 'google', 'AIza-super-secret-5678');
      const json = JSON.stringify(await service.getSettings());
      expect(json).not.toContain('AIza-super-secret');
      expect(json).not.toMatch(/encryptedKey|apiKey/);
    });

    it('returns activeReverseProvider from system settings, defaulting to offline', async () => {
      geo = { reverseProvider: 'nominatim' };
      expect((await service.getSettings()).activeReverseProvider).toBe('nominatim');

      geo = {};
      const saved = process.env['GEO_PROVIDER'];
      delete process.env['GEO_PROVIDER'];
      const result = await service.getSettings();
      if (saved !== undefined) process.env['GEO_PROVIDER'] = saved;
      expect(result.activeReverseProvider).toBe('offline');
    });
  });

  describe('upsertCredential', () => {
    it('writes the key to the credential store with the actor, never to settings', async () => {
      await service.upsertCredential('google', { apiKey: 'AIza-test-5678' }, 'user-1');

      expect(creds.setSecret).toHaveBeenCalledWith(PURPOSE, 'google', 'AIza-test-5678', { updatedByUserId: 'user-1' });
      const patch = JSON.stringify(mockSystemSettings.patchSettings.mock.calls);
      expect(patch).not.toContain('AIza-test-5678');
    });

    it('patches baseUrl (overwrite) and enabled (only when sent) into geo.google', async () => {
      await service.upsertCredential('google', { apiKey: 'k-abcd1234', baseUrl: 'https://x.example.test', enabled: false }, 'user-1');
      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        { geo: { google: { baseUrl: 'https://x.example.test', enabled: false } } },
        'user-1',
      );

      mockSystemSettings.patchSettings.mockClear();
      await service.upsertCredential('google', { apiKey: 'k-abcd1234' }, 'user-1');
      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith({ geo: { google: { baseUrl: null } } }, 'user-1');
    });

    it('returns the same shape as before: last4, no secret', async () => {
      geo = { google: { enabled: true, baseUrl: null } };
      const result = await service.upsertCredential('google', { apiKey: 'AIza-test-5678' }, 'user-1');
      expect(result).toEqual({ provider: 'google', configured: true, enabled: true, last4: '5678', baseUrl: null });
      expect(JSON.stringify(result)).not.toContain('AIza-test');
    });

    it('rejects an unsupported provider without writing', async () => {
      await expect(service.upsertCredential('bing', { apiKey: 'k' }, 'u')).rejects.toBeInstanceOf(BadRequestException);
      expect(creds.setSecret).not.toHaveBeenCalled();
    });
  });

  describe('deleteCredential', () => {
    it('deletes the stored secret and resets the non-secret settings', async () => {
      creds.seed(PURPOSE, 'google', 'AIza-test-5678');
      await service.deleteCredential('google', 'user-1');
      expect(creds.deleteSecret).toHaveBeenCalledWith(PURPOSE, 'google');
      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith({ geo: { google: { baseUrl: null, enabled: true } } }, 'user-1');
    });

    it('throws NotFoundException when no credential exists', async () => {
      await expect(service.deleteCredential('google', 'u')).rejects.toBeInstanceOf(NotFoundException);
      expect(creds.deleteSecret).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an unsupported provider', async () => {
      await expect(service.deleteCredential('bing', 'u')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setActiveReverseProvider', () => {
    it('accepts google when an enabled credential exists', async () => {
      creds.seed(PURPOSE, 'google', 'k-12345678');
      await expect(service.setActiveReverseProvider('google', 'u')).resolves.toEqual({ reverseProvider: 'google' });
      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith({ geo: { reverseProvider: 'google' } }, 'u');
    });

    it('rejects google without a credential and does not patch', async () => {
      await expect(service.setActiveReverseProvider('google', 'u')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockSystemSettings.patchSettings).not.toHaveBeenCalled();
    });

    it('rejects google when the provider is switched off', async () => {
      creds.seed(PURPOSE, 'google', 'k-12345678');
      geo = { google: { enabled: false, baseUrl: null } };
      await expect(service.setActiveReverseProvider('google', 'u')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts nominatim without a credential check', async () => {
      await service.setActiveReverseProvider('nominatim', 'u');
      expect(creds.getSecret).not.toHaveBeenCalled();
    });
  });

  describe('testProvider', () => {
    const sample = { country: 'CR', locality: 'San Jose', placeName: 'Place A' };

    it('calls google with the stored key and returns a sample', async () => {
      creds.seed(PURPOSE, 'google', 'k-12345678');
      mockGoogle.reverseGeocodeWithKey.mockResolvedValue(sample);
      const r = await service.testProvider({ provider: 'google', lat: 1, lng: 2 } as never);
      expect(mockGoogle.reverseGeocodeWithKey).toHaveBeenCalledWith(1, 2, 'k-12345678');
      expect(r).toEqual({ ok: true, sample });
    });

    it('returns ok:false when google has no usable credential', async () => {
      const r = await service.testProvider({ provider: 'google' } as never);
      expect(r).toEqual({ ok: false, error: 'Google credential not configured or disabled' });
      expect(mockGoogle.reverseGeocodeWithKey).not.toHaveBeenCalled();
    });

    it('routes nominatim and offline', async () => {
      mockNominatim.reverseGeocode.mockResolvedValue(sample);
      mockOffline.reverseGeocode.mockResolvedValue(sample);
      expect((await service.testProvider({ provider: 'nominatim' } as never)).ok).toBe(true);
      expect((await service.testProvider({ provider: 'offline' } as never)).ok).toBe(true);
    });

    it('returns ok:false with the error message when a provider throws', async () => {
      mockOffline.reverseGeocode.mockRejectedValue(new Error('boom'));
      expect(await service.testProvider({ provider: 'offline' } as never)).toEqual({ ok: false, error: 'boom' });
    });
  });
});
