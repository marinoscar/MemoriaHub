/**
 * Unit tests for StorageSettingsService.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 * We set it in beforeAll and clean up in afterAll.
 *
 * Tests cover:
 *  - getSettings(): never exposes encryptedKey; returns knownProviders + activeProvider
 *  - upsertCredential(): encrypts secret, stores last4, preserves existing key on partial
 *    update, rejects r2 without endpoint, rejects requiresCredentials without secret
 *  - deleteCredential(): BadRequest when active; 404 when missing; success invalidates cache
 *  - testConnection(): success round-trip; failure returns ok:false; never throws;
 *    partial override resolves stored secret; half-filled DTO with no row → clean error;
 *    full DTO override works without stored row; no-overrides regressions
 *  - setActiveProvider(): patches system settings; unknown provider → BadRequest;
 *    missing credential (non-s3) → BadRequest
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageSettingsService } from './storage-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { encryptSecret } from '../common/crypto/secret-cipher';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    provider: 's3',
    encryptedKey: encryptSecret('real-secret-key-1234'),
    accessKeyId: 'AKIATEST1234',
    region: 'us-east-1',
    bucket: 'my-bucket',
    endpoint: null,
    last4: '1234',
    enabled: true,
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStorageProvider(overrides: Partial<{
  upload: jest.Mock;
  getMetadata: jest.Mock;
  exists: jest.Mock;
  delete: jest.Mock;
  getBucket: jest.Mock;
}> = {}) {
  return {
    upload: jest.fn().mockResolvedValue({}),
    getMetadata: jest.fn().mockResolvedValue({ 'Content-Type': 'text/plain' }),
    exists: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(undefined),
    getBucket: jest.fn().mockReturnValue('my-bucket'),
    download: jest.fn(),
    getSignedDownloadUrl: jest.fn(),
    getSignedUploadUrl: jest.fn(),
    initMultipartUpload: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    setMetadata: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageSettingsService', () => {
  let service: StorageSettingsService;
  let mockPrisma: MockPrismaService;
  let mockResolver: {
    getProviderFor: jest.Mock;
    getActiveProvider: jest.Mock;
    buildEphemeral: jest.Mock;
    invalidate: jest.Mock;
  };
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
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
    mockResolver = {
      getProviderFor: jest.fn(),
      getActiveProvider: jest.fn(),
      buildEphemeral: jest.fn(),
      invalidate: jest.fn(),
    };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({}),
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<StorageSettingsService>(StorageSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getSettings
  // =========================================================================

  describe('getSettings', () => {
    it('never exposes encryptedKey in the returned providers', async () => {
      mockPrisma.storageProviderCredential.findMany.mockResolvedValue([
        {
          provider: 's3',
          accessKeyId: 'AKI',
          region: 'us-east-1',
          bucket: 'my-bucket',
          endpoint: null,
          last4: '1234',
          enabled: true,
          updatedAt: new Date(),
          // encryptedKey intentionally present in DB but SELECT omits it
        },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = await service.getSettings();

      const str = JSON.stringify(result);
      expect(str).not.toContain('encryptedKey');
      expect(str).not.toContain('encrypted_key');
    });

    it('marks providers with a DB row as configured:true', async () => {
      mockPrisma.storageProviderCredential.findMany.mockResolvedValue([
        {
          provider: 's3',
          accessKeyId: 'AKI',
          region: 'us-east-1',
          bucket: 'my-bucket',
          endpoint: null,
          last4: '1234',
          enabled: true,
          updatedAt: new Date(),
        },
      ] as any);
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = await service.getSettings();

      const s3 = result.providers.find(p => p.provider === 's3');
      expect(s3).toBeDefined();
      expect(s3!.configured).toBe(true);
    });

    it('lists unconfigured known providers in knownProviders with configured:false', async () => {
      mockPrisma.storageProviderCredential.findMany.mockResolvedValue([] as any);
      mockSystemSettings.getSettings.mockResolvedValue({});

      const result = await service.getSettings();

      // s3, r2, local are the known providers
      expect(result.knownProviders.length).toBeGreaterThan(0);
      for (const kp of result.knownProviders) {
        expect(kp.configured).toBe(false);
        expect(kp.enabled).toBe(false);
      }
    });

    it('reads activeProvider from system settings storage block', async () => {
      mockPrisma.storageProviderCredential.findMany.mockResolvedValue([] as any);
      mockSystemSettings.getSettings.mockResolvedValue({
        storage: { activeProvider: 'r2' },
      });

      const result = await service.getSettings();

      expect(result.activeProvider).toBe('r2');
    });

    it('falls back to env/default for activeProvider when settings has no storage block', async () => {
      mockPrisma.storageProviderCredential.findMany.mockResolvedValue([] as any);
      mockSystemSettings.getSettings.mockResolvedValue({});

      const originalEnv = process.env['STORAGE_PROVIDER'];
      delete process.env['STORAGE_PROVIDER'];

      const result = await service.getSettings();

      expect(result.activeProvider).toBe('s3'); // hardcoded default

      if (originalEnv !== undefined) process.env['STORAGE_PROVIDER'] = originalEnv;
    });
  });

  // =========================================================================
  // upsertCredential
  // =========================================================================

  describe('upsertCredential', () => {
    it('encrypts the secretAccessKey and stores last4 correctly', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);
      mockPrisma.storageProviderCredential.upsert.mockResolvedValue({
        provider: 's3',
        encryptedKey: 'cipher',
        accessKeyId: 'AKI1234',
        region: 'us-east-1',
        bucket: 'my-bucket',
        endpoint: null,
        last4: '5678',
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.upsertCredential(
        's3',
        {
          accessKeyId: 'AKI1234',
          secretAccessKey: 'my-secret-5678',
          bucket: 'my-bucket',
          region: 'us-east-1',
        },
        'user-1',
      );

      const upsertCall = mockPrisma.storageProviderCredential.upsert.mock.calls[0][0];
      // last4 should be the last 4 chars of 'my-secret-5678'
      expect(upsertCall.create.last4).toBe('5678');
      // encryptedKey must NOT be the plaintext
      expect(upsertCall.create.encryptedKey).not.toBe('my-secret-5678');
      expect(typeof upsertCall.create.encryptedKey).toBe('string');
      expect(upsertCall.create.encryptedKey.length).toBeGreaterThan(0);
    });

    it('does not expose encryptedKey in the return value', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);
      mockPrisma.storageProviderCredential.upsert.mockResolvedValue({
        provider: 's3',
        encryptedKey: 'cipher-value',
        accessKeyId: 'AKI',
        region: 'us-east-1',
        bucket: 'b',
        endpoint: null,
        last4: 'abcd',
        enabled: true,
        updatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.upsertCredential(
        's3',
        { accessKeyId: 'AKI', secretAccessKey: 'my-key-abcd', bucket: 'b', region: 'us-east-1' },
        'user-1',
      );

      expect(result).not.toHaveProperty('encryptedKey');
      expect(JSON.stringify(result)).not.toContain('encryptedKey');
      expect(JSON.stringify(result)).not.toContain('cipher-value');
    });

    it('calls resolver.invalidate(provider) after upsert', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);
      mockPrisma.storageProviderCredential.upsert.mockResolvedValue(makeCredRow() as any);

      await service.upsertCredential(
        's3',
        { accessKeyId: 'AKI', secretAccessKey: 'key-1234', bucket: 'b', region: 'us-east-1' },
        'user-1',
      );

      expect(mockResolver.invalidate).toHaveBeenCalledWith('s3');
    });

    it('on UPDATE without secret — preserves existing encryptedKey and last4', async () => {
      const existingCred = makeCredRow({ encryptedKey: 'existing-cipher', last4: 'PREV' });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(existingCred as any);
      mockPrisma.storageProviderCredential.upsert.mockResolvedValue({
        ...existingCred,
        region: 'eu-west-1',
      } as any);

      // Update without providing secretAccessKey
      await service.upsertCredential(
        's3',
        { region: 'eu-west-1' }, // no secret
        'user-1',
      );

      const upsertCall = mockPrisma.storageProviderCredential.upsert.mock.calls[0][0];
      // The update payload must reuse the existing encrypted key, not overwrite with empty
      expect(upsertCall.update.encryptedKey).toBe('existing-cipher');
      expect(upsertCall.update.last4).toBe('PREV');
    });

    it('throws BadRequestException for r2 CREATE without endpoint', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      await expect(
        service.upsertCredential(
          'r2',
          {
            accessKeyId: 'AKI',
            secretAccessKey: 'secret-1234',
            bucket: 'my-bucket',
            region: 'auto',
            // endpoint intentionally omitted
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for s3 CREATE without secretAccessKey', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      await expect(
        service.upsertCredential(
          's3',
          { accessKeyId: 'AKI', bucket: 'b', region: 'us-east-1' },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for unknown provider', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      await expect(
        service.upsertCredential(
          'unknown-provider',
          { secretAccessKey: 'key' },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // deleteCredential
  // =========================================================================

  describe('deleteCredential', () => {
    it('throws BadRequestException when provider === activeProvider', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        storage: { activeProvider: 's3' },
      });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      await expect(service.deleteCredential('s3')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when no credential row exists', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        storage: { activeProvider: 'r2' }, // different from 's3' so not blocked
      });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      await expect(service.deleteCredential('s3')).rejects.toThrow(NotFoundException);
    });

    it('deletes the row and calls resolver.invalidate on success', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        storage: { activeProvider: 'r2' }, // active is r2, so s3 can be deleted
      });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);
      mockPrisma.storageProviderCredential.delete.mockResolvedValue(makeCredRow() as any);

      await service.deleteCredential('s3');

      expect(mockPrisma.storageProviderCredential.delete).toHaveBeenCalledWith({
        where: { provider: 's3' },
      });
      expect(mockResolver.invalidate).toHaveBeenCalledWith('s3');
    });
  });

  // =========================================================================
  // testConnection
  // =========================================================================

  describe('testConnection', () => {
    it('returns ok:true after successful upload → getMetadata → delete round-trip (override path)', async () => {
      const fakeProvider = makeStorageProvider();
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      const result = await service.testConnection({
        provider: 's3',
        accessKeyId: 'AKI',
        secretAccessKey: 'secret',
        bucket: 'test-bucket',
      });

      expect(result.ok).toBe(true);
      expect(result.provider).toBe('s3');
      expect(fakeProvider.upload).toHaveBeenCalledTimes(1);
      expect(fakeProvider.getMetadata).toHaveBeenCalledTimes(1);
      expect(fakeProvider.delete).toHaveBeenCalledTimes(1);
    });

    it('returns ok:true using DB credential when no overrides supplied', async () => {
      const cred = makeCredRow();
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(cred as any);
      const fakeProvider = makeStorageProvider();
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      const result = await service.testConnection({ provider: 's3' });

      expect(result.ok).toBe(true);
      expect(fakeProvider.upload).toHaveBeenCalledTimes(1);
    });

    it('returns ok:false with error message when upload throws (never rethrows)', async () => {
      const fakeProvider = makeStorageProvider({
        upload: jest.fn().mockRejectedValue(new Error('AccessDenied')),
      });
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      const result = await service.testConnection({
        provider: 's3',
        accessKeyId: 'AKI',
        secretAccessKey: 'secret',
        bucket: 'test-bucket',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/AccessDenied/);
    });

    it('does not expose secretAccessKey or encryptedKey in the success response', async () => {
      const fakeProvider = makeStorageProvider();
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      const result = await service.testConnection({
        provider: 's3',
        accessKeyId: 'AKI',
        secretAccessKey: 'my-secret-key',
        bucket: 'b',
        region: 'us-east-1',
      });

      const str = JSON.stringify(result);
      expect(str).not.toContain('my-secret-key');
      expect(str).not.toContain('encryptedKey');
      expect(str).not.toContain('secretAccessKey');
    });

    it('returns ok:false when provider is not configured (no DB row, no overrides)', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      const result = await service.testConnection({ provider: 's3' });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns ok:false when DB row is disabled', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(
        makeCredRow({ enabled: false }) as any,
      );

      const result = await service.testConnection({ provider: 's3' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/disabled/i);
    });

    it('returns ok:false for unknown provider key', async () => {
      const result = await service.testConnection({ provider: 'nonexistent' });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('round-trips the local provider via resolver.getProviderFor', async () => {
      const fakeLocal = makeStorageProvider();
      mockResolver.getProviderFor.mockResolvedValue(fakeLocal);

      const result = await service.testConnection({ provider: 'local' });

      expect(result.ok).toBe(true);
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('local');
    });

    // -----------------------------------------------------------------------
    // New cases: partial-override / credential-merge behaviour (R2 fix)
    // -----------------------------------------------------------------------

    it('partial override resolves stored secret: DTO has accessKeyId but no secret and a stored row exists', async () => {
      // Arrange: stored credential with a known plaintext secret ("real-secret-key-1234")
      // makeCredRow() encrypts that plaintext via encryptSecret() in its definition.
      const cred = makeCredRow({
        accessKeyId: 'STORED-AKI',
        bucket: 'stored-bucket',
        region: 'us-west-2',
      });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(cred as any);

      const fakeProvider = makeStorageProvider();
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      // Act: supply accessKeyId override but omit secretAccessKey
      const result = await service.testConnection({
        provider: 's3',
        accessKeyId: 'OVERRIDE-AKI',
        bucket: 'override-bucket',
        // secretAccessKey intentionally absent
      });

      // Assert: connection succeeds and the round-trip was exercised
      expect(result.ok).toBe(true);

      // buildEphemeral must have been called (not skipped), meaning the stored
      // secret was decrypted and used to fill the gap.
      expect(mockResolver.buildEphemeral).toHaveBeenCalledTimes(1);

      // The config passed to buildEphemeral must use the OVERRIDE accessKeyId
      // and the DECRYPTED stored secret, not an empty/undefined value.
      const builtConfig = mockResolver.buildEphemeral.mock.calls[0][0];
      expect(builtConfig.accessKeyId).toBe('OVERRIDE-AKI');
      expect(builtConfig.secretAccessKey).toBeTruthy();
      // 'real-secret-key-1234' is the plaintext encrypted by makeCredRow()
      expect(builtConfig.secretAccessKey).toBe('real-secret-key-1234');

      // S3 round-trip must have been performed
      expect(fakeProvider.upload).toHaveBeenCalledTimes(1);
      expect(fakeProvider.getMetadata).toHaveBeenCalledTimes(1);
      expect(fakeProvider.delete).toHaveBeenCalledTimes(1);
    });

    it('half-filled override with NO stored row returns clean error and never constructs S3 client', async () => {
      // Arrange: no credential row exists for the provider
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      // Act: DTO has accessKeyId but no secret and no stored row to fall back to
      const result = await service.testConnection({
        provider: 's3',
        accessKeyId: 'SOME-AKI',
        bucket: 'some-bucket',
        // secretAccessKey absent
      });

      // Assert: clean error mentioning the secret is required
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toMatch(/secret/);

      // buildEphemeral must NOT have been called — no S3 client should be built
      expect(mockResolver.buildEphemeral).not.toHaveBeenCalled();
    });

    it('full override (both key and secret in DTO) succeeds using DTO values only (regression)', async () => {
      // Even if no stored row exists, a full DTO should work independently
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      const fakeProvider = makeStorageProvider();
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      const result = await service.testConnection({
        provider: 's3',
        accessKeyId: 'DTO-AKI',
        secretAccessKey: 'DTO-SECRET',
        bucket: 'dto-bucket',
        region: 'eu-central-1',
      });

      expect(result.ok).toBe(true);

      const builtConfig = mockResolver.buildEphemeral.mock.calls[0][0];
      expect(builtConfig.accessKeyId).toBe('DTO-AKI');
      expect(builtConfig.secretAccessKey).toBe('DTO-SECRET');

      expect(fakeProvider.upload).toHaveBeenCalledTimes(1);
    });

    it('no-overrides path with stored enabled row loads from DB as before (regression)', async () => {
      const cred = makeCredRow({ enabled: true });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(cred as any);

      const fakeProvider = makeStorageProvider();
      mockResolver.buildEphemeral.mockReturnValue(fakeProvider);

      // Empty DTO — only provider key supplied
      const result = await service.testConnection({ provider: 's3' });

      expect(result.ok).toBe(true);
      expect(mockResolver.buildEphemeral).toHaveBeenCalledTimes(1);
      expect(fakeProvider.upload).toHaveBeenCalledTimes(1);
    });

    it('no-overrides path with stored DISABLED row still returns disabled error (regression)', async () => {
      const cred = makeCredRow({ enabled: false });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(cred as any);

      const result = await service.testConnection({ provider: 's3' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/disabled/i);
      // Should not even attempt to build the provider
      expect(mockResolver.buildEphemeral).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // setActiveProvider
  // =========================================================================

  describe('setActiveProvider', () => {
    it('patches system settings with the new activeProvider', async () => {
      // 's3' is always allowed (legacy env-var path)
      await service.setActiveProvider({ provider: 's3' }, 'user-1');

      expect(mockSystemSettings.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ storage: { activeProvider: 's3' } }),
        'user-1',
      );
    });

    it('calls resolver.invalidate() (no arg) to flush the full cache', async () => {
      await service.setActiveProvider({ provider: 's3' }, 'user-1');

      expect(mockResolver.invalidate).toHaveBeenCalledWith();
    });

    it('returns { activeProvider }', async () => {
      const result = await service.setActiveProvider({ provider: 's3' }, 'user-1');

      expect(result).toEqual({ activeProvider: 's3' });
    });

    it('throws BadRequestException for unknown provider', async () => {
      await expect(
        service.setActiveProvider({ provider: 'unknown' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for r2 with no credential row', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      await expect(
        service.setActiveProvider({ provider: 'r2' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows setting r2 when a credential row exists', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(
        makeCredRow({ provider: 'r2' }) as any,
      );

      await expect(
        service.setActiveProvider({ provider: 'r2' }, 'user-1'),
      ).resolves.toEqual({ activeProvider: 'r2' });
    });

    it('allows setting local provider (no credentials required)', async () => {
      await expect(
        service.setActiveProvider({ provider: 'local' }, 'user-1'),
      ).resolves.toEqual({ activeProvider: 'local' });

      // No DB lookup needed for keyless providers
      expect(mockPrisma.storageProviderCredential.findUnique).not.toHaveBeenCalled();
    });
  });
});
