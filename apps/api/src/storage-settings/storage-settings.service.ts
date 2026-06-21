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
import {
  StorageMigrationItemStatus,
  StorageMigrationStatus,
  StorageObjectStatus,
  JobReason,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
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
    private readonly enrichmentJobService: EnrichmentJobService,
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

  // ---------------------------------------------------------------------------
  // triggerMigration
  // ---------------------------------------------------------------------------

  /**
   * Create a migration run that copies all `ready` objects from sourceProvider
   * to targetProvider via the enrichment queue (one job per object, copy-only).
   *
   * Rejects when:
   * - source === target
   * - either provider is unknown
   * - an active run (pending|running) already exists
   */
  async triggerMigration(
    { sourceProvider, targetProvider }: { sourceProvider: string; targetProvider: string },
    userId: string,
  ): Promise<{ runId: string; totalCount: number }> {
    if (sourceProvider === targetProvider) {
      throw new BadRequestException('sourceProvider and targetProvider must be different');
    }

    const sourceDescriptor = getStorageProviderDescriptor(sourceProvider);
    if (!sourceDescriptor) {
      throw new BadRequestException(`Unknown storage provider: "${sourceProvider}"`);
    }

    const targetDescriptor = getStorageProviderDescriptor(targetProvider);
    if (!targetDescriptor) {
      throw new BadRequestException(`Unknown storage provider: "${targetProvider}"`);
    }

    // Validate that the target provider is resolvable (has credentials or env fallback).
    // We attempt to build it via the resolver — if it throws, credentials are missing.
    try {
      await this.resolver.getProviderFor(targetProvider);
    } catch (err) {
      throw new BadRequestException(
        `Target provider "${targetProvider}" is not resolvable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Block concurrent runs
    const activeRun = await this.prisma.storageMigrationRun.findFirst({
      where: {
        status: { in: [StorageMigrationStatus.pending, StorageMigrationStatus.running] },
      },
    });
    if (activeRun) {
      throw new BadRequestException(
        `A migration is already in progress (runId=${activeRun.id}, status=${activeRun.status})`,
      );
    }

    // Find objects to migrate: only `ready` objects on the source provider.
    // We select only the id column for performance; the handler fetches the
    // full object row when it processes each job.
    const objects = await this.prisma.storageObject.findMany({
      where: {
        storageProvider: sourceProvider,
        status: StorageObjectStatus.ready,
      },
      select: { id: true },
    });

    const totalCount = objects.length;

    // Create the run row
    const run = await this.prisma.storageMigrationRun.create({
      data: {
        sourceProvider,
        targetProvider,
        status: StorageMigrationStatus.pending,
        totalCount,
        createdById: userId,
      },
    });

    // Short-circuit: no objects to migrate → complete immediately
    if (totalCount === 0) {
      await this.prisma.storageMigrationRun.update({
        where: { id: run.id },
        data: {
          status: StorageMigrationStatus.completed,
          finishedAt: new Date(),
        },
      });
      this.logger.log(`Migration run ${run.id}: no ready objects on "${sourceProvider}"; completed immediately`);
      return { runId: run.id, totalCount: 0 };
    }

    // Create StorageMigrationItem rows in a single createMany call.
    // @@unique([runId, objectId]) prevents duplicates if this is somehow called twice.
    await this.prisma.storageMigrationItem.createMany({
      data: objects.map(o => ({
        runId: run.id,
        objectId: o.id,
        status: StorageMigrationItemStatus.pending,
      })),
      skipDuplicates: true,
    });

    // Reload items to get their generated IDs (createMany doesn't return records in Prisma)
    const items = await this.prisma.storageMigrationItem.findMany({
      where: { runId: run.id },
      select: { id: true, objectId: true },
    });

    // Enqueue one enrichment job per item.
    // skipDedup=true is REQUIRED — all these jobs have null mediaItemId and the
    // same type, so the default dedup logic would collapse them into one job.
    // priority=100 (low) so migration doesn't starve foreground enrichment.
    const enqueuedJobs: Array<{ itemId: string; jobId: string }> = [];

    for (const item of items) {
      const job = await this.enrichmentJobService.enqueue({
        type: 'storage_migration',
        mediaItemId: null,
        circleId: null,
        reason: JobReason.backfill,
        priority: 100,
        skipDedup: true,
        payload: { runId: run.id, itemId: item.id, objectId: item.objectId },
      });
      enqueuedJobs.push({ itemId: item.id, jobId: job.id });
    }

    // Back-fill jobId onto each item (best-effort; non-fatal if it fails)
    // We do this in a loop rather than a transaction because the item IDs are
    // individual and we don't want one failure to roll back all updates.
    for (const { itemId, jobId } of enqueuedJobs) {
      try {
        await this.prisma.storageMigrationItem.update({
          where: { id: itemId },
          data: { jobId },
        });
      } catch (err) {
        this.logger.warn(
          `Migration run ${run.id}: failed to record jobId ${jobId} on item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.logger.log(
      `Migration run ${run.id} created: ${totalCount} objects queued from "${sourceProvider}" → "${targetProvider}"`,
    );

    return { runId: run.id, totalCount };
  }

  // ---------------------------------------------------------------------------
  // getMigrationRun
  // ---------------------------------------------------------------------------

  /**
   * Return a single migration run with recomputed aggregate counts from the
   * StorageMigrationItem table (more accurate than the denormalized counters,
   * which may lag if a crash skipped an increment).
   */
  async getMigrationRun(runId: string) {
    const run = await this.prisma.storageMigrationRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      throw new NotFoundException(`Migration run not found: ${runId}`);
    }

    // Recompute counts from the item rows (authoritative source)
    const countsByStatus = await this.prisma.storageMigrationItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: { id: true },
    });

    const byStatus: Record<string, number> = {};
    for (const row of countsByStatus) {
      byStatus[row.status] = row._count.id;
    }

    const migratedCount = byStatus[StorageMigrationItemStatus.completed] ?? 0;
    const failedCount = byStatus[StorageMigrationItemStatus.failed] ?? 0;
    const skippedCount =
      (byStatus[StorageMigrationItemStatus.skipped] ?? 0) +
      // 'verified' is a transient state that may appear in older items
      (byStatus[StorageMigrationItemStatus.verified] ?? 0);

    return {
      id: run.id,
      sourceProvider: run.sourceProvider,
      targetProvider: run.targetProvider,
      status: run.status,
      totalCount: run.totalCount,
      // Prefer recomputed values; fall back to denormalized counters when the
      // item table has no rows yet (e.g. immediately after run creation).
      migratedCount: countsByStatus.length > 0 ? migratedCount : run.migratedCount,
      failedCount: countsByStatus.length > 0 ? failedCount : run.failedCount,
      skippedCount: countsByStatus.length > 0 ? skippedCount : run.skippedCount,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastError: run.lastError,
      counts: { byStatus },
    };
  }

  // ---------------------------------------------------------------------------
  // listMigrationRuns
  // ---------------------------------------------------------------------------

  async listMigrationRuns({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number } = {}) {
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.storageMigrationRun.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          sourceProvider: true,
          targetProvider: true,
          status: true,
          totalCount: true,
          migratedCount: true,
          failedCount: true,
          skippedCount: true,
          startedAt: true,
          finishedAt: true,
          lastError: true,
          createdAt: true,
        },
      }),
      this.prisma.storageMigrationRun.count(),
    ]);

    return {
      items,
      meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    };
  }

  // ---------------------------------------------------------------------------
  // cancelMigration
  // ---------------------------------------------------------------------------

  /**
   * Cancel a pending or running migration run.
   *
   * Marks the run as cancelled.  In-flight items that are currently being
   * processed by the worker will see the cancelled status when they load the
   * run at the start of process() and will mark themselves as skipped.
   *
   * We also attempt to delete still-pending enrichment jobs for this run by
   * matching on the JSONB payload field.  If the DB doesn't support the JSON
   * path query (or if it's too expensive), the handler's run.status check
   * provides the safety net — cancelled items are skipped without byte copies.
   */
  async cancelMigration(runId: string) {
    const run = await this.prisma.storageMigrationRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      throw new NotFoundException(`Migration run not found: ${runId}`);
    }

    if (
      run.status !== StorageMigrationStatus.pending &&
      run.status !== StorageMigrationStatus.running
    ) {
      throw new BadRequestException(
        `Cannot cancel a run with status "${run.status}"; only pending or running runs can be cancelled`,
      );
    }

    const updated = await this.prisma.storageMigrationRun.update({
      where: { id: runId },
      data: { status: StorageMigrationStatus.cancelled, finishedAt: new Date() },
    });

    // Best-effort: delete pending enrichment jobs for this run.
    // The JSONB path cast via raw SQL handles providers that support it.
    // If this fails (e.g. cast not supported), the handler's run.status check
    // will skip the in-flight items gracefully.
    try {
      await this.prisma.$executeRaw`
        DELETE FROM enrichment_jobs
        WHERE type = 'storage_migration'
          AND status = 'pending'
          AND payload->>'runId' = ${runId}
      `;
    } catch (err) {
      this.logger.warn(
        `cancelMigration: could not delete pending enrichment jobs for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(`Migration run ${runId} cancelled by admin`);
    return updated;
  }
}
