import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { DatabaseBackupRetentionService } from './database-backup-retention.service';
import { DatabaseBackupRunnerService } from './database-backup-runner.service';
import { DatabaseBackupAdminService } from './db-backup-admin.service';
import { DatabaseRestoreService } from './database-restore.service';
import { DatabaseBackupScheduleTask } from './db-backup-schedule.task';
import { DatabaseBackupController } from './db-backup.controller';
import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';

/**
 * DbBackupModule — PostgreSQL Database Backup & Restore (epic #339, issue #341).
 *
 * A top-level module (matching `memories/`, `nodes/`, `enhancement/`) — the
 * backup features in this repo are deliberately kept apart by name and
 * location:
 *   - `/api/nodes/:id/backup/*`    "Local Media Backup" (node pull-mirror)
 *   - `apps/api/src/db-backup/`    THIS: the PostgreSQL logical backup
 *
 * (A v0 "Admin: Backup" at `apps/api/src/jobs/backup/`, replicating S3 to the
 * API host's own disk, was retired in issue #367.)
 *
 * Imports:
 *   - PrismaModule: the `DatabaseBackupRun` state machine (#340).
 *   - SettingsModule: AppSystemSettingsService, for the `databaseBackup.*`
 *     namespace (`compressionLevel`, `storageProvider`).
 *   - StorageProvidersModule: StorageProviderResolver, so the dump lands on the
 *     configured/active provider instead of a hardcoded local path.
 *
 * Exports the runner so #342's scheduler cron and #343's admin controller can
 * both drive a run without duplicating any of the lifecycle.
 *
 * #342 adds two providers alongside it:
 *   - DatabaseBackupScheduleTask: the every-10-minutes cron that fires due
 *     backups and releases stale runs. Registered as a plain provider — Nest's
 *     ScheduleModule discovers `@Cron` methods on any instantiated provider, so
 *     no per-module import is needed (same as TrashPurgeTask/NodeBackupStaleTask).
 *   - DatabaseBackupRetentionService: exported too, so #343's manual-run
 *     endpoint can prune on the same rules the scheduler uses rather than
 *     growing a second retention policy.
 */
@Module({
  imports: [
    PrismaModule,
    
    StorageProvidersModule,
    // #344's swap consumes maintenance mode's IN-MEMORY override (the only
    // layer that still works while the database holding the persisted flag is
    // being renamed) from the platform host core: `MaintenanceModeService` is
    // exported by the global `PlatformHostCoreModule`, so nothing is imported.
  ],
  controllers: [DatabaseBackupController],
  providers: [
    DatabaseBackupRunnerService,
    DatabaseBackupAdminService,
    DatabaseBackupRetentionService,
    DatabaseBackupScheduleTask,
    DatabaseRestoreService,
  ],
  exports: [
    DatabaseBackupRunnerService,
    DatabaseBackupRetentionService,
    DatabaseRestoreService,
  ],
})
export class DbBackupModule {}
