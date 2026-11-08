// =============================================================================
// The platform UserSettingsService, with MemoriaHub's write/read behaviours (RETRO-B3)
// =============================================================================
//
// `settings.config.ts` binds this class to the platform's `UserSettingsService` token. It adds:
//
//   1. the time-zone cache is invalidated after every write, so a changed zone applies at once.
//      (Dismiss-on-disable for notification events is the platform `notifications` namespace's
//      `onWrite` hook since RETRO-D3, #576, inside the settings transaction.)
//   2. navigation read-side sanitising: a stored pin naming a destination this release no longer has
//      is dropped from every read, which is what keeps the strict pin enum safe on the next PATCH.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { PLATFORM_PRISMA } from '@marinoscar/platform-api/core';
import { PrincipalCache } from '@marinoscar/platform-api/identity';
import {
  SETTINGS_PROFILE_IMAGES,
  UserSettingsService,
  type PatchUserSettingsDto,
  type SettingsProfileImages,
  type UserSettingsResponse,
} from '@marinoscar/platform-api/settings';

import {
  LEGACY_PREFERENCES_ROW_KEY,
  MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE,
  isLegacyUserPreferences,
  transformUserPreferences,
} from '../../legacy/legacy-notifications-migration';
import { UserTimeZoneService } from '../../settings/user-timezone.service';
import { sanitizeNavigation } from '../../settings/registry/namespaces/user/navigation';

type BasePrisma = ConstructorParameters<typeof UserSettingsService>[0];

type Json = Record<string, unknown>;

/** The two delegates the legacy-preference repair writes through (structural). */
interface RepairPrisma {
  userSettings: {
    findUnique(args: { where: { userId: string }; select: { value: true } }): Promise<{ value: unknown } | null>;
    update(args: { where: { userId: string }; data: { value: unknown; version: { increment: number } } }): Promise<unknown>;
  };
  systemSettings: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: unknown };
      update: { value: unknown; version: { increment: number } };
    }): Promise<unknown>;
  };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A user-settings value with MemoriaHub's PRE-PLATFORM `notifications` shape
 * rewritten into the platform's (and `workflowMicroRuns` moved to
 * `memoriahubNotifications`), or `null` when the value is not legacy-shaped.
 */
export function withPlatformNotificationPreferences(value: unknown): Json | null {
  if (!isObject(value) || !isLegacyUserPreferences(value.notifications)) return null;
  const next: Json = { ...value };
  const t = transformUserPreferences(value.notifications);
  if (t.notifications) next.notifications = t.notifications;
  else delete next.notifications;
  if (t.memoriahub) {
    const existing = isObject(next[MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE]) ? (next[MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE] as Json) : {};
    next[MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE] = { ...existing, ...t.memoriahub };
  }
  return next;
}

@Injectable()
export class AppUserSettingsService extends UserSettingsService {
  constructor(
    @Inject(PLATFORM_PRISMA) prisma: BasePrisma,
    principalCache: PrincipalCache,
    @Inject(SETTINGS_PROFILE_IMAGES) profileImages: SettingsProfileImages,
    private readonly userTimeZone: UserTimeZoneService,
  ) {
    super(prisma, principalCache, profileImages);
    this.repairDb = prisma as unknown as RepairPrisma;
  }

  private readonly repairDb: RepairPrisma;

  override async getSettings(userId: string): Promise<UserSettingsResponse> {
    const raw = await super.getSettings(userId);
    // PLATFORM-ADOPTION-SHIM(#576): until the carry-over rewrote this user's row,
    // read the pre-platform preferences in the platform's shape.
    const settings = (withPlatformNotificationPreferences(raw) ?? raw) as UserSettingsResponse;
    if (settings.navigation) {
      return { ...settings, navigation: sanitizeNavigation(settings.navigation) };
    }
    return settings;
  }

  override async replaceSettings(
    userId: string,
    dto: Parameters<UserSettingsService['replaceSettings']>[1],
  ): Promise<UserSettingsResponse> {
    await this.repairLegacyNotificationPreferences(userId);
    const result = await super.replaceSettings(userId, dto);
    await this.afterWrite(userId, result);
    return result;
  }

  override async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ): Promise<UserSettingsResponse> {
    await this.repairLegacyNotificationPreferences(userId);
    const result = await super.patchSettings(userId, dto, expectedVersion);
    await this.afterWrite(userId, result);
    return result;
  }

  /**
   * PLATFORM-ADOPTION-SHIM(#576): a row still holding the PRE-PLATFORM
   * `notifications` shape fails the platform namespace's validation on the next
   * write, so the user could not save any setting until the carry-over
   * (`npm run notifications:migrate-legacy -- --apply`) ran. Rewrite that one row
   * the way the carry-over does first, keeping the original (set-if-absent) in
   * the same `mh_legacy_notification_preferences` row. Idempotent; a no-op once
   * the row is in the platform shape. Removed with the legacy tables.
   */
  private async repairLegacyNotificationPreferences(userId: string): Promise<void> {
    const row = await this.repairDb.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const next = withPlatformNotificationPreferences(row?.value);
    if (!next || !isObject(row?.value)) return;

    const backup = await this.repairDb.systemSettings.findUnique({ where: { key: LEGACY_PREFERENCES_ROW_KEY } });
    const kept: Json = isObject(backup?.value) ? { ...backup.value } : {};
    if (kept[userId] === undefined) {
      kept[userId] = row.value.notifications;
      await this.repairDb.systemSettings.upsert({
        where: { key: LEGACY_PREFERENCES_ROW_KEY },
        create: { key: LEGACY_PREFERENCES_ROW_KEY, value: kept },
        update: { value: kept, version: { increment: 1 } },
      });
    }
    await this.repairDb.userSettings.update({ where: { userId }, data: { value: next, version: { increment: 1 } } });
  }

  // Dismiss-on-disable for the events a user turned off is the platform
  // `notifications` namespace's `onWrite` hook since RETRO-D3 (#576), inside the
  // settings transaction; only the time-zone cache is this class's to drop.
  private async afterWrite(userId: string, _result: UserSettingsResponse): Promise<void> {
    this.userTimeZone.invalidate(userId);
  }
}
