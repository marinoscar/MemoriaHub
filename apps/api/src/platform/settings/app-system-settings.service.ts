// =============================================================================
// The platform SystemSettingsService, with MemoriaHub's three write/read behaviours (RETRO-B3)
// =============================================================================
//
// `settings.config.ts` binds this class to the platform's `SystemSettingsService` token, so every
// injection (the platform controllers and slices, and every app service) gets it. It adds exactly:
//
//   1. a 5 s in-process cache on `getSettings()`. Bulk imports read the feature flags once per
//      upload and once per job; the platform service reads the row every call. Every write through
//      this class drops the cache.
//   2. the typed `getSettings()` / `readKnownValue()` and the older `getSettingValue` /
//      `isFeatureEnabled` read helpers.
//
// Dismiss-on-disable for `notifications.disabledEvents` is no longer here: since RETRO-D3 (#576)
// the platform `notifications` namespace's `onWrite` hook does it inside the settings transaction.
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
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

import type { AppSystemSettings, AppSystemSettingsDocument } from '../../settings/app-settings.types';

/** TTL for the in-memory settings cache in milliseconds. */
export const SETTINGS_CACHE_TTL_MS = 5000;

type BasePrisma = ConstructorParameters<typeof SystemSettingsService>[0];

@Injectable()
export class AppSystemSettingsService extends SystemSettingsService {
  private settingsCache: { value: AppSystemSettings; cachedAt: number } | null = null;

  constructor(
    @Inject(PLATFORM_PRISMA) prisma: BasePrisma,
    configService: ConfigService,
    @Optional() @Inject(SETTINGS_OPTIONS) options?: ResolvedSettingsModuleOptions,
  ) {
    super(prisma, configService, options);
  }

  /**
   * Drop the cache. Public because a writer that bypasses this class (a raw SQL update of the
   * row) must be able to guarantee the next read is fresh.
   */
  invalidateSettingsCache(): void {
    this.settingsCache = null;
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
   * PLATFORM-ADOPTION-SHIM(RETRO-E1): kept for the app's older call sites (~20); they move to the
   * typed `getNamespace(...)` as each remaining namespace (`ai` E1, `storage` D1) gets its slice, and
   * this goes with the last one. RETRO-D3 (#576) swapped `notifications` and did not need it.
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

  // Dismiss-on-disable (`notifications.disabledEvents`) is the platform
  // namespace's `onWrite` hook since RETRO-D3: it runs INSIDE the settings
  // transaction, so these overrides only drop the cache.
  override async replaceSettings(dto: UpdateSystemSettingsDto, userId: string): Promise<SystemSettingsResponse> {
    const result = await super.replaceSettings(dto, userId);
    this.invalidateSettingsCache();
    return result;
  }

  override async patchSettings(
    dto: PatchSystemSettingsDto,
    userId: string,
    expectedVersion?: number,
  ): Promise<SystemSettingsResponse> {
    const result = await super.patchSettings(dto, userId, expectedVersion);
    this.invalidateSettingsCache();
    return result;
  }
}
