/**
 * Unit tests for AiSettingsService.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 * We set it in beforeAll and clean up in afterAll.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { encryptSecret } from '../common/crypto/secret-cipher';

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('AiSettingsService', () => {
  let service: AiSettingsService;
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
      keys: jest.fn().mockReturnValue(['openai', 'anthropic']),
    };
    mockSystemSettings = {
      getSettings: jest.fn(),
      patchSettings: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AiProviderRegistry, useValue: mockRegistry },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<AiSettingsService>(AiSettingsService);
  });

  // ---------------------------------------------------------------------------
  // upsertCredential
  // ---------------------------------------------------------------------------
  describe('upsertCredential', () => {
    it('encrypts the apiKey and stores last4 correctly', async () => {
      const upsertedRecord = {
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: 'somebase64ciphertext',
        last4: '1234',
        baseUrl: null,
        enabled: true,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.aiProviderCredential.upsert.mockResolvedValue(upsertedRecord as any);

      const result = await service.upsertCredential(
        'openai',
        { apiKey: 'sk-test-1234' },
        'user-1',
      );

      // Verify upsert was called with correct last4
      const upsertCall = mockPrisma.aiProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.last4).toBe('1234');

      // Verify the key is encrypted (not plaintext)
      expect(upsertCall.create.encryptedKey).not.toBe('sk-test-1234');
      expect(typeof upsertCall.create.encryptedKey).toBe('string');
      expect(upsertCall.create.encryptedKey.length).toBeGreaterThan(0);

      // Verify returned object does NOT expose the encrypted key
      expect(result).not.toHaveProperty('encryptedKey');
      expect(result).toMatchObject({
        provider: 'openai',
        configured: true,
        enabled: true,
        last4: '1234',
        baseUrl: null,
      });
    });

    it('extracts last4 from the end of the apiKey', async () => {
      mockPrisma.aiProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'anthropic',
        encryptedKey: 'somebase64',
        last4: 'abcd',
        baseUrl: null,
        enabled: true,
        updatedByUserId: 'user-2',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.upsertCredential('anthropic', { apiKey: 'sk-mykey-abcd' }, 'user-2');

      const upsertCall = mockPrisma.aiProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.last4).toBe('abcd');
    });

    it('passes baseUrl and enabled through to the upsert', async () => {
      mockPrisma.aiProviderCredential.upsert.mockResolvedValue({
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: 'cipher',
        last4: '9999',
        baseUrl: 'https://custom-openai.example.com',
        enabled: false,
        updatedByUserId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.upsertCredential(
        'openai',
        { apiKey: 'sk-abcd9999', baseUrl: 'https://custom-openai.example.com', enabled: false },
        'user-1',
      );

      const upsertCall = mockPrisma.aiProviderCredential.upsert.mock.calls[0][0];
      expect(upsertCall.create.baseUrl).toBe('https://custom-openai.example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------
  describe('getSettings', () => {
    it('never exposes encryptedKey or apiKey in the response', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([
        {
          provider: 'openai',
          last4: 'abcd',
          baseUrl: null,
          enabled: true,
          updatedAt: new Date(),
          // encryptedKey intentionally present in the DB record but select excludes it
        },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      // Walk the result deeply — no property should be named encryptedKey or apiKey
      const str = JSON.stringify(result);
      expect(str).not.toContain('encryptedKey');
      expect(str).not.toContain('apiKey');
    });

    it('returns providers with configured:true for stored credentials', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([
        { provider: 'openai', last4: 'efgh', baseUrl: null, enabled: true, updatedAt: new Date() },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      const openAiProvider = result.providers.find((p) => p.provider === 'openai');
      expect(openAiProvider).toBeDefined();
      expect(openAiProvider!.configured).toBe(true);
      expect(openAiProvider!.last4).toBe('efgh');
    });

    it('returns knownProviders listing unconfigured providers', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });
      mockRegistry.keys.mockReturnValue(['openai', 'anthropic']);

      const result = await service.getSettings();

      expect(result.knownProviders.length).toBe(2);
      for (const kp of result.knownProviders) {
        expect(kp.configured).toBe(false);
        expect(kp.enabled).toBe(false);
      }
    });

    it('returns default feature settings when ai system settings are null', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      expect(result.features).toEqual({
        search: { provider: null, model: null },
        tagging: { provider: null, model: null },
        embedding: { provider: null, model: null },
      });
    });

    it('returns stored feature settings from system settings', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: { search: { provider: 'openai', model: 'gpt-4o' } },
        },
      });

      const result = await service.getSettings();

      expect(result.features).toEqual({ search: { provider: 'openai', model: 'gpt-4o' } });
    });
  });

  // ---------------------------------------------------------------------------
  // resolveCredentials
  // ---------------------------------------------------------------------------
  describe('resolveCredentials', () => {
    it('decrypts the stored key correctly', async () => {
      const realPlaintext = 'real-api-key-for-test';
      // Encrypt with the real function (key is set in beforeAll)
      const encryptedValue = encryptSecret(realPlaintext);

      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: encryptedValue,
        last4: 'test',
        baseUrl: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const creds = await service.resolveCredentials('openai');

      expect(creds.apiKey).toBe(realPlaintext);
    });

    it('returns baseUrl when configured', async () => {
      const encryptedValue = encryptSecret('any-key');

      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: encryptedValue,
        last4: 'test',
        baseUrl: 'https://custom.example.com',
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const creds = await service.resolveCredentials('openai');

      expect(creds.baseUrl).toBe('https://custom.example.com');
    });

    it('throws BadRequestException when provider is not configured', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue(null);

      await expect(service.resolveCredentials('openai')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException with provider name in message when not configured', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue(null);

      await expect(service.resolveCredentials('openai')).rejects.toThrow(/openai/i);
    });

    it('throws BadRequestException when provider is disabled', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: encryptSecret('some-key'),
        last4: 'test',
        baseUrl: null,
        enabled: false,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.resolveCredentials('openai')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException mentioning disabled when provider is disabled', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: encryptSecret('some-key'),
        last4: 'test',
        baseUrl: null,
        enabled: false,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.resolveCredentials('openai')).rejects.toThrow(/disabled/i);
    });
  });

  // ---------------------------------------------------------------------------
  // setEmbeddingFeature
  // ---------------------------------------------------------------------------
  describe('setEmbeddingFeature', () => {
    it('calls patchSettings with the embedding provider and model', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setEmbeddingFeature(
        { provider: 'openai', model: 'text-embedding-3-small' },
        'user-1',
      );

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: {
            features: {
              embedding: { provider: 'openai', model: 'text-embedding-3-small' },
            },
          },
        }),
        'user-1',
      );
      expect(result).toEqual({ provider: 'openai', model: 'text-embedding-3-small' });
    });

    it('returns the dto values as-is', async () => {
      mockSystemSettings.patchSettings.mockResolvedValue(undefined);

      const result = await service.setEmbeddingFeature(
        { provider: 'anthropic', model: 'embed-v1' },
        'user-2',
      );

      expect(result).toEqual({ provider: 'anthropic', model: 'embed-v1' });
    });
  });

  // ---------------------------------------------------------------------------
  // resolveEmbeddingConfig
  // ---------------------------------------------------------------------------
  describe('resolveEmbeddingConfig', () => {
    it('returns {provider, model} when both are set in system settings', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: {
            embedding: { provider: 'openai', model: 'text-embedding-3-large' },
          },
        },
      });

      const result = await service.resolveEmbeddingConfig();

      expect(result).toEqual({ provider: 'openai', model: 'text-embedding-3-large' });
    });

    it('returns null when provider is null', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: {
            embedding: { provider: null, model: 'text-embedding-3-small' },
          },
        },
      });

      const result = await service.resolveEmbeddingConfig();

      expect(result).toBeNull();
    });

    it('returns null when model is null', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: {
            embedding: { provider: 'openai', model: null },
          },
        },
      });

      const result = await service.resolveEmbeddingConfig();

      expect(result).toBeNull();
    });

    it('returns null when embedding feature is absent from system settings', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.resolveEmbeddingConfig();

      expect(result).toBeNull();
    });

    it('returns null when ai block is entirely absent', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = await service.resolveEmbeddingConfig();

      expect(result).toBeNull();
    });

    it('returns null when features.embedding exists but both fields are undefined', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: { features: { embedding: {} } },
      });

      const result = await service.resolveEmbeddingConfig();

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getSettings — embedding feature in response
  // ---------------------------------------------------------------------------
  describe('getSettings — embedding feature', () => {
    it('returns default embedding feature when ai system settings are null', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({ ai: null });

      const result = await service.getSettings();

      expect(result.features).toMatchObject({
        embedding: { provider: null, model: null },
      });
    });

    it('returns stored embedding feature from system settings', async () => {
      mockPrisma.aiProviderCredential.findMany.mockResolvedValue([]);
      mockSystemSettings.getSettings.mockResolvedValue({
        ai: {
          features: {
            embedding: { provider: 'openai', model: 'text-embedding-3-small' },
          },
        },
      });

      const result = await service.getSettings();

      expect(result.features).toMatchObject({
        embedding: { provider: 'openai', model: 'text-embedding-3-small' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // testProvider
  // ---------------------------------------------------------------------------
  describe('testProvider', () => {
    it('delegates to the registry provider.testModel with decrypted credentials', async () => {
      const realKey = 'sk-real-key-0000';
      const encryptedValue = encryptSecret(realKey);

      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'openai',
        encryptedKey: encryptedValue,
        last4: '0000',
        baseUrl: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockTestModel = jest.fn().mockResolvedValue({ ok: true });
      mockRegistry.get.mockReturnValue({ testModel: mockTestModel });

      const result = await service.testProvider({ provider: 'openai', model: 'gpt-4o' });

      expect(mockRegistry.get).toHaveBeenCalledWith('openai');
      expect(mockTestModel).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: realKey }),
        'gpt-4o',
      );
      expect(result).toEqual({ ok: true });
    });

    it('propagates failure result from testModel', async () => {
      const encryptedValue = encryptSecret('some-key');

      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue({
        id: 'cred-1',
        provider: 'anthropic',
        encryptedKey: encryptedValue,
        last4: 'aaaa',
        baseUrl: null,
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const mockTestModel = jest.fn().mockResolvedValue({ ok: false, error: 'Unauthorized' });
      mockRegistry.get.mockReturnValue({ testModel: mockTestModel });

      const result = await service.testProvider({ provider: 'anthropic', model: 'claude-3-5-haiku-20241022' });

      expect(result).toEqual({ ok: false, error: 'Unauthorized' });
    });

    it('throws when resolveCredentials throws (unconfigured provider)', async () => {
      mockPrisma.aiProviderCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.testProvider({ provider: 'openai', model: 'gpt-4o' }),
      ).rejects.toThrow(BadRequestException);

      // testModel should never be called
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });
  });
});
