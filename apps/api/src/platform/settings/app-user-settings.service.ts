// =============================================================================
// The platform UserSettingsService, with MemoriaHub's write/read behaviours (RETRO-B3)
// =============================================================================
//
// `settings.config.ts` binds this class to the platform's `UserSettingsService` token. It adds:
//
//   1. dismiss-on-disable (issue #251): turning a notification type off dismisses the user's live
//      rows of it, because the intent is "stop showing me this", not "stop showing me this except
//      the eleven already there". PLATFORM-ADOPTION-SHIM(RETRO-D3): this used to share the settings
//      write's transaction; the platform write has no transaction hook, so it runs right after the
//      commit. The set dismissed is "types disabled AFTER this write", not a diff, so a failure here
//      is logged and the next save repairs it. Seam request: a write hook inside the transaction.
//   2. the preference cache and the time-zone cache are invalidated after every write, so a
//      re-enabled type produces again on the very next notification and a changed zone applies at once.
//   3. navigation read-side sanitising: a stored pin naming a destination this release no longer has
//      is dropped from every read, which is what keeps the strict pin enum safe on the next PATCH.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PLATFORM_PRISMA } from '@marinoscar/platform-api/core';
import { PrincipalCache } from '@marinoscar/platform-api/identity';
import {
  SETTINGS_PROFILE_IMAGES,
  UserSettingsService,
  type PatchUserSettingsDto,
  type SettingsProfileImages,
  type UserSettingsResponse,
} from '@marinoscar/platform-api/settings';

import { disabledNotificationTypes } from '../../notifications/notification-preferences.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { UserTimeZoneService } from '../../settings/user-timezone.service';
import type { NotificationPreferencesValue } from '../../settings/registry/namespaces/user/notifications';
import { sanitizeNavigation } from '../../settings/registry/namespaces/user/navigation';

type BasePrisma = ConstructorParameters<typeof UserSettingsService>[0];

@Injectable()
export class AppUserSettingsService extends UserSettingsService {
  private readonly appLogger = new Logger(AppUserSettingsService.name);

  constructor(
    @Inject(PLATFORM_PRISMA) prisma: BasePrisma,
    principalCache: PrincipalCache,
    @Inject(SETTINGS_PROFILE_IMAGES) profileImages: SettingsProfileImages,
    private readonly notifications: NotificationsService,
    private readonly userTimeZone: UserTimeZoneService,
  ) {
    super(prisma, principalCache, profileImages);
  }

  override async getSettings(userId: string): Promise<UserSettingsResponse> {
    const settings = await super.getSettings(userId);
    if (settings.navigation) {
      return { ...settings, navigation: sanitizeNavigation(settings.navigation) };
    }
    return settings;
  }

  override async replaceSettings(
    userId: string,
    dto: Parameters<UserSettingsService['replaceSettings']>[1],
  ): Promise<UserSettingsResponse> {
    const result = await super.replaceSettings(userId, dto);
    await this.afterWrite(userId, result);
    return result;
  }

  override async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ): Promise<UserSettingsResponse> {
    const result = await super.patchSettings(userId, dto, expectedVersion);
    await this.afterWrite(userId, result);
    return result;
  }

  private async afterWrite(userId: string, result: UserSettingsResponse): Promise<void> {
    const disabled = disabledNotificationTypes(
      (result as unknown as { notifications?: NotificationPreferencesValue }).notifications,
    );
    if (disabled.length > 0) {
      try {
        await this.notifications.dismissTypesForUser(userId, disabled);
      } catch (err) {
        this.appLogger.error(
          `Could not dismiss live notifications of the types user ${userId} disabled: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    // Unconditional: cheap (Map deletes), and AFTER the write, never inside a transaction that may roll back.
    this.notifications.invalidatePreferences(userId);
    this.userTimeZone.invalidate(userId);
  }
}
