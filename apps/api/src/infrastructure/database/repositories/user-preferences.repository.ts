import type { UserPreferences, UserPreferencesRow } from '@memoriahub/shared';
import { DEFAULT_USER_PREFERENCES } from '@memoriahub/shared';
import type {
  IUserPreferencesRepository,
  UpdateUserPreferencesInput,
} from '../../../interfaces/index.js';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';

/**
 * Database row type for user_settings table (with preferences JSONB column)
 */
interface UserPreferencesDbRow {
  user_id: string;
  preferences: UserPreferences;
  created_at: Date;
  updated_at: Date;
}

/**
 * Convert database row to domain entity
 */
function rowToUserPreferences(row: UserPreferencesDbRow): UserPreferencesRow {
  return {
    userId: row.user_id,
    preferences: row.preferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Deep merge two objects
 * Arrays are replaced, not merged
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== undefined &&
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        !Array.isArray(sourceValue) &&
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        // Recursively merge objects
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        ) as T[Extract<keyof T, string>];
      } else if (sourceValue !== undefined) {
        // Replace value
        result[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

/**
 * PostgreSQL implementation of user preferences repository
 */
export class UserPreferencesRepository implements IUserPreferencesRepository {
  async findByUserId(userId: string): Promise<UserPreferencesRow | null> {
    const result = await query<UserPreferencesDbRow>(
      'SELECT user_id, preferences, created_at, updated_at FROM user_settings WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToUserPreferences(result.rows[0]);
  }

  async getOrCreate(userId: string): Promise<UserPreferencesRow> {
    // Try to get existing preferences
    const existing = await this.findByUserId(userId);
    if (existing) {
      return existing;
    }

    // Create with defaults
    const result = await query<UserPreferencesDbRow>(
      `INSERT INTO user_settings (user_id, preferences)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET user_id = user_settings.user_id
       RETURNING user_id, preferences, created_at, updated_at`,
      [userId, JSON.stringify(DEFAULT_USER_PREFERENCES)]
    );

    const preferences = rowToUserPreferences(result.rows[0]);

    logger.info(
      {
        eventType: 'settings.user.created',
        userId,
      },
      'User preferences created with defaults'
    );

    return preferences;
  }

  async update(
    userId: string,
    input: UpdateUserPreferencesInput
  ): Promise<UserPreferencesRow> {
    // Get current preferences or defaults
    const current = await this.getOrCreate(userId);

    // Deep merge the input with current preferences
    const merged = deepMerge(current.preferences, input.preferences as Partial<UserPreferences>);

    // Update in database
    const result = await query<UserPreferencesDbRow>(
      `UPDATE user_settings
       SET preferences = $2, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, preferences, created_at, updated_at`,
      [userId, JSON.stringify(merged)]
    );

    if (result.rows.length === 0) {
      // Should not happen since we called getOrCreate, but handle defensively
      throw new Error(`User preferences not found for user ${userId}`);
    }

    const preferences = rowToUserPreferences(result.rows[0]);

    logger.info(
      {
        eventType: 'settings.user.updated',
        userId,
        changedCategories: Object.keys(input.preferences),
      },
      'User preferences updated'
    );

    return preferences;
  }

  async delete(userId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM user_settings WHERE user_id = $1',
      [userId]
    );

    if (result.rowCount && result.rowCount > 0) {
      logger.info(
        {
          eventType: 'settings.user.deleted',
          userId,
        },
        'User preferences deleted'
      );
      return true;
    }

    return false;
  }
}

// Export singleton instance
export const userPreferencesRepository = new UserPreferencesRepository();
