/**
 * Unit tests for FaceSettingsService.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 * We set it in beforeAll and clean up in afterAll.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FaceSettingsService } from './face-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { encryptSecret } from '../common/crypto/secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('FaceSettingsService', () => {
  let service: FaceSettingsService;
  let mockPrisma: MockPrismaService;
  let mockRegistry: { get: jest.Mock; keys: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    } else {
      process.env.SECRETS_ENCRYPTION_KEY = originalKey;
    }
  });

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockRegistry = {
      get: jest.fn(),
      keys: jest.fn().mockReturnValue(['compreface', 'rekognition']),
    };
    mockSystemSettings = {
      getSettings: jest.fn(),
      patchSettings: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FaceProviderRegistry, useValue: mockRegistry },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<FaceSettingsService>(FaceSettingsService);
  });

  // ---------------------------------------------------------------------------
  // upsertCredential
  // ---------------------------------------------------------------------------
  describe('upsertCredential', () => {
    it('encrypts the apiKey and stores last4 correctly', async () => {
      const upsertedRecord = {
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: 'somebase64ciphertext',
        last4: '1234',
        baseUrl: 'http://cf:8000',
        region: null,
        enabled: true,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.faceProviderCredential.upsert.mockResolvedValue(upsertedRecord as any);

      const result = await service.upsertCredential(
        'compreface',
        { apiKey: 'cf-test-1234' },
        'user-1',
      );

      // Verify upsert was called with correct last4
      const upsertCall = mockPrisma.faceProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.last4).toBe('1234');

      // Verify the key is encrypted (not plaintext)
      expect(upsertCall.create.encryptedKey).not.toBe('cf-test-1234');
      expect(typeof upsertCall.create.encryptedKey).toBe('string');
      expect(upsertCall.create.encryptedKey.length).toBeGreaterThan(0);

      // Verify returned object does NOT expose the encrypted key
      expect(result).not.toHaveProperty('encryptedKey');
      expect(result).toMatchObject({
        provider: 'compreface',
        configured: true,
        enabled: true,
        last4: '1234',
        baseUrl: 'http://cf:8000',
      });
    });

    it('extracts last4 from the end of the apiKey', async () => {
      mockPrisma.faceProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: 'somebase64',
        last4: 'abcd',
        baseUrl: null,
        region: null,
        enabled: true,
        updatedByUserId: 'user-2',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.upsertCredential('compreface', { apiKey: 'mykey-abcd' }, 'user-2');

      const upsertCall = mockPrisma.faceProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.last4).toBe('abcd');
    });

    it('passes baseUrl through to the upsert', async () => {
      mockPrisma.faceProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: 'cipher',
        last4: '9999',
        baseUrl: 'http://compreface:8000',
        region: null,
        enabled: true,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.upsertCredential(
        'compreface',
        { apiKey: 'key-9999', baseUrl: 'http://compreface:8000' },
        'user-1',
      );

      const upsertCall = mockPrisma.faceProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.baseUrl).toBe('http://compreface:8000');
    });

    it('passes region through to the upsert', async () => {
      mockPrisma.faceProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'rekognition',
        encryptedKey: 'cipher',
        last4: '',
        baseUrl: null,
        region: 'us-west-2',
        enabled: true,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.upsertCredential(
        'rekognition',
        { region: 'us-west-2' },
        'user-1',
      );

      const upsertCall = mockPrisma.faceProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.region).toBe('us-west-2');
    });

    it('works with no apiKey (Rekognition case): rawKey empty, last4 empty', async () => {
      mockPrisma.faceProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'rekognition',
        encryptedKey: 'cipher',
        last4: '',
        baseUrl: null,
        region: 'us-east-1',
        enabled: true,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.upsertCredential(
        'rekognition',
        { region: 'us-east-1' },
        'user-1',
      );

      const upsertCall = mockPrisma.faceProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.last4).toBe('');
      expect(result.last4).toBeNull(); // empty string is coerced to null in the return
    });

    it('returns object WITHOUT encryptedKey property', async () => {
      mockPrisma.faceProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: 'should-not-appear',
        last4: 'zzzz',
        baseUrl: null,
        region: null,
        enabled: true,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.upsertCredential('compreface', { apiKey: 'key-zzzz' }, 'user-1');

      expect(result).not.toHaveProperty('encryptedKey');
      expect(result).not.toHaveProperty('apiKey');
    });
  });

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------
  describe('getSettings', () => {
    it('never exposes encryptedKey or apiKey in the response', async () => {
      mockPrisma.faceProviderCredential.findMany.mockResolvedValue([
        {
          provider: 'compreface',
          last4: 'abcd',
          baseUrl: 'http://cf:8000',
          region: null,
          enabled: true,
          updatedAt: new Date(),
        },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ face: null });
      mockRegistry.get.mockReturnValue({
        capabilities: { detect: true, embed: true, delegatedRecognize: false },
      });

      const result = await service.getSettings();

      const str = JSON.stringify(result);
      expect(str).not.toContain('encryptedKey');
      expect(str).not.toContain('apiKey');
    });

    it('returns providers with configured:true for stored credentials', async () => {
      mockPrisma.faceProviderCredential.findMany.mockResolvedValue([
        { provider: 'compreface', last4: 'efgh', baseUrl: 'http://cf:8000', region: null, enabled: true, updatedAt: new Date() },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ face: null });
      mockRegistry.get.mockReturnValue({
        capabilities: { detect: true, embed: true, delegatedRecognize: false },
      });
      mockRegistry.keys.mockReturnValue(['compreface', 'rekognition']);

      const result = await service.getSettings();

      const cfProvider = result.providers.find((p) => p.provider === 'compreface');
      expect(cfProvider).toBeDefined();
      expect(cfProvider!.configured).toBe(true);
      expect(cfProvider!.last4).toBe('efgh');
    });

    it('returns knownProviders listing unconfigured providers', async () => {
      mockPrisma.faceProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ face: null });
      mockRegistry.keys.mockReturnValue(['compreface', 'rekognition']);
      mockRegistry.get.mockReturnValue({
        capabilities: { detect: true, embed: true, delegatedRecognize: false },
      });

      const result = await service.getSettings();

      expect(result.knownProviders.length).toBe(2);
      for (const kp of result.knownProviders) {
        expect(kp.configured).toBe(false);
        expect(kp.enabled).toBe(false);
      }
    });

    it('returns default feature settings when face system settings are null', async () => {
      mockPrisma.faceProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ face: null });
      mockRegistry.keys.mockReturnValue([]);

      const result = await service.getSettings();

      expect(result.features).toEqual({ detection: { provider: null, model: null } });
    });

    it('returns stored feature settings from system settings', async () => {
      mockPrisma.faceProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({
        face: {
          features: { detection: { provider: 'compreface', model: 'arcface-r100-v1' } },
        },
      });
      mockRegistry.keys.mockReturnValue([]);

      const result = await service.getSettings();

      expect(result.features).toEqual({ detection: { provider: 'compreface', model: 'arcface-r100-v1' } });
    });

    it('includes capabilities from registry for configured providers', async () => {
      const expectedCaps = { detect: true, embed: true, delegatedRecognize: false };
      mockPrisma.faceProviderCredential.findMany.mockResolvedValue([
        { provider: 'compreface', last4: 'abcd', baseUrl: null, region: null, enabled: true, updatedAt: new Date() },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ face: null });
      mockRegistry.keys.mockReturnValue(['compreface']);
      mockRegistry.get.mockReturnValue({ capabilities: expectedCaps });

      const result = await service.getSettings();

      const cf = result.providers.find((p) => p.provider === 'compreface');
      expect(cf?.capabilities).toEqual(expectedCaps);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteCredential
  // ---------------------------------------------------------------------------
  describe('deleteCredential', () => {
    it('throws NotFoundException when credential not found', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue(null);

      await expect(service.deleteCredential('compreface', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('calls prisma.faceProviderCredential.delete when found', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: 'cipher',
        last4: 'abcd',
        baseUrl: null,
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      mockPrisma.faceProviderCredential.delete.mockResolvedValue({} as any);

      await service.deleteCredential('compreface', 'user-1');

      expect(mockPrisma.faceProviderCredential.delete).toHaveBeenCalledWith({
        where: { provider: 'compreface' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // testProvider
  // ---------------------------------------------------------------------------
  describe('testProvider', () => {
    it('calls resolveCredentials then registry.get(provider).testConnection(creds)', async () => {
      const realKey = 'cf-real-key-0000';
      const encryptedValue = encryptSecret(realKey);

      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: '0000',
        baseUrl: 'http://cf:8000',
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockTestConnection = jest.fn().mockResolvedValue({ ok: true });
      mockRegistry.get.mockReturnValue({ testConnection: mockTestConnection });

      const result = await service.testProvider({ provider: 'compreface' });

      expect(mockRegistry.get).toHaveBeenCalledWith('compreface');
      expect(mockTestConnection).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: realKey }),
      );
      expect(result).toEqual({ ok: true });
    });

    it('propagates ok:true result', async () => {
      const encryptedValue = encryptSecret('some-key');
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: 'aaaa',
        baseUrl: 'http://cf:8000',
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockTestConnection = jest.fn().mockResolvedValue({ ok: true });
      mockRegistry.get.mockReturnValue({ testConnection: mockTestConnection });

      const result = await service.testProvider({ provider: 'compreface' });
      expect(result).toEqual({ ok: true });
    });

    it('propagates ok:false result', async () => {
      const encryptedValue = encryptSecret('some-key');
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: 'aaaa',
        baseUrl: 'http://cf:8000',
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockTestConnection = jest.fn().mockResolvedValue({ ok: false, error: 'Unauthorized' });
      mockRegistry.get.mockReturnValue({ testConnection: mockTestConnection });

      const result = await service.testProvider({ provider: 'compreface' });
      expect(result).toEqual({ ok: false, error: 'Unauthorized' });
    });

    it('throws when resolveCredentials throws (unconfigured provider)', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.testProvider({ provider: 'compreface' }),
      ).rejects.toThrow(BadRequestException);

      // testConnection should never be called
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // setDetectionFeature
  // ---------------------------------------------------------------------------
  describe('setDetectionFeature', () => {
    it('calls systemSettings.patchSettings with the correct nested structure', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      await service.setDetectionFeature({ provider: 'compreface', model: 'arcface-r100-v1' }, 'user-1');

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          face: {
            features: {
              detection: { provider: 'compreface', model: 'arcface-r100-v1' },
            },
          },
        }),
        'user-1',
      );
    });

    it('returns {provider, model}', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setDetectionFeature(
        { provider: 'compreface', model: 'arcface-r100-v1' },
        'user-1',
      );

      expect(result).toEqual({ provider: 'compreface', model: 'arcface-r100-v1' });
    });

    it('supports null provider and model (clearing the feature)', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setDetectionFeature(
        { provider: null, model: null },
        'user-1',
      );

      expect(result).toEqual({ provider: null, model: null });
    });
  });

  // ---------------------------------------------------------------------------
  // resolveCredentials
  // ---------------------------------------------------------------------------
  describe('resolveCredentials', () => {
    it('decrypts the stored key correctly (round-trip)', async () => {
      const realPlaintext = 'real-face-api-key-for-test';
      const encryptedValue = encryptSecret(realPlaintext);

      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: 'test',
        baseUrl: null,
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const creds = await service.resolveCredentials('compreface');

      expect(creds.apiKey).toBe(realPlaintext);
    });

    it('returns baseUrl when configured', async () => {
      const encryptedValue = encryptSecret('any-key');

      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: 'test',
        baseUrl: 'http://compreface:8000',
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const creds = await service.resolveCredentials('compreface');

      expect(creds.baseUrl).toBe('http://compreface:8000');
    });

    it('returns region when configured', async () => {
      const encryptedValue = encryptSecret('any-key');

      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'rekognition',
        encryptedKey: encryptedValue,
        last4: '',
        baseUrl: null,
        region: 'eu-west-1',
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const creds = await service.resolveCredentials('rekognition');

      expect(creds.region).toBe('eu-west-1');
    });

    it('throws BadRequestException when provider is not configured', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue(null);

      await expect(service.resolveCredentials('compreface')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException with provider name in message when not configured', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue(null);

      await expect(service.resolveCredentials('compreface')).rejects.toThrow(/compreface/i);
    });

    it('throws BadRequestException when provider is disabled', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptSecret('some-key'),
        last4: 'test',
        baseUrl: null,
        region: null,
        enabled: false,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.resolveCredentials('compreface')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException mentioning disabled when provider is disabled', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptSecret('some-key'),
        last4: 'test',
        baseUrl: null,
        region: null,
        enabled: false,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.resolveCredentials('compreface')).rejects.toThrow(/disabled/i);
    });
  });

  // ---------------------------------------------------------------------------
  // listModels
  // ---------------------------------------------------------------------------
  describe('listModels', () => {
    it('decrypts key and calls provider.listModels when credential found and enabled', async () => {
      const realKey = 'cf-secret-key';
      const encryptedValue = encryptSecret(realKey);

      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: 'xkey',
        baseUrl: 'http://cf:8000',
        region: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockListModels = jest.fn().mockResolvedValue(['arcface-r100-v1']);
      mockRegistry.get.mockReturnValue({ listModels: mockListModels });

      const result = await service.listModels('compreface');

      expect(mockListModels).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: realKey }),
      );
      expect(result).toEqual(['arcface-r100-v1']);
    });

    it('calls provider.listModels with empty apiKey when credential exists but is disabled', async () => {
      const encryptedValue = encryptSecret('some-key');

      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'compreface',
        encryptedKey: encryptedValue,
        last4: 'abcd',
        baseUrl: 'http://cf:8000',
        region: null,
        enabled: false,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockListModels = jest.fn().mockResolvedValue(['arcface-r100-v1']);
      mockRegistry.get.mockReturnValue({ listModels: mockListModels });

      await service.listModels('compreface');

      expect(mockListModels).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: '' }),
      );
    });

    it('calls provider.listModels with empty apiKey when no credential exists', async () => {
      mockPrisma.faceProviderCredential.findUnique.mockResolvedValue(null);

      const mockListModels = jest.fn().mockResolvedValue(['arcface-r100-v1']);
      mockRegistry.get.mockReturnValue({ listModels: mockListModels });

      await service.listModels('compreface');

      expect(mockListModels).toHaveBeenCalledWith({ apiKey: '' });
    });

    it('throws for unknown provider (registry re-throws)', async () => {
      mockRegistry.get.mockImplementation(() => {
        throw new Error('Unknown face provider: unknown-face-prov');
      });

      await expect(service.listModels('unknown-face-prov')).rejects.toThrow(/Unknown face provider/i);
    });
  });
});
