import { Injectable, Logger } from '@nestjs/common';
import type { DbBackupNotifier, DbBackupNotifyOptions } from '@marinoscar/platform-api/db-backup';

// =============================================================================
// DB_BACKUP_NOTIFIER -> log and drop (RETRO-D4, #580)
// =============================================================================
//
// The slice raises two notifications to the holders of `db_backup:read`: a
// backup that failed and a restore that completed. MemoriaHub's notification
// center is still its own (`src/notifications`, eleven app types, no permission
// fan-out and no `db_backup.*` event), and before the slice nothing notified on a
// backup or a restore. To keep that behaviour every call logs and drops; the
// outcome stays visible on `/admin/settings/db-backup` and in the job list.
//
// PLATFORM-ADOPTION-SHIM(RETRO-D3): the notifications slice replaces this with
// `{ provide: DB_BACKUP_NOTIFIER, useExisting: NotificationsService }` and
// registers `DB_BACKUP_NOTIFICATION_EVENTS` with `DB_BACKUP_EMAIL_TEMPLATES`.
// =============================================================================

@Injectable()
export class MemoriaHubDbBackupNotifier implements DbBackupNotifier {
  private readonly logger = new Logger(MemoriaHubDbBackupNotifier.name);

  async notifyPermissionHolders(event: string, permission: string, _payload: object): Promise<void> {
    this.logger.log(`${event} for holders of ${permission} not delivered (notifications slice not adopted yet)`);
  }

  async notifyPermissionHoldersNow(
    event: string,
    permission: string,
    _payload: object,
    _options?: DbBackupNotifyOptions,
  ): Promise<void> {
    this.logger.log(`${event} for holders of ${permission} not delivered (notifications slice not adopted yet)`);
  }
}
