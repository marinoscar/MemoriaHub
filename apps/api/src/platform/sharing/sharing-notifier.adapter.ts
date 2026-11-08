import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { NotifyOptions } from '@marinoscar/platform-api/notifications';
import { SettingsResolver } from '@marinoscar/platform-api/settings';
import type { SharingNotifier, SharingNotifyHint } from '@marinoscar/platform-api/sharing';

// =============================================================================
// SHARING_NOTIFIER -> the platform dispatcher (RETRO-I1, #562)
// =============================================================================
//
// A thin pass-through to `NotificationsService` (`notify` / `notifyAddress`,
// which never reject). The slice calls it AFTER the change's transaction
// committed, outside it. The app adds what the slice leaves to it:
//
//   - the absolute sign-in URL (`${APP_URL}/login`) the e-mail button points
//     at and, for `sharing.shared_with_you`, the record's absolute URL when its
//     resource type's `describe()` gives a root-relative path;
//   - the acting user's time zone as `NotifyOptions.timeZone`, the render zone
//     for a recipient with none of their own (the slice cannot read settings).
//
// Nothing reaches it in RETRO-I1: no group or grant exists until RETRO-I2..I5.
// =============================================================================

@Injectable()
export class SharingNotifierAdapter implements SharingNotifier {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly settings: SettingsResolver,
  ) {}

  async notify(eventKey: string, userId: string, data: unknown, hint?: SharingNotifyHint): Promise<void> {
    await this.notifications.notify(eventKey, userId, this.withUrls(data), await this.zoneHint(hint));
  }

  async notifyAddress(eventKey: string, email: string, data: unknown, hint?: SharingNotifyHint): Promise<void> {
    await this.notifications.notifyAddress(eventKey, email, this.withUrls(data), await this.zoneHint(hint));
  }

  /** The actor's zone, or nothing (no actor, no zone, or a failed read). */
  private async zoneHint(hint?: SharingNotifyHint): Promise<NotifyOptions | undefined> {
    if (!hint?.actorUserId) return undefined;
    try {
      const timeZone = await this.settings.resolveUserTimeZone(hint.actorUserId);
      return timeZone ? { timeZone } : undefined;
    } catch {
      return undefined;
    }
  }

  private withUrls(data: unknown): unknown {
    const appUrl = this.config.get<string>('appUrl');
    if (!appUrl || data === null || typeof data !== 'object') return data;

    const base = appUrl.replace(/\/+$/, '');
    const fields = data as Record<string, unknown>;
    const path =
      typeof fields.path === 'string' && fields.path.startsWith('/') && !fields.path.startsWith('//')
        ? fields.path
        : null;

    return { ...fields, signInUrl: `${base}/login`, ...(path ? { openUrl: `${base}${path}` } : {}) };
  }
}
