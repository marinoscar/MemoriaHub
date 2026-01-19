/**
 * System Settings Service
 *
 * Business logic for managing system-wide configuration.
 * Handles caching, encryption, validation, and audit logging.
 */

import type {
  SystemSettingsCategory,
  SystemSettingsDTO,
  SmtpSettings,
  PushSettings,
  FeatureSettings,
  GeneralSettings,
} from '@memoriahub/shared';
import {
  SENSITIVE_SETTINGS_FIELDS,
  MASKED_SETTINGS_FIELDS,
  systemSettingsSchemaByCatgory,
  DEFAULT_SMTP_SETTINGS,
  DEFAULT_PUSH_SETTINGS,
  DEFAULT_FEATURE_SETTINGS,
  DEFAULT_GENERAL_SETTINGS,
} from '@memoriahub/shared';
import type { ISystemSettingsRepository } from '../../interfaces/index.js';
import { settingsCache, CacheKeys, CacheTTL } from '../../infrastructure/cache/settings-cache.js';
import {
  encryptSettingsFields,
  decryptSettingsFields,
  maskSettingsFields,
} from '../../infrastructure/crypto/settings-crypto.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ValidationError } from '../../domain/errors/ValidationError.js';

/**
 * Default settings by category
 */
const DEFAULT_SETTINGS: Record<SystemSettingsCategory, Record<string, unknown>> = {
  smtp: DEFAULT_SMTP_SETTINGS,
  push: DEFAULT_PUSH_SETTINGS,
  storage: { defaultBackend: 's3' },
  features: DEFAULT_FEATURE_SETTINGS,
  general: DEFAULT_GENERAL_SETTINGS,
};

/**
 * System settings service
 */
export class SystemSettingsService {
  constructor(private readonly repository: ISystemSettingsRepository) {}

  /**
   * Get settings for a specific category
   * Uses caching for performance
   *
   * @param category Settings category
   * @param masked Whether to mask sensitive fields (for API responses)
   */
  async getByCategory<T extends Record<string, unknown>>(
    category: SystemSettingsCategory,
    masked = false
  ): Promise<T> {
    const cacheKey = CacheKeys.systemSettings(category);

    // Check cache first
    const cached = settingsCache.get<T>(cacheKey);
    if (cached) {
      return masked
        ? maskSettingsFields(cached, MASKED_SETTINGS_FIELDS[category])
        : cached;
    }

    // Fetch from database
    const row = await this.repository.findByCategory(category);

    // Use defaults if not found
    let settings = (row?.settings ?? DEFAULT_SETTINGS[category]) as T;

    // Decrypt sensitive fields
    const sensitiveFields = SENSITIVE_SETTINGS_FIELDS[category];
    if (sensitiveFields.length > 0) {
      settings = decryptSettingsFields(settings, sensitiveFields);
    }

    // Cache the decrypted settings
    settingsCache.set(cacheKey, settings, CacheTTL.systemSettings);

    // Return masked version for API responses
    return masked
      ? maskSettingsFields(settings, MASKED_SETTINGS_FIELDS[category])
      : settings;
  }

  /**
   * Get all system settings
   *
   * @param masked Whether to mask sensitive fields
   */
  async getAll(masked = false): Promise<SystemSettingsDTO[]> {
    const allSettings = await this.repository.findAll();

    // Create a map of existing settings
    const settingsMap = new Map(
      allSettings.map((s) => [s.category, s])
    );

    // Build response with all categories (using defaults for missing ones)
    const categories: SystemSettingsCategory[] = ['smtp', 'push', 'storage', 'features', 'general'];
    const result: SystemSettingsDTO[] = [];

    for (const category of categories) {
      const row = settingsMap.get(category);
      let settings = (row?.settings ?? DEFAULT_SETTINGS[category]) as Record<string, unknown>;

      // Decrypt sensitive fields
      const sensitiveFields = SENSITIVE_SETTINGS_FIELDS[category];
      if (sensitiveFields.length > 0) {
        settings = decryptSettingsFields(settings, sensitiveFields);
      }

      // Mask if requested
      if (masked) {
        settings = maskSettingsFields(settings, MASKED_SETTINGS_FIELDS[category]);
      }

      result.push({
        category,
        settings,
        updatedAt: row?.updatedAt.toISOString() ?? new Date().toISOString(),
        updatedBy: row?.updatedBy ?? null,
      });
    }

    return result;
  }

  /**
   * Update settings for a category
   * Validates input, encrypts sensitive fields, and invalidates cache
   *
   * @param category Settings category
   * @param settings New settings (partial update)
   * @param updatedBy User ID making the update
   */
  async update<T extends Record<string, unknown>>(
    category: SystemSettingsCategory,
    settings: Partial<T>,
    updatedBy: string
  ): Promise<SystemSettingsDTO> {
    // Validate settings against schema
    const schema = systemSettingsSchemaByCatgory[category];
    const parseResult = schema.safeParse(settings);

    if (!parseResult.success) {
      throw ValidationError.fromZodError(parseResult.error);
    }

    // Get current settings to merge
    const current = await this.getByCategory<T>(category, false);
    const merged = { ...current, ...settings };

    // Encrypt sensitive fields before storing
    const sensitiveFields = SENSITIVE_SETTINGS_FIELDS[category];
    const encrypted = sensitiveFields.length > 0
      ? encryptSettingsFields(merged, sensitiveFields)
      : merged;

    // Save to database
    const row = await this.repository.patchSettings(category, {
      settings: encrypted,
      updatedBy,
    });

    // Invalidate cache
    settingsCache.invalidate(CacheKeys.systemSettings(category));
    settingsCache.invalidate(CacheKeys.allSystemSettings());

    logger.info(
      {
        eventType: 'settings.system.updated',
        category,
        updatedBy,
        changedFields: Object.keys(settings),
      },
      `System settings updated: ${category}`
    );

    // Return masked version
    const decrypted = decryptSettingsFields(row.settings as T, sensitiveFields);
    const maskedSettings = maskSettingsFields(decrypted, MASKED_SETTINGS_FIELDS[category]);

    return {
      category: row.category,
      settings: maskedSettings,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  // ==========================================================================
  // Typed Getters for Common Settings
  // ==========================================================================

  /**
   * Get SMTP settings (decrypted, for internal use)
   */
  async getSmtpSettings(): Promise<SmtpSettings> {
    return this.getByCategory<SmtpSettings>('smtp', false);
  }

  /**
   * Get push notification settings (decrypted, for internal use)
   */
  async getPushSettings(): Promise<PushSettings> {
    return this.getByCategory<PushSettings>('push', false);
  }

  /**
   * Get feature flags
   */
  async getFeatureFlags(): Promise<FeatureSettings> {
    const cacheKey = CacheKeys.featureFlags();

    // Feature flags are checked frequently, use dedicated cache
    const cached = settingsCache.get<FeatureSettings>(cacheKey);
    if (cached) {
      return cached;
    }

    const settings = await this.getByCategory<FeatureSettings>('features', false);

    // Cache with shorter TTL for feature flags
    settingsCache.set(cacheKey, settings, CacheTTL.featureFlags);

    return settings;
  }

  /**
   * Get general settings
   */
  async getGeneralSettings(): Promise<GeneralSettings> {
    return this.getByCategory<GeneralSettings>('general', false);
  }

  /**
   * Check if a specific feature is enabled
   */
  async isFeatureEnabled(feature: keyof FeatureSettings): Promise<boolean> {
    const flags = await this.getFeatureFlags();
    return flags[feature] ?? false;
  }

  /**
   * Check if SMTP is configured and enabled
   */
  async isSmtpEnabled(): Promise<boolean> {
    const smtp = await this.getSmtpSettings();
    return smtp.enabled && !!smtp.host && !!smtp.fromAddress;
  }

  /**
   * Check if push notifications are configured and enabled
   */
  async isPushEnabled(): Promise<boolean> {
    const push = await this.getPushSettings();
    return push.enabled && !!push.provider;
  }
}
