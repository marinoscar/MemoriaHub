/**
 * Unit tests for FaceSettingsService (credential store edition, RETRO-B4 #617).
 *
 * A face provider's secret (none today: CompreFace is keyless) is the platform credential
 * `face_provider/<provider>`; `baseUrl` and `enabled` are the `face.providers.<provider>` settings.
 * The legacy `face_provider_credentials` table is never read or written.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FaceSettingsService } from '../../src/face/face-settings.service.js';
import { FaceProviderRegistry } from '../../src/face/providers/face-provider.registry.js';
import { MEMORIAHUB_SECRETS } from '../../src/ports/index.js';
import { FaceSystemSettings } from '../../src/face/host/face-system-settings.js';
import { FakeCredentials } from './support/fake-credentials.js';

const PURPOSE = 'face_provider';
const CAPS = { detect: true, embed: true };

describe('FaceSettingsService', () => {
  let service: FaceSettingsService;
  let creds: FakeCredentials;
  let face: Record<string, unknown> | null;
  let mockRegistry: { get: jest.Mock; keys: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock; patchFace: jest.Mock };
  const keyless = { capabilities: CAPS, requiresCredentials: false };
  const keyed = { capabilities: CAPS, requiresCredentials: true };

  beforeEach(async () => {
    creds = new FakeCredentials();
    face = null;
    mockRegistry = {
      get: jest.fn().mockReturnValue(keyless),
      keys: jest.fn().mockReturnValue(['compreface']),
    };
    mockSystemSettings = {
      getSettings: jest.fn(async () => ({ face })),
      patchFace: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceSettingsService,
        { provide: MEMORIAHUB_SECRETS, useValue: creds },
        { provide: FaceProviderRegistry, useValue: mockRegistry },
        { provide: FaceSystemSettings, useValue: mockSystemSettings },
      ],
    }).compile();
    service = module.get(FaceSettingsService);
  });

  describe('getSettings', () => {
    it('lists keyless compreface as configured with the env/default base URL when nothing is stored', async () => {
      delete process.env.FACE_COMPREFACE_URL;
      const r = await service.getSettings();
      expect(r.providers).toEqual([
        {
          provider: 'compreface',
          configured: true,
          enabled: true,
          requiresCredentials: false,
          last4: null,
          baseUrl: 'http://compreface-core:3000',
          capabilities: CAPS,
        },
      ]);
      expect(r.knownProviders).toEqual([]);
    });

    it('reads the stored override and enabled flag from the face settings', async () => {
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: false } } };
      const cf = (await service.getSettings()).providers[0];
      expect(cf).toMatchObject({ enabled: false, baseUrl: 'http://cf:8000', last4: null });
    });

    it('returns last4 from the credential hint when a key is stored, never the key', async () => {
      creds.seed(PURPOSE, 'compreface', 'cf-test-secret-1234');
      const r = await service.getSettings();
      expect(r.providers[0].last4).toBe('1234');
      const json = JSON.stringify(r);
      expect(json).not.toContain('cf-test-secret');
      expect(json).not.toMatch(/encryptedKey|apiKey/);
    });

    it('lists an unconfigured credentialed provider in knownProviders', async () => {
      mockRegistry.keys.mockReturnValue(['compreface', 'other-provider']);
      mockRegistry.get.mockImplementation((k: string) => (k === 'other-provider' ? keyed : keyless));
      const r = await service.getSettings();
      expect(r.knownProviders.map((p) => p.provider)).toEqual(['other-provider']);
      expect(r.knownProviders[0]).toMatchObject({ configured: false, requiresCredentials: true });
      expect(r.providers.map((p) => p.provider)).toEqual(['compreface']);
    });

    it('returns default and stored feature settings', async () => {
      expect((await service.getSettings()).features).toEqual({ detection: { provider: null, model: null } });
      face = { features: { detection: { provider: 'compreface', model: 'm1' } } };
      expect((await service.getSettings()).features.detection).toEqual({ provider: 'compreface', model: 'm1' });
    });
  });

  describe('upsertCredential', () => {
    it('writes a key to the credential store and the non-secret half to the face settings', async () => {
      const r = await service.upsertCredential(
        'compreface',
        { apiKey: 'cf-test-1234abcd', baseUrl: 'http://cf:8000', enabled: false },
        'user-1',
      );
      expect(creds.set).toHaveBeenCalledWith(PURPOSE, 'compreface', 'cf-test-1234abcd', 'user-1');
      expect(mockSystemSettings.patchFace).toHaveBeenCalledWith(
        { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: false } } },
        'user-1',
      );
      expect(JSON.stringify(mockSystemSettings.patchFace.mock.calls)).not.toContain('cf-test-1234abcd');
      expect(r).toMatchObject({ provider: 'compreface', configured: true, last4: 'abcd' });
      expect(JSON.stringify(r)).not.toContain('cf-test-1234abcd');
    });

    it('works with baseUrl only (keyless): no secret is written', async () => {
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: true } } };
      const r = await service.upsertCredential('compreface', { baseUrl: 'http://cf:8000' }, 'user-1');
      expect(creds.set).not.toHaveBeenCalled();
      expect(mockSystemSettings.patchFace).toHaveBeenCalledWith(
        { providers: { compreface: { baseUrl: 'http://cf:8000' } } },
        'user-1',
      );
      expect(r).toEqual({ provider: 'compreface', configured: true, enabled: true, last4: null, baseUrl: 'http://cf:8000' });
    });

    it('a blank key preserves a stored one', async () => {
      creds.seed(PURPOSE, 'compreface', 'cf-test-1234abcd');
      await service.upsertCredential('compreface', { apiKey: '' }, 'u');
      expect(creds.rows.get(`${PURPOSE}/compreface`)?.secret).toBe('cf-test-1234abcd');
    });

    it('clears baseUrl when none is sent (the legacy overwrite rule)', async () => {
      await service.upsertCredential('compreface', {}, 'u');
      expect(mockSystemSettings.patchFace).toHaveBeenCalledWith(
        { providers: { compreface: { baseUrl: null } } },
        'u',
      );
    });

    it('rejects a provider that has no settings slot', async () => {
      mockRegistry.keys.mockReturnValue(['compreface', 'other']);
      await expect(service.upsertCredential('other', {}, 'u')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rethrows the registry error for an unknown provider', async () => {
      mockRegistry.get.mockImplementation(() => {
        throw new Error('Unknown face provider: x');
      });
      await expect(service.upsertCredential('x', {}, 'u')).rejects.toThrow(/Unknown face provider/);
    });
  });

  describe('deleteCredential', () => {
    it('throws NotFoundException when neither a secret nor an override exists', async () => {
      await expect(service.deleteCredential('compreface', 'u')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes the secret and resets the override', async () => {
      creds.seed(PURPOSE, 'compreface', 'cf-test-1234abcd');
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: true } } };
      await service.deleteCredential('compreface', 'u');
      expect(creds.delete).toHaveBeenCalledWith(PURPOSE, 'compreface', 'u');
      expect(mockSystemSettings.patchFace).toHaveBeenCalledWith(
        { providers: { compreface: { baseUrl: null, enabled: true } } },
        'u',
      );
    });

    it('resets an override with no secret without touching the store', async () => {
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: true } } };
      await service.deleteCredential('compreface', 'u');
      expect(creds.delete).not.toHaveBeenCalled();
      expect(mockSystemSettings.patchFace).toHaveBeenCalled();
    });
  });

  describe('resolveCredentials', () => {
    it('keyless: {} with no override', async () => {
      expect(await service.resolveCredentials('compreface')).toEqual({});
    });

    it('keyless: {baseUrl} with an enabled override', async () => {
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: true } } };
      expect(await service.resolveCredentials('compreface')).toEqual({ baseUrl: 'http://cf:8000' });
    });

    it('keyless: ignores a disabled override', async () => {
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: false } } };
      expect(await service.resolveCredentials('compreface')).toEqual({});
    });

    it('credentialed: returns the stored key round-trip and baseUrl', async () => {
      mockRegistry.get.mockReturnValue(keyed);
      creds.seed(PURPOSE, 'compreface', 'cf-real-key-0000');
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: true } } };
      expect(await service.resolveCredentials('compreface')).toEqual({ apiKey: 'cf-real-key-0000', baseUrl: 'http://cf:8000' });
    });

    it('credentialed: not configured / disabled are 400s naming the provider', async () => {
      mockRegistry.get.mockReturnValue(keyed);
      await expect(service.resolveCredentials('compreface')).rejects.toThrow(/"compreface" is not configured/);
      creds.seed(PURPOSE, 'compreface', 'cf-real-key-0000');
      face = { providers: { compreface: { baseUrl: null, enabled: false } } };
      await expect(service.resolveCredentials('compreface')).rejects.toThrow(/disabled/);
    });
  });

  describe('testProvider', () => {
    it('passes resolved credentials to testConnection', async () => {
      const testConnection = jest.fn().mockResolvedValue({ ok: true });
      mockRegistry.get.mockReturnValue({ ...keyless, testConnection });
      face = { providers: { compreface: { baseUrl: 'http://cf:8000', enabled: true } } };
      expect(await service.testProvider({ provider: 'compreface' })).toEqual({ ok: true });
      expect(testConnection).toHaveBeenCalledWith({ baseUrl: 'http://cf:8000' });
    });

    it('credentialed provider: passes the stored key', async () => {
      const testConnection = jest.fn().mockResolvedValue({ ok: true });
      mockRegistry.get.mockReturnValue({ ...keyed, testConnection });
      creds.seed(PURPOSE, 'compreface', 'cf-real-key-0000');
      await service.testProvider({ provider: 'compreface' });
      expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'cf-real-key-0000' }));
    });

    it('propagates an unconfigured credentialed provider error', async () => {
      mockRegistry.get.mockReturnValue(keyed);
      await expect(service.testProvider({ provider: 'compreface' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setDetectionFeature', () => {
    it('patches the nested detection feature and returns it', async () => {
      const r = await service.setDetectionFeature({ provider: 'compreface', model: 'm1' } as never, 'u');
      expect(mockSystemSettings.patchFace).toHaveBeenCalledWith(
        { features: { detection: { provider: 'compreface', model: 'm1' } } },
        'u',
      );
      expect(r).toEqual({ provider: 'compreface', model: 'm1' });
    });

    it('supports null provider and model (clearing the feature)', async () => {
      await expect(service.setDetectionFeature({ provider: null, model: null } as never, 'u')).resolves.toEqual({
        provider: null,
        model: null,
      });
    });
  });

  describe('listModels', () => {
    it('passes the stored key when configured and enabled', async () => {
      const listModels = jest.fn().mockResolvedValue(['arcface']);
      mockRegistry.get.mockReturnValue({ ...keyed, listModels });
      creds.seed(PURPOSE, 'compreface', 'cf-secret-key');
      expect(await service.listModels('compreface')).toEqual(['arcface']);
      expect(listModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'cf-secret-key' }));
    });

    it('passes an empty key when nothing is configured or the provider is disabled', async () => {
      const listModels = jest.fn().mockResolvedValue([]);
      mockRegistry.get.mockReturnValue({ ...keyed, listModels });
      await service.listModels('compreface');
      expect(listModels).toHaveBeenLastCalledWith({ apiKey: '' });

      creds.seed(PURPOSE, 'compreface', 'cf-secret-key');
      face = { providers: { compreface: { baseUrl: null, enabled: false } } };
      await service.listModels('compreface');
      expect(listModels).toHaveBeenLastCalledWith({ apiKey: '' });
    });

    it('throws for an unknown provider', async () => {
      mockRegistry.get.mockImplementation(() => {
        throw new Error('Unknown face provider: x');
      });
      await expect(service.listModels('x')).rejects.toThrow(/Unknown face provider/);
    });
  });
});
