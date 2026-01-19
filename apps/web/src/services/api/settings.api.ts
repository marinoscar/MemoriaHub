/**
 * Settings API Service
 *
 * API calls for system settings and user preferences.
 */

import type {
  ApiResponse,
  SystemSettingsDTO,
  UserPreferencesDTO,
  FeatureSettings,
  SystemSettingsCategory,
} from '@memoriahub/shared';
import { apiClient } from './client';

/**
 * Settings API methods
 */
export const settingsApi = {
  // ===========================================================================
  // System Settings
  // ===========================================================================

  /**
   * Get all system settings (admin only)
   */
  async getAllSystemSettings(): Promise<SystemSettingsDTO[]> {
    const response = await apiClient.get<ApiResponse<SystemSettingsDTO[]>>('/settings/system');
    return response.data.data;
  },

  /**
   * Get system settings by category (admin only)
   */
  async getSystemSettings<T = Record<string, unknown>>(
    category: SystemSettingsCategory
  ): Promise<{ category: string; settings: T }> {
    const response = await apiClient.get<ApiResponse<{ category: string; settings: T }>>(
      `/settings/system/${category}`
    );
    return response.data.data;
  },

  /**
   * Update system settings (admin only)
   */
  async updateSystemSettings<T = Record<string, unknown>>(
    category: SystemSettingsCategory,
    settings: Partial<T>
  ): Promise<SystemSettingsDTO> {
    const response = await apiClient.patch<ApiResponse<SystemSettingsDTO>>(
      `/settings/system/${category}`,
      { settings }
    );
    return response.data.data;
  },

  /**
   * Get feature flags (public)
   */
  async getFeatureFlags(): Promise<FeatureSettings> {
    const response = await apiClient.get<ApiResponse<FeatureSettings>>('/settings/features');
    return response.data.data;
  },

  // ===========================================================================
  // User Preferences
  // ===========================================================================

  /**
   * Get current user's preferences
   */
  async getPreferences(): Promise<UserPreferencesDTO> {
    const response = await apiClient.get<ApiResponse<UserPreferencesDTO>>('/settings/preferences');
    return response.data.data;
  },

  /**
   * Update current user's preferences
   */
  async updatePreferences(
    preferences: Record<string, unknown>
  ): Promise<UserPreferencesDTO> {
    const response = await apiClient.patch<ApiResponse<UserPreferencesDTO>>(
      '/settings/preferences',
      preferences
    );
    return response.data.data;
  },

  /**
   * Reset preferences to defaults
   */
  async resetPreferences(): Promise<UserPreferencesDTO> {
    const response = await apiClient.post<ApiResponse<UserPreferencesDTO>>(
      '/settings/preferences/reset'
    );
    return response.data.data;
  },

  /**
   * Get just the theme (optimized for initial load)
   */
  async getTheme(): Promise<{ theme: string }> {
    const response = await apiClient.get<ApiResponse<{ theme: string }>>(
      '/settings/preferences/theme'
    );
    return response.data.data;
  },
};
