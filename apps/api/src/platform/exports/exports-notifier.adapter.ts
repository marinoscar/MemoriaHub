import { Injectable } from '@nestjs/common';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { ExportNotificationData, ExportsNotifier } from '@marinoscar/platform-api/exports';

/**
 * The exports slice's `EXPORTS_NOTIFIER` over the platform notifications slice (RETRO-H2, #596).
 *
 * The slice calls it AFTER the export file is committed (or the last attempt failed), outside
 * any transaction; `NotificationsService.notify` never rejects. The data passes through
 * untouched: ids and labels, never a URL, a file name or a value. The events (`export.ready`,
 * `export.failed`) are registered by `notifications-registry/exports.notifications.ts`, bell
 * and Web Push only, both linking to `/settings/data-export`.
 */
@Injectable()
export class ExportsNotifierAdapter implements ExportsNotifier {
  constructor(private readonly notifications: NotificationsService) {}

  async notify(eventKey: string, userId: string, data: ExportNotificationData): Promise<void> {
    await this.notifications.notify(eventKey, userId, data);
  }
}
