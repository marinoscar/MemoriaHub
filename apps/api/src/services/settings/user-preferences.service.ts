/**
 * User Preferences Service
 *
 * Business logic for managing per-user settings.
 * Handles caching, validation, and authorization.
 */

import type {
  UserPreferences,
  UserPreferencesDTO,
} from '@memoriahub/shared';
import {
  DEFAULT_USER_PREFERENCES,
  userPreferencesInputSchema,
} from '@memoriahub/shared';
import type { IUserPreferencesRepository } from '../../interfaces/index.js';
import { settingsCache, CacheKeys, CachePatterns, CacheTTL } from '../../infrastructure/cache/settings-cache.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ValidationError } from '../../domain/errors/ValidationError.js';
import { NotFoundError } from '../../domain/errors/NotFoundError.js';

/**
 * User preferences service
 */
export class UserPreferencesService {
  constructor(private readonly repository: IUserPreferencesRepository) {}

  /**
   * Get preferences for a user
   * Uses caching for performance
   *
   * @param userId User ID
   * @returns User preferences DTO
   */
  async getPreferences(userId: string): Promise<UserPreferencesDTO> {
    const cacheKey = CacheKeys.userPreferences(userId);

    // Check cache first
    const cached = settingsCache.get<UserPreferences>(cacheKey);
    if (cached) {
      return {
        userId,
        preferences: cached,
        updatedAt: new Date().toISOString(), // We don't cache updatedAt
      };
    }

    // Fetch from database (creates with defaults if not found)
    const row = await this.repository.getOrCreate(userId);

    // Ensure all default fields are present (for backwards compatibility)
    const preferences = this.mergeWithDefaults(row.preferences);

    // Cache the preferences
    settingsCache.set(cacheKey, preferences, CacheTTL.userPreferences);

    return {
      userId: row.userId,
      preferences,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Update user preferences (partial update)
   *
   * @param userId User ID
   * @param input Partial preferences to update
   * @returns Updated preferences DTO
   */
  async updatePreferences(
    userId: string,
    input: Partial<UserPreferences>
  ): Promise<UserPreferencesDTO> {
    // Validate input
    const parseResult = userPreferencesInputSchema.safeParse(input);
    if (!parseResult.success) {
      throw ValidationError.fromZodError(parseResult.error);
    }

    // Update in database (handles deep merge)
    const row = await this.repository.update(userId, {
      preferences: input,
    });

    // Invalidate cache
    settingsCache.invalidate(CacheKeys.userPreferences(userId));

    logger.info(
      {
        eventType: 'settings.user.updated',
        userId,
        changedCategories: Object.keys(input),
      },
      'User preferences updated'
    );

    return {
      userId: row.userId,
      preferences: this.mergeWithDefaults(row.preferences),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Reset user preferences to defaults
   *
   * @param userId User ID
   * @returns Default preferences DTO
   */
  async resetPreferences(userId: string): Promise<UserPreferencesDTO> {
    // Delete existing preferences
    await this.repository.delete(userId);

    // Invalidate cache
    settingsCache.invalidate(CacheKeys.userPreferences(userId));

    // Re-fetch (will create with defaults)
    const row = await this.repository.getOrCreate(userId);

    logger.info(
      {
        eventType: 'settings.user.reset',
        userId,
      },
      'User preferences reset to defaults'
    );

    return {
      userId: row.userId,
      preferences: row.preferences,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ==========================================================================
  // Specific Preference Getters
  // ==========================================================================

  /**
   * Get user's theme preference
   */
  async getTheme(userId: string): Promise<'dark' | 'light' | 'system'> {
    const prefs = await this.getPreferences(userId);
    return prefs.preferences.ui.theme;
  }

  /**
   * Get user's language preference
   */
  async getLanguage(userId: string): Promise<string> {
    const prefs = await this.getPreferences(userId);
    return prefs.preferences.ui.language;
  }

  /**
   * Check if email notifications are enabled for a user
   */
  async isEmailNotificationsEnabled(userId: string): Promise<boolean> {
    const prefs = await this.getPreferences(userId);
    return prefs.preferences.notifications.email.enabled;
  }

  /**
   * Check if push notifications are enabled for a user
   */
  async isPushNotificationsEnabled(userId: string): Promise<boolean> {
    const prefs = await this.getPreferences(userId);
    return prefs.preferences.notifications.push.enabled;
  }

  /**
   * Get notification preferences for determining what notifications to send
   */
  async getNotificationPreferences(userId: string): Promise<UserPreferences['notifications']> {
    const prefs = await this.getPreferences(userId);
    return prefs.preferences.notifications;
  }

  // ==========================================================================
  // Bulk Operations
  // ==========================================================================

  /**
   * Invalidate preferences cache for a user
   * Useful when user is deleted or preferences are updated externally
   */
  invalidateUserCache(userId: string): void {
    settingsCache.invalidatePattern(CachePatterns.userSpecific(userId));
  }

  /**
   * Invalidate all user preferences cache
   * Useful after schema migrations or bulk updates
   */
  invalidateAllUserCache(): void {
    settingsCache.invalidatePattern(CachePatterns.allUserPreferences);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Merge user preferences with defaults to ensure all fields are present
   * This handles backwards compatibility when new preference fields are added
   */
  private mergeWithDefaults(preferences: UserPreferences): UserPreferences {
    return {
      notifications: {
        email: {
          ...DEFAULT_USER_PREFERENCES.notifications.email,
          ...preferences.notifications?.email,
        },
        push: {
          ...DEFAULT_USER_PREFERENCES.notifications.push,
          ...preferences.notifications?.push,
        },
      },
      ui: {
        ...DEFAULT_USER_PREFERENCES.ui,
        ...preferences.ui,
      },
      privacy: {
        ...DEFAULT_USER_PREFERENCES.privacy,
        ...preferences.privacy,
      },
    };
  }
}
