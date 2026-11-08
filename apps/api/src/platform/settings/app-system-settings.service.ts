// =============================================================================
// The platform SystemSettingsService, with MemoriaHub's three write/read behaviours (RETRO-B3)
// =============================================================================
//
// `settings.config.ts` binds this class to the platform's `SystemSettingsService` token, so every
// injection (the platform controllers and slices, and every app service) gets it. It adds exactly:
//
//   1. a 5 s in-process cache on `getSettings()`. Bulk imports read the feature flags once per
//      upload and once per job; the platform service reads the row every call. Every write through
//      this class drops the cache, and so does the notification-policy cache, which is a second,
//      independent cache over the SAME row.
//   2. dismiss-on-disable for the deployment-wide `notifications.disabledTypes` (issue #489): when
//      an admin newly disables a type, every live row of it is dismissed app-wide.
//      PLATFORM-ADOPTION-SHIM(RETRO-D3): this used to run inside the settings write transaction.
//      The platform write has no transaction hook, so it now runs right after the commit; a failure
//      is logged, and the next save re-dismisses (the set is state, not a diff), so it self-heals.
//      Seam request: a write hook inside the settings transaction.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLATFORM_PRISMA } from '@marinoscar/platform-api/core';
import {
  SETTINGS_OPTIONS,
  SystemSettingsService,
  type PatchSystemSettingsDto,
  type ResolvedSettingsModuleOptions,
  type SystemSettingsResponse,
  type UpdateSystemSettingsDto,
} from '@marinoscar/platform-api/settings';

import { NotificationPolicyService } from '../../notifications/notification-policy.service';
import type { AppSystemSettings, AppSystemSettingsDocument } from '../../settings/app-settings.types';
import { NotificationsService } from '../../notifications/notifications.service';

/** TTL for the in-memory settings cache in milliseconds. */
export const SETTINGS_CACHE_TTL_MS = 5000;

type BasePrisma = ConstructorParameters<typeof SystemSettingsService>[0];

@Injectable()
export class AppSystemSettingsService extends SystemSettingsService {
  private readonly appLogger = new Logger(AppSystemSettingsService.name);
  private settingsCache: { value: AppSystemSettings; cachedAt: number } | null = null;

  constructor(
    @Inject(PLATFORM_PRISMA) prisma: BasePrisma,
    configService: ConfigService,
    @Optional() @Inject(SETTINGS_OPTIONS) options?: ResolvedSettingsModuleOptions,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly notificationPolicy?: NotificationPolicyService,
  ) {
    super(prisma, configService, options);
  }

  /**
   * Drop the cache. Public because a writer that bypasses this class (a raw SQL update of the
   * row) must be able to guarantee the next read is fresh.
   */
  invalidateSettingsCache(): void {
    this.settingsCache = null;
    this.notificationPolicy?.invalidate();
  }

  // TS2416 suppressed on purpose: the return type is the app's own `AppSystemSettings`, not the
  // platform's namespace-map type, for the reason given in settings/app-settings.types.ts.
  // @ts-ignore
  override async getSettings(): Promise<AppSystemSettings> {
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCache.cachedAt < SETTINGS_CACHE_TTL_MS) {
      return this.settingsCache.value;
    }
    const value = (await super.getSettings()) as unknown as AppSystemSettings;
    this.settingsCache = { value, cachedAt: Date.now() };
    return value;
  }

  /** The stored document, salvaged and complete, read only (never creates the row). */
  // @ts-ignore see getSettings
  override async readKnownValue(): Promise<AppSystemSettingsDocument> {
    return (await super.readKnownValue()) as unknown as AppSystemSettingsDocument;
  }

  /**
   * One value of the (cached) settings document by dot path, e.g. `jobs.history.retentionDays`.
   * PLATFORM-ADOPTION-SHIM(RETRO-C1): kept for the app's older call sites (~20); they move to the
   * typed `getNamespace('jobs')` as each namespace gets its slice, and this goes with the last one.
   */
  async getSettingValue<T>(path: string): Promise<T | undefined> {
    let value: unknown = await this.getSettings();
    for (const part of path.split('.')) {
      value = (value as Record<string, unknown> | undefined)?.[part];
      if (value === undefined) break;
    }
    return value as T | undefined;
  }

  /** Whether `features.<name>` is on. Same shim as {@link getSettingValue}. */
  async isFeatureEnabled(featureName: string): Promise<boolean> {
    const settings = await this.getSettings();
    return settings.features?.[featureName] ?? false;
  }

  override async replaceSettings(dto: UpdateSystemSettingsDto, userId: string): Promise<SystemSettingsResponse> {
    const before = await this.disabledTypesIfMentioned(dto);
    const result = await super.replaceSettings(dto, userId);
    await this.afterWrite(before, result);
    return result;
  }

  override async patchSettings(
    dto: PatchSystemSettingsDto,
    userId: string,
    expectedVersion?: number,
  ): Promise<SystemSettingsResponse> {
    const before = await this.disabledTypesIfMentioned(dto);
    const result = await super.patchSettings(dto, userId, expectedVersion);
    await this.afterWrite(before, result);
    return result;
  }

  /** The stored `disabledTypes`, read only when the body could change it. */
  private async disabledTypesIfMentioned(dto: unknown): Promise<string[] | null> {
    const mentioned = (dto as { notifications?: { disabledTypes?: unknown } } | undefined)?.notifications
      ?.disabledTypes;
    if (mentioned === undefined || !this.notifications) return null;
    const stored = (await this.readNamespaceValue('notifications')) as { disabledTypes?: string[] } | undefined;
    return [...(stored?.disabledTypes ?? [])];
  }

  private async afterWrite(before: string[] | null, result: SystemSettingsResponse): Promise<void> {
    const written = result as unknown as AppSystemSettings;
    this.invalidateSettingsCache();
    if (before === null || !this.notifications) return;

    const previous = new Set(before);
    const after: string[] = written.notifications?.disabledTypes ?? [];
    const newlyDisabled = [...new Set(after)].filter((t) => !previous.has(t));
    if (newlyDisabled.length === 0) return;

    try {
      // Mandatory types are filtered out by the service itself.
      const dismissed = await this.notifications.dismissTypesGlobally(newlyDisabled as never);
      this.notifications.invalidateAllUnreadCounts();
      this.appLogger.log(
        `Dismissed ${dismissed} live notification(s) of newly disabled type(s): ${newlyDisabled.join(', ')}`,
      );
    } catch (err) {
      this.appLogger.error(
        `Could not dismiss live notifications of newly disabled type(s) ${newlyDisabled.join(', ')}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
