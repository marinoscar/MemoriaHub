// =============================================================================
// Storage Migration Handler
// =============================================================================
//
// Enrichment handler type: 'storage_migration'
//
// Each job carries a payload: { runId, itemId, objectId }
//
// The handler copies bytes from the source provider to the destination provider
// WITHOUT deleting the source file (copy-only).  The StorageObject row is
// repointed to the target provider only after a verified copy succeeds, inside
// a single database transaction.
//
// --- Failure / finalization strategy ---
//
// The enrichment worker already handles retry/backoff for transient errors
// (throwing from process() puts the job back to pending with exponential
// backoff). However, the worker does NOT update our domain tables
// (StorageMigrationItem, StorageMigrationRun) on terminal failure — it only
// marks the enrichment_job row as failed.
//
// Our approach:
//   1. Transient errors (network glitches, S3 throttling): throw so the worker
//      retries.  We update item.status='copying' on entry so progress is visible
//      but leave finalization to the success path.
//   2. Terminal errors (the worker calls process() for its final attempt and it
//      still throws): we catch the error INSIDE process(), mark the item failed
//      and increment failedCount, then RETHROW so the worker can record the
//      job as failed in enrichment_jobs.  We detect "this is the last attempt"
//      by comparing job.attempts + 1 >= MAX_ATTEMPTS (read from env, default 3).
//   3. The status endpoint recomputes aggregate counts (migratedCount etc.) from
//      a groupBy on StorageMigrationItem.status rather than trusting only the
//      denormalized run counters — this makes the status display correct even if
//      a job skips the increment path due to a crash.
//
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, StorageMigrationItemStatus, StorageMigrationStatus, StorageObjectStatus } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';

// Mirror the env-var default from the worker so we can detect the final attempt.
function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const MAX_ATTEMPTS = getEnvInt('ENRICHMENT_MAX_ATTEMPTS', 3);

// Statuses considered "active" — used to gate concurrent migration checks
const ACTIVE_RUN_STATUSES = [
  StorageMigrationStatus.pending,
  StorageMigrationStatus.running,
] as const;

// StorageObject statuses whose objects are safe to copy (i.e., fully uploaded)
const COPYABLE_STATUSES = [
  StorageObjectStatus.ready,
] as const;

@Injectable()
export class StorageMigrationHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'storage_migration';

  private readonly logger = new Logger(StorageMigrationHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as { runId?: string; itemId?: string; objectId?: string } | null;
    if (!payload?.runId || !payload?.itemId || !payload?.objectId) {
      throw new Error(
        `storage_migration job ${job.id} has invalid payload: ${JSON.stringify(payload)}`,
      );
    }

    const { runId, itemId, objectId } = payload;

    // ─── Load item ────────────────────────────────────────────────────────────

    const item = await this.prisma.storageMigrationItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      // Item was deleted (run cancelled + cleanup?) — nothing to do.
      this.logger.warn(`storage_migration job ${job.id}: item ${itemId} not found; skipping`);
      return;
    }

    // Idempotent no-op for retried/duplicate jobs that already succeeded.
    if (item.status === StorageMigrationItemStatus.completed) {
      this.logger.debug(`storage_migration job ${job.id}: item ${itemId} already completed; skipping`);
      return;
    }

    // ─── Load run ─────────────────────────────────────────────────────────────

    const run = await this.prisma.storageMigrationRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      // Run was deleted — skip item, nothing to aggregate into.
      this.logger.warn(`storage_migration job ${job.id}: run ${runId} not found; skipping`);
      return;
    }

    // If the run was cancelled, skip this item.
    if (run.status === StorageMigrationStatus.cancelled) {
      await this.prisma.$transaction([
        this.prisma.storageMigrationItem.update({
          where: { id: itemId },
          data: { status: StorageMigrationItemStatus.skipped, updatedAt: new Date() },
        }),
        this.prisma.storageMigrationRun.update({
          where: { id: runId },
          data: { skippedCount: { increment: 1 } },
        }),
      ]);
      await this.maybeFinalizeRun(runId);
      return;
    }

    // ─── Mark run as running (lazy; first item to start flips the run status) ─

    if (run.status === StorageMigrationStatus.pending) {
      await this.prisma.storageMigrationRun.update({
        where: { id: runId },
        data: {
          status: StorageMigrationStatus.running,
          startedAt: run.startedAt ?? new Date(),
        },
      });
    }

    // ─── Mark item as copying ─────────────────────────────────────────────────

    await this.prisma.storageMigrationItem.update({
      where: { id: itemId },
      data: { status: StorageMigrationItemStatus.copying, updatedAt: new Date() },
    });

    // ─── Core copy logic (may throw for transient errors → worker retries) ────

    try {
      await this.doCopy({ runId, itemId, objectId, run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Determine whether this is the terminal attempt.
      // job.attempts was NOT yet incremented when process() is called — the
      // worker increments it in the failure path AFTER process() throws.
      // So if attempts + 1 >= MAX_ATTEMPTS, there will be no further retry.
      const isTerminal = job.attempts + 1 >= MAX_ATTEMPTS;

      if (isTerminal) {
        // Record domain-level failure so the status endpoint reflects it.
        try {
          await this.prisma.$transaction([
            this.prisma.storageMigrationItem.update({
              where: { id: itemId },
              data: {
                status: StorageMigrationItemStatus.failed,
                lastError: message,
                updatedAt: new Date(),
              },
            }),
            this.prisma.storageMigrationRun.update({
              where: { id: runId },
              data: {
                failedCount: { increment: 1 },
                lastError: message,
              },
            }),
          ]);

          await this.maybeFinalizeRun(runId);
        } catch (dbErr) {
          // Best-effort — don't shadow the original error
          this.logger.error(
            `storage_migration job ${job.id}: failed to record terminal failure for item ${itemId}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
          );
        }
      }

      // Always rethrow so the worker can apply its normal retry/fail logic
      // and update the enrichment_job row accordingly.
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // doCopy — the actual byte-level copy + repoint
  // ---------------------------------------------------------------------------

  private async doCopy(args: {
    runId: string;
    itemId: string;
    objectId: string;
    run: { targetProvider: string };
  }): Promise<void> {
    const { runId, itemId, objectId, run } = args;

    // ─── Load the StorageObject ────────────────────────────────────────────────

    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!object) {
      // Object was deleted — skip gracefully.
      this.logger.warn(`storage_migration: objectId ${objectId} not found; marking skipped`);
      await this.prisma.$transaction([
        this.prisma.storageMigrationItem.update({
          where: { id: itemId },
          data: { status: StorageMigrationItemStatus.skipped, updatedAt: new Date() },
        }),
        this.prisma.storageMigrationRun.update({
          where: { id: runId },
          data: { skippedCount: { increment: 1 } },
        }),
      ]);
      await this.maybeFinalizeRun(runId);
      return;
    }

    // ─── Resolve providers ────────────────────────────────────────────────────

    const source = await this.resolver.getProviderFor(object.storageProvider, object.bucket);
    const dest = await this.resolver.getProviderFor(run.targetProvider);
    const destBucket = dest.getBucket();

    // ─── Already on target — no bytes to move ─────────────────────────────────

    if (object.storageProvider === run.targetProvider && object.bucket === destBucket) {
      this.logger.debug(
        `storage_migration: object ${objectId} already on provider=${run.targetProvider} bucket=${destBucket ?? 'default'}; marking completed`,
      );
      await this.prisma.$transaction([
        this.prisma.storageMigrationItem.update({
          where: { id: itemId },
          data: {
            status: StorageMigrationItemStatus.completed,
            newStorageKey: object.storageKey,
            updatedAt: new Date(),
          },
        }),
        this.prisma.storageMigrationRun.update({
          where: { id: runId },
          data: { migratedCount: { increment: 1 } },
        }),
      ]);
      await this.maybeFinalizeRun(runId);
      return;
    }

    // ─── COPY bytes (keep the same storage key) ────────────────────────────────
    // We intentionally keep storageKey identical so signed-URL generation and
    // any existing references continue to work after the repoint.  The source
    // file is left in place as a fallback — we NEVER call source.delete().

    const newKey = object.storageKey;

    this.logger.log(
      `storage_migration: copying object ${objectId} (key=${newKey}) from provider=${object.storageProvider} → ${run.targetProvider}`,
    );

    // object.size is a Prisma BigInt — convert with Number() for contentLength.
    // Safe here because contentLength is an integer hint for the SDK, not a
    // JSON-serialized value, and sizes > Number.MAX_SAFE_INTEGER are unrealistic
    // for individual file uploads in this context.
    const stream = await source.download(newKey);
    await dest.upload(newKey, stream, {
      mimeType: object.mimeType,
      contentLength: Number(object.size),
    });

    // ─── VERIFY the copy landed ───────────────────────────────────────────────
    // exists() is a lightweight HEAD; throws on provider error, returns false
    // when the key is absent.  If verification fails we throw so the worker
    // retries with backoff.

    const ok = await dest.exists(newKey);
    if (!ok) {
      throw new Error(
        `storage_migration: copy verification failed — key "${newKey}" not found on target provider "${run.targetProvider}"`,
      );
    }

    // ─── REPOINT the StorageObject row (inside a transaction) ─────────────────
    // Only after a verified copy do we repoint; this is atomic with the
    // item status update and the run counter increment.

    await this.prisma.$transaction([
      // Repoint the object to the new provider/bucket
      this.prisma.storageObject.update({
        where: { id: objectId },
        data: {
          storageProvider: run.targetProvider,
          bucket: destBucket ?? null,
        },
      }),
      // Mark item as completed
      this.prisma.storageMigrationItem.update({
        where: { id: itemId },
        data: {
          status: StorageMigrationItemStatus.completed,
          newStorageKey: newKey,
          updatedAt: new Date(),
        },
      }),
      // Increment the run's migrated counter
      this.prisma.storageMigrationRun.update({
        where: { id: runId },
        data: { migratedCount: { increment: 1 } },
      }),
    ]);

    this.logger.log(
      `storage_migration: object ${objectId} successfully copied and repointed to provider=${run.targetProvider}`,
    );

    // Check whether all items are now accounted for and close the run if so.
    await this.maybeFinalizeRun(runId);
  }

  // ---------------------------------------------------------------------------
  // maybeFinalizeRun
  // ---------------------------------------------------------------------------
  // Reloads the run row and checks whether migratedCount + failedCount +
  // skippedCount has reached totalCount.  If so, marks the run completed or
  // failed accordingly.  Safe to call multiple times — the update is idiomatic
  // and will be a no-op after the first finalization because subsequent calls
  // will see status=completed/failed and bail out early.

  private async maybeFinalizeRun(runId: string): Promise<void> {
    const run = await this.prisma.storageMigrationRun.findUnique({
      where: { id: runId },
    });

    if (!run) return;

    // Already finalized or cancelled
    if (
      run.status === StorageMigrationStatus.completed ||
      run.status === StorageMigrationStatus.failed ||
      run.status === StorageMigrationStatus.cancelled
    ) {
      return;
    }

    const done = run.migratedCount + run.failedCount + run.skippedCount;
    if (done < run.totalCount) {
      return; // Not all items processed yet
    }

    const finalStatus =
      run.failedCount > 0
        ? StorageMigrationStatus.failed
        : StorageMigrationStatus.completed;

    await this.prisma.storageMigrationRun.update({
      where: { id: runId },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
      },
    });

    this.logger.log(
      `storage_migration: run ${runId} finalized with status=${finalStatus} ` +
        `(migrated=${run.migratedCount}, failed=${run.failedCount}, skipped=${run.skippedCount})`,
    );
  }
}

// Re-export active statuses for use by the service layer
export { ACTIVE_RUN_STATUSES, COPYABLE_STATUSES };
