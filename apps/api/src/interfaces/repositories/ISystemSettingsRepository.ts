import type { SystemSettingsCategory, SystemSettingsRow } from '@memoriahub/shared';

/**
 * System settings update input
 */
export interface UpdateSystemSettingsInput {
  settings: Record<string, unknown>;
  updatedBy: string;
}

/**
 * System settings repository interface (Dependency Inversion)
 * Data access abstraction for system-wide configuration
 */
export interface ISystemSettingsRepository {
  /**
   * Get settings by category
   * @param category Settings category (smtp, push, features, etc.)
   * @returns Settings row or null if not found
   */
  findByCategory(category: SystemSettingsCategory): Promise<SystemSettingsRow | null>;

  /**
   * Get all system settings
   * @returns Array of all settings rows
   */
  findAll(): Promise<SystemSettingsRow[]>;

  /**
   * Update settings for a category (upsert)
   * @param category Settings category
   * @param input Update input
   * @returns Updated settings row
   */
  upsert(category: SystemSettingsCategory, input: UpdateSystemSettingsInput): Promise<SystemSettingsRow>;

  /**
   * Partially update settings (merge with existing)
   * @param category Settings category
   * @param input Partial settings to merge
   * @returns Updated settings row
   */
  patchSettings(category: SystemSettingsCategory, input: UpdateSystemSettingsInput): Promise<SystemSettingsRow>;
}
