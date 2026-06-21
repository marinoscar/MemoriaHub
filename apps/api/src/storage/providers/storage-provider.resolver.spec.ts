/**
 * Unit tests for StorageProviderResolver.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 * We set it in beforeAll and clean up in afterAll.
 *
 * Tests cover:
 *  - getProviderFor(): credential-based build, local provider, env fallback,
 *    cache keyed by `${providerId}:${bucket}`, dedup (second call skips findUnique)
 *  - getActiveProvider(): reads from system settings, falls back to env/default
 *  - invalidate(): clears only matching keys by prefix
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageProviderResolver } from './storage-provider.resolver';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { LocalDiskStorageProvider } from './local/local-disk.provider';
import { S3StorageProvider } from './s3/s3-storage.provider';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { encryptSecret } from '../../common/crypto/secret-cipher';

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
    encryptedKey: encryptSecret('test-secret-key'),
    accessKeyId: 'AKIATEST',
    region: 'us-east-1',
    bucket: 'my-bucket',
    endpoint: null,
    last4: '3key',
    enabled: true,
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageProviderResolver', () => {
  let resolver: StorageProviderResolver;
  let mockPrisma: MockPrismaService;
  let mockConfig: { get: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock; patchSettings: jest.Mock };
  let mockLocalDiskProvider: jest.Mocked<LocalDiskStorageProvider>;
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
    mockConfig = {
      get: jest.fn().mockImplementation((key: string, defaultVal?: unknown) => {
        const vals: Record<string, unknown> = {
          'storage.s3.region': 'us-east-1',
          'storage.s3.endpoint': undefined,
          'storage.s3.accessKeyId': 'ENV_KEY_ID',
          'storage.s3.secretAccessKey': 'env-secret',
          'storage.s3.maxAttempts': 5,
          'storage.s3.retryMode': 'adaptive',
          STORAGE_PROVIDER: 's3',
        };
        return vals[key] ?? defaultVal;
      }),
    };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue({}),
      patchSettings: jest.fn(),
    };
    mockLocalDiskProvider = {
      upload: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
      getMetadata: jest.fn(),
      setMetadata: jest.fn(),
      getBucket: jest.fn().mockReturnValue('local'),
      getSignedDownloadUrl: jest.fn(),
      getSignedUploadUrl: jest.fn(),
      initMultipartUpload: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
    } as unknown as jest.Mocked<LocalDiskStorageProvider>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageProviderResolver,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: LocalDiskStorageProvider, useValue: mockLocalDiskProvider },
      ],
    }).compile();

    resolver = module.get<StorageProviderResolver>(StorageProviderResolver);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getProviderFor — credential-based S3 build
  // =========================================================================

  describe('getProviderFor — credential-based build', () => {
    it('returns an S3StorageProvider built from the decrypted credential row', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      const provider = await resolver.getProviderFor('s3');

      expect(provider).toBeInstanceOf(S3StorageProvider);
    });

    it('calls findUnique once and caches the result — second call skips DB', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      await resolver.getProviderFor('s3');
      await resolver.getProviderFor('s3');

      // Should hit DB exactly once; second call served from cache
      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledTimes(1);
    });

    it('caches separately by bucket — distinct bucket causes a second DB call', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      await resolver.getProviderFor('s3');            // key: "s3:"
      await resolver.getProviderFor('s3', 'other-bucket'); // key: "s3:other-bucket"

      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledTimes(2);
    });

    it('uses the bucket override instead of the credential default bucket', async () => {
      const cred = makeCredRow({ bucket: 'default-bucket' });
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(cred as any);

      // We can only assert the provider was built without throwing; bucket
      // is an internal constructor detail of S3StorageProvider.
      const provider = await resolver.getProviderFor('s3', 'override-bucket');

      expect(provider).toBeInstanceOf(S3StorageProvider);
    });
  });

  // =========================================================================
  // getProviderFor — local provider
  // =========================================================================

  describe('getProviderFor — local provider', () => {
    it('returns the injected LocalDiskStorageProvider without touching the DB', async () => {
      const provider = await resolver.getProviderFor('local');

      expect(provider).toBe(mockLocalDiskProvider);
      expect(mockPrisma.storageProviderCredential.findUnique).not.toHaveBeenCalled();
    });

    it('caches the local provider — second call still skips DB', async () => {
      await resolver.getProviderFor('local');
      await resolver.getProviderFor('local');

      expect(mockPrisma.storageProviderCredential.findUnique).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getProviderFor — env-var fallback (no credential row)
  // =========================================================================

  describe('getProviderFor — env-var fallback', () => {
    it('returns an S3StorageProvider even when no credential row exists', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      const provider = await resolver.getProviderFor('s3');

      expect(provider).toBeInstanceOf(S3StorageProvider);
    });

    it('does not throw when credential row is disabled', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(
        makeCredRow({ enabled: false }) as any,
      );

      // Disabled row → falls through to env-var path; should not throw
      await expect(resolver.getProviderFor('s3')).resolves.toBeInstanceOf(S3StorageProvider);
    });

    it('uses the bucket override in env-var fallback path', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);

      // Should build without throwing even with a bucket override
      const provider = await resolver.getProviderFor('s3', 'legacy-bucket');

      expect(provider).toBeInstanceOf(S3StorageProvider);
    });
  });

  // =========================================================================
  // getActiveProvider
  // =========================================================================

  describe('getActiveProvider', () => {
    it('uses the activeProvider from system settings', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);
      mockSystemSettings.getSettings.mockResolvedValue({
        storage: { activeProvider: 's3' },
      });

      const { id } = await resolver.getActiveProvider();

      expect(id).toBe('s3');
    });

    it('falls back to STORAGE_PROVIDER config when settings has no storage block', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(null as any);
      mockSystemSettings.getSettings.mockResolvedValue({});
      mockConfig.get.mockImplementation((key: string, def?: unknown) => {
        if (key === 'STORAGE_PROVIDER') return 'r2';
        return def;
      });

      const { id } = await resolver.getActiveProvider();

      expect(id).toBe('r2');
    });

    it('returns a provider object along with the id', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);
      mockSystemSettings.getSettings.mockResolvedValue({
        storage: { activeProvider: 's3' },
      });

      const { id, provider } = await resolver.getActiveProvider();

      expect(id).toBe('s3');
      expect(provider).toBeInstanceOf(S3StorageProvider);
    });
  });

  // =========================================================================
  // invalidate
  // =========================================================================

  describe('invalidate', () => {
    it('clears the cache for the given provider — next call hits DB again', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      await resolver.getProviderFor('s3'); // fills cache
      resolver.invalidate('s3');
      await resolver.getProviderFor('s3'); // should go to DB again

      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledTimes(2);
    });

    it('clears all entries that start with the provider prefix', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      // Fill two cache entries for 's3': "s3:" and "s3:bucket-b"
      await resolver.getProviderFor('s3');
      await resolver.getProviderFor('s3', 'bucket-b');

      resolver.invalidate('s3'); // should evict both

      await resolver.getProviderFor('s3');
      await resolver.getProviderFor('s3', 'bucket-b');

      // Total: 2 (fill) + 2 (re-fetch after invalidation) = 4
      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledTimes(4);
    });

    it('does not evict a different provider entry', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      await resolver.getProviderFor('s3');   // fills "s3:" key
      await resolver.getProviderFor('r2');   // fills "r2:" key (uses same mock)

      resolver.invalidate('s3'); // should only evict "s3:" key

      // Call r2 again — should come from cache (no extra DB call)
      await resolver.getProviderFor('r2');

      // Only 's3' re-hit after invalidation — total DB calls: s3(1) + r2(1) + s3-refetch(0, not called yet) = 2
      // But note: we do NOT call getProviderFor('s3') after invalidate here, so total = 2
      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledTimes(2);
    });

    it('clears the entire cache when called without a providerId', async () => {
      mockPrisma.storageProviderCredential.findUnique.mockResolvedValue(makeCredRow() as any);

      await resolver.getProviderFor('s3');
      await resolver.getProviderFor('r2');

      resolver.invalidate(); // no arg → full clear

      await resolver.getProviderFor('s3');
      await resolver.getProviderFor('r2');

      // 2 initial + 2 after full invalidation = 4
      expect(mockPrisma.storageProviderCredential.findUnique).toHaveBeenCalledTimes(4);
    });
  });

  // =========================================================================
  // buildEphemeral
  // =========================================================================

  describe('buildEphemeral', () => {
    it('returns a new S3StorageProvider without caching', () => {
      const cfg = {
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret',
        bucket: 'test-bucket',
        region: 'us-east-1',
      };

      const provider = resolver.buildEphemeral(cfg);

      expect(provider).toBeInstanceOf(S3StorageProvider);
    });

    it('does not touch the DB when building ephemeral', () => {
      resolver.buildEphemeral({
        accessKeyId: 'A',
        secretAccessKey: 'B',
        bucket: 'b',
      });

      expect(mockPrisma.storageProviderCredential.findUnique).not.toHaveBeenCalled();
    });
  });
});
