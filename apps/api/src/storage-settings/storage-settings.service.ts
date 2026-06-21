// =============================================================================
// Storage Settings Service
// =============================================================================
//
// Manages storage provider credentials and the active provider configuration.
// Mirrors AiSettingsService / FaceSettingsService patterns.
// =============================================================================

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';
import {
  KNOWN_STORAGE_PROVIDERS,
  getStorageProviderDescriptor,
} from './providers/storage-provider.registry';
import { UpsertStorageCredentialsDto } from './dto/storage-credentials.dto';
import { TestStorageProviderDto } from './dto/test-storage-provider.dto';
import { SetActiveStorageProviderDto } from './dto/set-active-provider.dto';
import type { S3ProviderConfig } from '../storage/providers/s3/s3-storage.provider';

@Injectable()
export class StorageSettingsService {
  private readonly logger = new Logger(StorageSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // getSettings
  // ---------------------------------------------------------------------------

  /** Return the storage settings summary (no plaintext keys, no ciphertext) */
  async getSettings() {
    const creds = await this.prisma.storageProviderCredential.findMany({
      select: {
        provider: true,
        accessKeyId: true,
        region: true,
        bucket: true,
        endpoint: true,
        last4: true,
        enabled: true,
        updatedAt: true,
      },
      orderBy: { provider: 'asc' },
    });

    const sysSettings = await this.systemSettings.getSettings();
    const activeProvider: string =
      (sysSettings as any).storage?.activeProvider ??
      process.env['STORAGE_PROVIDER'] ??
      's3';

    const configuredKeys = new Set(creds.map(c => c.provider));

    // Providers that have a DB credential row
    const configuredProviders = creds.map(c => {
      const descriptor = getStorageProviderDescriptor(c.provider);
      return {
        provider: c.provider,
        label: descriptor?.label ?? c.provider,
        configured: true,
        enabled: c.enabled,
        requiresCredentials: descriptor?.requiresCredentials ?? true,
        accessKeyId: c.accessKeyId ?? null,
        region: c.region ?? null,
        bucket: c.bucket ?? null,
        endpoint: c.endpoint ?? null,
        last4: c.last4 || null,
        updatedAt: c.updatedAt,
      };
    });

    // Registry providers with no DB row (keyless ones are still "available")
    const knownProviders = KNOWN_STORAGE_PROVIDERS.filter(
      p => !configuredKeys.has(p.key),
    ).map(p => ({
      provider: p.key,
      label: p.label,
      configured: false,
      enabled: false,
      requiresCredentials: p.requiresCredentials,
      accessKeyId: null,
      region: null,
      bucket: null,
      endpoint: null,
      last4: null,
    }));

    return {
      providers: configuredProviders,
      knownProviders,
      activeProvider,
    };
  }

  // ---------------------------------------------------------------------------
  // upsertCredential
  // ---------------------------------------------------------------------------

  /** Upsert credential for a storage provider */
  async upsertCredential(
    provider: string,
    dto: UpsertStorageCredentialsDto,
    userId: string,
  ) {
    const descriptor = getStorageProviderDescriptor(provider);
    if (!descriptor) {
      throw new BadRequestException(`Unknown storage provider: "${provider}"`);
    }

    // Look up the existing row so we can decide whether this is a CREATE or UPDATE
    // and whether we need to preserve the stored secret.
    const existing = await this.prisma.storageProviderCredential.findUnique({
      where: { provider },
    });
    const isCreate = !existing;

    // On CREATE, validate all required fields up front.
    // On UPDATE, required-field checks are skipped — the admin may be changing only
    // a subset of fields (e.g. region or enabled) without re-entering the secret.
    if (isCreate && descriptor.requiresCredentials) {
      if (!dto.secretAccessKey) {
        throw new BadRequestException(
          `secretAccessKey is required for provider "${provider}"`,
        );
      }
      if (!dto.accessKeyId) {
        throw new BadRequestException(
          `accessKeyId is required for provider "${provider}"`,
        );
      }
      if (!dto.bucket) {
        throw new BadRequestException(
          `bucket is required for provider "${provider}"`,
        );
      }
      if (descriptor.endpointRequired && !dto.endpoint) {
        throw new BadRequestException(
          `endpoint is required for provider "${provider}"`,
        );
      }
    }

    // Determine encryptedKey / last4:
    //   1. New secret provided → encrypt it.
    //   2. No secret, but an existing row exists → reuse its stored key.
    //   3. No secret, no existing row, requiresCredentials → error (caught above for
    //      isCreate; extra safety guard here in case logic changes).
    //   4. Keyless provider (local) with no secret → store empty string.
    let encryptedKey: string;
    let last4: string;

    if (dto.secretAccessKey) {
      encryptedKey = encryptSecret(dto.secretAccessKey);
      last4 = dto.secretAccessKey.slice(-4);
    } else if (existing) {
      // Partial update — preserve the existing secret, don't touch it.
      encryptedKey = existing.encryptedKey;
      last4 = existing.last4 ?? '';
    } else if (descriptor.requiresCredentials) {
      // CREATE without a secret on a provider that needs one — already rejected
      // above, but guard here for safety.
      throw new BadRequestException(
        `secretAccessKey is required for provider "${provider}"`,
      );
    } else {
      // Keyless provider (e.g. local) — no secret needed.
      encryptedKey = encryptSecret('');
      last4 = '';
    }

    const cred = await this.prisma.storageProviderCredential.upsert({
      where: { provider },
      create: {
        provider,
        encryptedKey,
        accessKeyId: dto.accessKeyId ?? null,
        region: dto.region ?? null,
        bucket: dto.bucket ?? null,
        endpoint: dto.endpoint ?? null,
        last4,
        enabled: dto.enabled ?? true,
        updatedByUserId: userId,
      },
      update: {
        encryptedKey,
        // Only overwrite non-secret fields when the dto provides them;
        // fall back to the existing value so a partial PATCH doesn't null fields
        // the admin didn't intend to clear.
        ...(dto.accessKeyId !== undefined
          ? { accessKeyId: dto.accessKeyId }
          : existing?.accessKeyId !== undefined
            ? { accessKeyId: existing.accessKeyId }
            : {}),
        ...(dto.region !== undefined
          ? { region: dto.region }
          : existing?.region !== undefined
            ? { region: existing.region }
            : {}),
        ...(dto.bucket !== undefined
          ? { bucket: dto.bucket }
          : existing?.bucket !== undefined
            ? { bucket: existing.bucket }
            : {}),
        ...(dto.endpoint !== undefined
          ? { endpoint: dto.endpoint }
          : existing?.endpoint !== undefined
            ? { endpoint: existing.endpoint }
            : {}),
        last4,
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        updatedByUserId: userId,
      },
    });

    // Invalidate cached provider so next request picks up fresh credentials
    this.resolver.invalidate(provider);

    this.logger.log(
      `Storage credential upserted for provider "${provider}" by user ${userId}`,
    );

    return {
      provider: cred.provider,
      configured: true,
      enabled: cred.enabled,
      accessKeyId: cred.accessKeyId ?? null,
      region: cred.region ?? null,
      bucket: cred.bucket ?? null,
      endpoint: cred.endpoint ?? null,
      last4: cred.last4 || null,
    };
  }

  // ---------------------------------------------------------------------------
  // deleteCredential
  // ---------------------------------------------------------------------------

  /** Delete credential for a storage provider */
  async deleteCredential(provider: string) {
    // Block deletion when this provider is currently active
    const sysSettings = await this.systemSettings.getSettings();
    const activeProvider: string =
      (sysSettings as any).storage?.activeProvider ??
      process.env['STORAGE_PROVIDER'] ??
      's3';

    if (provider === activeProvider) {
      throw new BadRequestException(
        `Cannot delete the credential for the currently active storage provider "${provider}". ` +
          `Switch the active provider first.`,
      );
    }

    const existing = await this.prisma.storageProviderCredential.findUnique({
      where: { provider },
    });
    if (!existing) {
      throw new NotFoundException(
        `No credential configured for storage provider: "${provider}"`,
      );
    }

    await this.prisma.storageProviderCredential.delete({ where: { provider } });
    this.resolver.invalidate(provider);

    this.logger.log(`Storage credential deleted for provider "${provider}"`);
  }

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------

  /**
   * Test connectivity to a storage provider.
   *
   * When override fields are supplied in the DTO (for "test before save" flows),
   * an ephemeral S3StorageProvider is built directly from those values.
   * Otherwise the credential stored in the DB is loaded and decrypted.
   *
   * Round-trip: upload a sentinel object → call getMetadata() to verify it
   * exists → delete it.  Never returns secrets.
   */
  async testConnection(dto: TestStorageProviderDto): Promise<{
    ok: boolean;
    provider: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
    error?: string;
  }> {
    const { provider: providerKey } = dto;

    const descriptor = getStorageProviderDescriptor(providerKey);
    if (!descriptor) {
      return { ok: false, provider: providerKey, error: `Unknown provider: "${providerKey}"` };
    }

    const sentinelKey = `__memoriahub_conn_test__/${randomUUID()}`;

    try {
      if (providerKey === 'local') {
        // Local disk provider — resolve via the resolver (no credentials needed)
        const storageProvider = await this.resolver.getProviderFor('local');

        await storageProvider.upload(
          sentinelKey,
          Readable.from(Buffer.from('ok')),
          { mimeType: 'text/plain', contentLength: 2 },
        );
        await storageProvider.getMetadata(sentinelKey);
        await storageProvider.delete(sentinelKey);

        return { ok: true, provider: providerKey };
      }

      // S3 / R2 path
      let cfg: S3ProviderConfig;

      const hasOverrides = !!(
        dto.accessKeyId ||
        dto.secretAccessKey ||
        dto.bucket
      );

      if (hasOverrides) {
        // Build an ephemeral provider from supplied overrides (not yet persisted)
        cfg = {
          accessKeyId: dto.accessKeyId,
          secretAccessKey: dto.secretAccessKey,
          bucket: dto.bucket,
          region: dto.region,
          endpoint: dto.endpoint,
          forcePathStyle: !!dto.endpoint,
        };
      } else {
        // Load from DB
        const cred = await this.prisma.storageProviderCredential.findUnique({
          where: { provider: providerKey },
        });
        if (!cred) {
          return {
            ok: false,
            provider: providerKey,
            error: `Provider "${providerKey}" is not configured`,
          };
        }
        if (!cred.enabled) {
          return {
            ok: false,
            provider: providerKey,
            error: `Provider "${providerKey}" is disabled`,
          };
        }

        const secretAccessKey = decryptSecret(cred.encryptedKey);
        cfg = {
          accessKeyId: cred.accessKeyId ?? undefined,
          secretAccessKey,
          bucket: cred.bucket ?? undefined,
          region: cred.region ?? undefined,
          endpoint: cred.endpoint ?? undefined,
          forcePathStyle: !!cred.endpoint,
        };
      }

      const storageProvider = this.resolver.buildEphemeral(cfg);

      await storageProvider.upload(
        sentinelKey,
        Readable.from(Buffer.from('ok')),
        { mimeType: 'text/plain', contentLength: 2 },
      );
      await storageProvider.getMetadata(sentinelKey);
      await storageProvider.delete(sentinelKey);

      return {
        ok: true,
        provider: providerKey,
        bucket: cfg.bucket,
        region: cfg.region,
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      };
    } catch (err: unknown) {
      // Best-effort cleanup
      try {
        if (providerKey !== 'local') {
          const cred = await this.prisma.storageProviderCredential.findUnique({
            where: { provider: providerKey },
          });
          if (cred) {
            const secretAccessKey = decryptSecret(cred.encryptedKey);
            const storageProvider = this.resolver.buildEphemeral({
              accessKeyId: cred.accessKeyId ?? undefined,
              secretAccessKey,
              bucket: cred.bucket ?? undefined,
              region: cred.region ?? undefined,
              endpoint: cred.endpoint ?? undefined,
              forcePathStyle: !!cred.endpoint,
            });
            await storageProvider.delete(sentinelKey);
          }
        }
      } catch {
        // Ignore cleanup errors
      }

      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Storage connection test failed for provider "${providerKey}": ${message}`,
      );
      return { ok: false, provider: providerKey, error: message };
    }
  }

  // ---------------------------------------------------------------------------
  // setActiveProvider
  // ---------------------------------------------------------------------------

  /**
   * Change the active storage provider in system settings.
   * The provider must be known.  For providers that require credentials, a
   * configured (enabled) credential row must exist OR the provider must fall back
   * to env-var config (e.g. the legacy 's3' env path).
   */
  async setActiveProvider(dto: SetActiveStorageProviderDto, userId: string) {
    const { provider } = dto;

    const descriptor = getStorageProviderDescriptor(provider);
    if (!descriptor) {
      throw new BadRequestException(`Unknown storage provider: "${provider}"`);
    }

    // For providers requiring credentials, verify at least a row exists or
    // the env-var config covers it (s3 / r2 may be configured purely via env).
    if (descriptor.requiresCredentials) {
      const cred = await this.prisma.storageProviderCredential.findUnique({
        where: { provider },
      });
      // Allow if a DB row exists (even if disabled — the admin can re-enable later)
      // OR if the provider is 's3' (legacy env-var path is always available).
      if (!cred && provider !== 's3') {
        throw new BadRequestException(
          `Provider "${provider}" has no configured credential. Save credentials first.`,
        );
      }
    }

    await this.systemSettings.patchSettings(
      { storage: { activeProvider: provider } } as any,
      userId,
    );

    // Invalidate full cache so next request uses the new active provider
    this.resolver.invalidate();

    this.logger.log(
      `Active storage provider set to "${provider}" by user ${userId}`,
    );

    return { activeProvider: provider };
  }
}
