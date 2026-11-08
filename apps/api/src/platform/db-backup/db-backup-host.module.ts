// =============================================================================
// The database backup slice's host ports (RETRO-D4, #580)
// =============================================================================
//
//   DB_BACKUP_NOTIFIER        -> MemoriaHubDbBackupNotifier (log and drop until RETRO-D3)
//   DB_BACKUP_MAINTENANCE     -> MaintenanceModeService     (the host core's in-memory override,
//                                                            which the restore swap sets)
//   DB_BACKUP_METRICS         -> AppMetricsService          (`app.backup.*`, the host core's)
//   DB_BACKUP_DEPLOYMENT_MODE -> DeploymentModeService      (`DEPLOYMENT_MODE`; `saas` turns restore off)
//   DB_BACKUP_SYSTEM_DATA     -> DbBackupSystemDataAdapter  (the `backup.rls-bypass` Doctor check)
//
// It also provides the primary backup target, `MemoriaHubBackupTarget` (bound by
// `db-backup.config.ts` through `forRoot({ target: { useExisting } })`), with the
// app's storage provider resolver it needs.
//
// `@Global()` so the slice's services resolve the ports from whichever module
// instantiates them (the same arrangement as the jobs and identity hosts).
// =============================================================================

import { Global, Module } from '@nestjs/common';
import {
  DB_BACKUP_DEPLOYMENT_MODE,
  DB_BACKUP_MAINTENANCE,
  DB_BACKUP_METRICS,
  DB_BACKUP_NOTIFIER,
  DB_BACKUP_SYSTEM_DATA,
} from '@marinoscar/platform-api/db-backup';
import {
  AppMetricsService,
  DeploymentModeService,
  MaintenanceModeService,
} from '@marinoscar/platform-api/host';

import { StorageProvidersModule } from '../../storage/providers/storage-providers.module';
import { MemoriaHubBackupTarget } from './memoriahub-backup.target';
import { MemoriaHubDbBackupNotifier } from './db-backup-notifier.adapter';
import { DbBackupSystemDataAdapter } from './db-backup-system-data.adapter';

@Global()
@Module({
  imports: [StorageProvidersModule],
  providers: [
    MemoriaHubBackupTarget,
    { provide: DB_BACKUP_NOTIFIER, useClass: MemoriaHubDbBackupNotifier },
    { provide: DB_BACKUP_MAINTENANCE, useExisting: MaintenanceModeService },
    { provide: DB_BACKUP_METRICS, useExisting: AppMetricsService },
    { provide: DB_BACKUP_DEPLOYMENT_MODE, useExisting: DeploymentModeService },
    { provide: DB_BACKUP_SYSTEM_DATA, useClass: DbBackupSystemDataAdapter },
  ],
  exports: [
    MemoriaHubBackupTarget,
    DB_BACKUP_NOTIFIER,
    DB_BACKUP_MAINTENANCE,
    DB_BACKUP_METRICS,
    DB_BACKUP_DEPLOYMENT_MODE,
    DB_BACKUP_SYSTEM_DATA,
  ],
})
export class DbBackupHostModule {}
