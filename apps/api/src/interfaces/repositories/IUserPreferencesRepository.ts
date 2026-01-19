import type { UserPreferences, UserPreferencesRow } from '@memoriahub/shared';

/**
 * User preferences update input
 */
export interface UpdateUserPreferencesInput {
  preferences: Partial<UserPreferences>;
}

/**
 * User preferences repository interface (Dependency Inversion)
 * Data access abstraction for per-user settings
 */
export interface IUserPreferencesRepository {
  /**
   * Get preferences by user ID
   * @param userId User UUID
   * @returns User preferences row or null if not found
   */
  findByUserId(userId: string): Promise<UserPreferencesRow | null>;

  /**
   * Get or create preferences with defaults
   * @param userId User UUID
   * @returns User preferences (existing or newly created with defaults)
   */
  getOrCreate(userId: string): Promise<UserPreferencesRow>;

  /**
   * Update user preferences (partial update, deep merge)
   * @param userId User UUID
   * @param input Partial preferences to merge
   * @returns Updated preferences row
   */
  update(userId: string, input: UpdateUserPreferencesInput): Promise<UserPreferencesRow>;

  /**
   * Delete user preferences
   * @param userId User UUID
   * @returns True if deleted, false if not found
   */
  delete(userId: string): Promise<boolean>;
}
