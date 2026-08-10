// =============================================================================
// Database Backup retention pruning (issue #342, epic #339)
// =============================================================================
//
// Each dump is plausibly several GB (#339's sizing), so `retentionCount × dump
// size` is the real ongoing storage cost of this feature — 7 dailies is easily
// 20-35 GB. Pruning is therefore not housekeeping, it is the cost control.
//
// Two clocks, deliberately:
//
//   1. COUNT-based, for `manual` and `scheduled` runs. Keep the newest
//      `databaseBackup.retentionCount` completed runs; hard-delete the rest,
//      oldest first.
//
//   2. AGE-based, for `pre_restore` runs, which are EXEMPT from (1). In
//      `restoreRollbackMode='pre_restore_dump'` (#340) such a dump IS the
//      rollback for a restore that just happened; evicting it because seven
//      nightly backups have since run would silently destroy a recovery path
//      while the restore it protects is still fresh. They age out on
//      `oldDatabaseRetentionHours` instead — the same window a retained `_old`
//      database would have lived for, so both rollback strategies expire
//      together.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';

/** Schema defaults (#340), used only when a setting is missing/garbage. */
const DEFAULT_RETENTION_COUNT = 7;
const DEFAULT_OLD_DATABASE_RETENTION_HOURS = 168;

interface PrunableRun {
  id: string;
  storageProvider: string | null;
  storageKey: string | null;
  bucket: string | null;
}

export interface DatabaseBackupPruneResult {
  /** Rows removed by the count-based rule (manual + scheduled runs). */
  prunedByCount: number;
  /** Rows removed by the age-based rule (`pre_restore` runs). */
  prunedByAge: number;
  /** Runs whose storage object could not be deleted, so the row was kept. */
  errors: number;
}

@Injectable()
export class DatabaseBackupRetentionService {
  private readonly logger = new Logger(DatabaseBackupRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly providerResolver: StorageProviderResolver,
  ) {}

  /**
   * Run both retention rules. Called after each successful backup — pruning at
   * the moment new bytes land is what keeps the high-water mark at
   * `retentionCount + 1` rather than letting it drift on a separate schedule.
   *
   * Never throws: a retention failure must not turn an otherwise successful
   * backup into a failed one. The backup already exists and is verified; a
   * missed prune costs storage, a thrown error would cost the run.
   */
  async pruneAfterSuccessfulRun(): Promise<DatabaseBackupPruneResult> {
    const result: DatabaseBackupPruneResult = {
      prunedByCount: 0,
      prunedByAge: 0,
      errors: 0,
    };

    let retentionCount = DEFAULT_RETENTION_COUNT;
    let oldDatabaseRetentionHours = DEFAULT_OLD_DATABASE_RETENTION_HOURS;
    try {
      const settings = (await this.systemSettings.getSettings()) as any;
      const cfg = settings?.databaseBackup ?? {};
      retentionCount = positiveInt(cfg.retentionCount, DEFAULT_RETENTION_COUNT);
      oldDatabaseRetentionHours = positiveInt(
        cfg.oldDatabaseRetentionHours,
        DEFAULT_OLD_DATABASE_RETENTION_HOURS,
      );
    } catch (err) {
      this.logger.warn(
        `Could not read databaseBackup settings for retention; skipping prune: ${errorMessage(err)}`,
      );
      return result;
    }

    try {
      const byCount = await this.pruneByCount(retentionCount);
      result.prunedByCount = byCount.pruned;
      result.errors += byCount.errors;
    } catch (err) {
      result.errors += 1;
      this.logger.warn(`Count-based backup prune failed: ${errorMessage(err)}`);
    }

    try {
      const byAge = await this.prunePreRestoreByAge(oldDatabaseRetentionHours);
      result.prunedByAge = byAge.pruned;
      result.errors += byAge.errors;
    } catch (err) {
      result.errors += 1;
      this.logger.warn(`Age-based pre-restore prune failed: ${errorMessage(err)}`);
    }

    if (result.prunedByCount > 0 || result.prunedByAge > 0) {
      this.logger.log(
        `Database backup retention: pruned ${result.prunedByCount} by count, ` +
          `${result.prunedByAge} expired pre-restore dump(s)` +
          (result.errors > 0 ? `, ${result.errors} could not be removed` : ''),
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Rule 1 — count-based, excluding `pre_restore`
  // ---------------------------------------------------------------------------

  private async pruneByCount(
    retentionCount: number,
  ): Promise<{ pruned: number; errors: number }> {
    const rows = await this.prisma.databaseBackupRun.findMany({
      where: {
        status: 'completed',
        // The exemption. A pre-restore dump is a rollback artifact, not one of
        // the N routine backups the admin asked to keep, and must not be able
        // to push a routine backup out of the retention window either.
        trigger: { not: 'pre_restore' },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, storageProvider: true, storageKey: true, bucket: true },
    });

    // Newest-first, so everything past the keep-window is excess. Reversed so
    // deletion proceeds oldest-first: if the loop dies partway through, what
    // survives is still the newest N-ish backups rather than an arbitrary set.
    const excess = rows.slice(retentionCount).reverse();
    return this.deleteRuns(excess);
  }

  // ---------------------------------------------------------------------------
  // Rule 2 — age-based, `pre_restore` only
  // ---------------------------------------------------------------------------

  private async prunePreRestoreByAge(
    retentionHours: number,
  ): Promise<{ pruned: number; errors: number }> {
    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

    const rows = await this.prisma.databaseBackupRun.findMany({
      where: {
        status: 'completed',
        trigger: 'pre_restore',
        startedAt: { lt: cutoff },
      },
      orderBy: { startedAt: 'asc' },
      select: { id: true, storageProvider: true, storageKey: true, bucket: true },
    });

    return this.deleteRuns(rows);
  }

  // ---------------------------------------------------------------------------
  // Shared deletion path
  // ---------------------------------------------------------------------------

  /**
   * Delete the storage object FIRST, then the row.
   *
   * The ordering is the whole point: a failure between the two steps must leave
   * an orphaned ROW (visible in the admin UI, re-prunable on the next run) and
   * never an orphaned multi-GB OBJECT (invisible, since nothing points at it
   * once the row is gone, and billable forever). So a failed object delete
   * aborts that run's prune and keeps its row.
   */
  private async deleteRuns(
    runs: PrunableRun[],
  ): Promise<{ pruned: number; errors: number }> {
    let pruned = 0;
    let errors = 0;

    for (const run of runs) {
      try {
        await this.deleteStorageObject(run);
      } catch (err) {
        errors += 1;
        this.logger.warn(
          `Keeping database backup row ${run.id}: its storage object could not be deleted: ${errorMessage(err)}`,
        );
        continue;
      }

      try {
        await this.prisma.databaseBackupRun.delete({ where: { id: run.id } });
        pruned += 1;
      } catch (err) {
        errors += 1;
        this.logger.warn(
          `Deleted the object for database backup ${run.id} but could not delete the row: ${errorMessage(err)}`,
        );
      }
    }

    return { pruned, errors };
  }

  private async deleteStorageObject(run: PrunableRun): Promise<void> {
    // A run that never got as far as naming a key has nothing to delete; its
    // row is still prunable.
    if (!run.storageProvider || !run.storageKey) return;

    const provider = await this.providerResolver.getProviderFor(
      run.storageProvider,
      run.bucket,
    );
    await provider.delete(run.storageKey);
  }
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n >= 1 ? n : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
