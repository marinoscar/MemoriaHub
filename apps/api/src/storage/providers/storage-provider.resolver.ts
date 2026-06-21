import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { decryptSecret } from '../../common/crypto/secret-cipher';
import { StorageProvider } from './storage-provider.interface';
import { S3StorageProvider, S3ProviderConfig } from './s3/s3-storage.provider';
import { LocalDiskStorageProvider } from './local/local-disk.provider';

/**
 * StorageProviderResolver
 *
 * Resolves the correct StorageProvider instance for a given provider ID.
 * Two usage modes:
 *
 * 1. getActiveProvider() — used by new uploads to discover which provider is
 *    currently active (from system settings), then builds/caches a client for it.
 *
 * 2. getProviderFor(providerId, bucket?) — used by reads, downloads, deletes, and
 *    multipart operations to load the provider that was recorded on the
 *    StorageObject row at upload time, so objects stored on an old provider
 *    (or in an old bucket) continue to be served correctly even after the
 *    active provider has changed.
 *
 * Instances are cached in a simple in-memory Map keyed by `${providerId}:${bucket}`.
 * Call invalidate() when a credential row is upserted or deleted so the
 * next request rebuilds the client with fresh credentials.
 */
@Injectable()
export class StorageProviderResolver {
  private readonly logger = new Logger(StorageProviderResolver.name);

  /**
   * Cache key format: `${providerId}:${bucket}` where bucket may be empty.
   * A separate entry is stored when a bucket override differs from the
   * credential's default bucket (e.g. legacy objects in an old bucket).
   */
  private readonly cache = new Map<string, StorageProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly localDiskProvider: LocalDiskStorageProvider,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Return the currently active provider as configured in system settings.
   * Falls back to the STORAGE_PROVIDER env var, then to 's3'.
   *
   * Returns `{ id, provider }` so callers can persist `id` on the StorageObject
   * row (`storageProvider` column) for later per-object resolution.
   */
  async getActiveProvider(): Promise<{ id: string; provider: StorageProvider }> {
    const settings = await this.systemSettings.getSettings();
    const id: string =
      (settings as any).storage?.activeProvider ||
      this.config.get<string>('STORAGE_PROVIDER', 's3');

    const provider = await this.resolveWithBucketOverride(id, null);
    return { id, provider };
  }

  /**
   * Resolve the provider for an EXISTING stored object.
   *
   * @param providerId  The `storageProvider` value from the StorageObject row.
   * @param bucket      The `bucket` value from the StorageObject row (may differ
   *                    from the credential's current default bucket when the
   *                    active bucket was changed after the object was uploaded).
   */
  async getProviderFor(
    providerId: string,
    bucket?: string | null,
  ): Promise<StorageProvider> {
    return this.resolveWithBucketOverride(providerId, bucket ?? null);
  }

  /**
   * Build a StorageProvider from an explicit S3ProviderConfig without caching.
   * Useful for ephemeral "test connection" flows where credentials have not
   * yet been persisted.
   */
  buildEphemeral(cfg: S3ProviderConfig): StorageProvider {
    return new S3StorageProvider(this.config, cfg);
  }

  /**
   * Invalidate cached provider instances.
   *
   * @param providerId  When supplied, only entries whose key starts with
   *                    `${providerId}:` are removed. When omitted, the entire
   *                    cache is cleared.
   */
  invalidate(providerId?: string): void {
    if (!providerId) {
      this.cache.clear();
      this.logger.log('StorageProviderResolver: full cache invalidated');
      return;
    }

    const prefix = `${providerId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    this.logger.log(
      `StorageProviderResolver: cache invalidated for provider "${providerId}"`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Core resolution logic with optional bucket override.
   *
   * @param providerId  Provider identifier ('s3', 'r2', 'local', …)
   * @param bucketOverride  When non-null, the resolved provider will be bound
   *                        to this specific bucket instead of the credential's
   *                        default. A separate cache entry is kept for each
   *                        distinct bucket so legacy objects are still served.
   */
  private async resolveWithBucketOverride(
    providerId: string,
    bucketOverride: string | null,
  ): Promise<StorageProvider> {
    const cacheKey = `${providerId}:${bucketOverride ?? ''}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const provider = await this.build(providerId, bucketOverride);
    this.cache.set(cacheKey, provider);

    this.logger.debug(
      `StorageProviderResolver: built and cached provider for key "${cacheKey}"`,
    );

    return provider;
  }

  /**
   * Build a fresh StorageProvider for the given provider ID.
   *
   * Resolution order:
   * 1. 'local' → return injected LocalDiskStorageProvider (no credential row needed)
   * 2. Look up a StorageProviderCredential row for the provider ID.
   *    If found and enabled → build S3StorageProvider from the decrypted credential.
   * 3. Fallback (no credential row): build S3StorageProvider without an explicit
   *    config so it uses the existing ConfigService / env-var path.  If a bucket
   *    override was requested, pass an explicit config built from the env values
   *    but substitute the requested bucket so the right bucket is used.
   */
  private async build(
    providerId: string,
    bucketOverride: string | null,
  ): Promise<StorageProvider> {
    // Local disk provider is injected directly; no credential row needed.
    if (providerId === 'local') {
      return this.localDiskProvider;
    }

    // Try to load a credential row from the database.
    const cred = await this.prisma.storageProviderCredential.findUnique({
      where: { provider: providerId },
    });

    if (cred && cred.enabled) {
      // --- Credential-based build ---
      let secretAccessKey: string;
      try {
        secretAccessKey = decryptSecret(cred.encryptedKey);
      } catch (err) {
        this.logger.error(
          `StorageProviderResolver: failed to decrypt credentials for provider "${providerId}": ${(err as Error).message}`,
        );
        throw err;
      }

      const cfg: S3ProviderConfig = {
        region: cred.region ?? undefined,
        endpoint: cred.endpoint ?? undefined,
        accessKeyId: cred.accessKeyId ?? undefined,
        secretAccessKey,
        // Prefer the per-object bucket override when present; fall back to
        // whatever bucket is stored on the credential row.
        bucket: bucketOverride ?? cred.bucket ?? undefined,
        forcePathStyle: !!cred.endpoint,
        maxAttempts: this.config.get<number>('storage.s3.maxAttempts', 5),
        retryMode: this.config.get<string>(
          'storage.s3.retryMode',
          'adaptive',
        ) as 'standard' | 'adaptive' | 'legacy',
      };

      this.logger.log(
        `StorageProviderResolver: building provider "${providerId}" from credential row (bucket: ${cfg.bucket ?? 'none'})`,
      );

      return new S3StorageProvider(this.config, cfg);
    }

    // --- Env-var / ConfigService fallback ---
    // Used for: legacy 's3' objects created before the credential table existed,
    // fresh installs where no credential row has been saved yet, or when the
    // credential row is disabled.
    this.logger.warn(
      `StorageProviderResolver: no enabled credential found for provider "${providerId}", falling back to env-var config`,
    );

    if (bucketOverride) {
      // Build an explicit config from env-var values but honour the bucket
      // override so reads from the correct bucket still work.
      const cfg: S3ProviderConfig = {
        region: this.config.get<string>('storage.s3.region'),
        endpoint: this.config.get<string>('storage.s3.endpoint'),
        accessKeyId: this.config.get<string>('storage.s3.accessKeyId'),
        secretAccessKey: this.config.get<string>('storage.s3.secretAccessKey'),
        bucket: bucketOverride,
        maxAttempts: this.config.get<number>('storage.s3.maxAttempts', 5),
        retryMode: this.config.get<string>(
          'storage.s3.retryMode',
          'adaptive',
        ) as 'standard' | 'adaptive' | 'legacy',
      };
      const endpoint = cfg.endpoint;
      cfg.forcePathStyle = !!endpoint;

      return new S3StorageProvider(this.config, cfg);
    }

    // No bucket override: use the original no-arg ConfigService path so
    // every existing config key (`storage.s3.*`) is read as before.
    return new S3StorageProvider(this.config);
  }
}
