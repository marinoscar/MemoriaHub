// =============================================================================
// The database backup slice's composition (RETRO-D4, #580)
// =============================================================================
//
// `DbBackupModule.forRoot` replaces MemoriaHub's own `src/db-backup/` (epic #339):
// the streaming `pg_dump` engine, the schedule and retention, the restore
// (read-only pre-flight, scratch database, double rename, carry-over, rollback),
// the four job types (`db.backup.run`, `db.backup.sweep`, `db.restore.run`,
// `db.restore.old-db-drop`), the `/api/admin/db-backup/*` routes
// (`db_backup:read|write|restore`, same strings as before) and the Doctor checks
// `backup.schedule`, `backup.pg-client`, `backup.rls-bypass`, `backup.mirrors`.
// `DatabaseBackupScheduleTask` only decides and enqueues (the old app task ran the
// staleness sweep and the dump inline).
//
// Every dump and restore carries BOTH `--enable-row-security` and
// `PGOPTIONS=-c app.rls_bypass=on` (the platform does this; never wrap it). The
// old app dumps carried neither, so once a table forces row-level security its
// rows would have been missing from every archive.
//
// Archives are written under `database-backups/memoriahub/YYYY/MM/`; the
// pre-platform ones stay under `db-backups/` (see `app-registrations/db-backup.ts`).
//
// WHAT IT NEEDS FROM THIS APP, all mounted before it in `app.module.ts`: the jobs
// and settings slices (global), the host core (`PLATFORM_PRISMA`,
// `MaintenanceModeService`, `AppMetricsService`, `DeploymentModeService`), the
// Doctor, and the config key `dbBackup.scheduleEnabled` (`config/configuration.ts`,
// from `DB_BACKUP_SCHEDULE_ENABLED`).
// =============================================================================

import '../../app-registrations/db-backup';

import { APP_SLUG } from '@app/shared';
import { DbBackupModule } from '@marinoscar/platform-api/db-backup';

import { resolveApiVersion } from '../../openapi/version';
import { DbBackupHostModule } from './db-backup-host.module';
import { MemoriaHubBackupTarget } from './memoriahub-backup.target';

export const dbBackupModule = DbBackupModule.forRoot({
  appName: APP_SLUG,
  appVersion: resolveApiVersion,
  // PLATFORM-ADOPTION-SHIM(RETRO-SEAM-STORAGE-2): per-run routing over the platform storage slice
  // (memoriahub-backup.target.ts), until the default target reads the run's recorded location.
  target: { useExisting: MemoriaHubBackupTarget },
  imports: [DbBackupHostModule],
});
