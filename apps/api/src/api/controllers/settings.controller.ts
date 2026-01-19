/**
 * Settings Controller
 *
 * Handles HTTP requests for system settings and user preferences.
 * System settings require admin privileges.
 * User preferences are per-user and can only be accessed by the owning user.
 */

import type { Request, Response, NextFunction } from 'express';
import type {
  ApiResponse,
  SystemSettingsCategory,
  SystemSettingsDTO,
  UserPreferencesDTO,
} from '@memoriahub/shared';
import { systemSettingsService, userPreferencesService } from '../../services/settings/index.js';

/**
 * Settings controller
 */
export class SettingsController {
  // ===========================================================================
  // System Settings (Admin only)
  // ===========================================================================

  /**
   * GET /api/settings/system
   * Get all system settings
   */
  async getAllSystemSettings(
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Admin check is handled by adminMiddleware in routes
      const settings = await systemSettingsService.getAll(true); // Masked for API

      const response: ApiResponse<SystemSettingsDTO[]> = { data: settings };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/settings/system/:category
   * Get settings for a specific category
   */
  async getSystemSettingsByCategory(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Admin check is handled by adminMiddleware in routes
      const category = req.params.category as SystemSettingsCategory;
      const settings = await systemSettingsService.getByCategory(category, true);

      const response: ApiResponse<{ category: string; settings: unknown }> = {
        data: { category, settings },
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/settings/system/:category
   * Update settings for a specific category
   */
  async updateSystemSettings(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Admin check is handled by adminMiddleware in routes
      const category = req.params.category as SystemSettingsCategory;
      const settings = req.body.settings as Record<string, unknown>;
      const userId = req.user!.id;

      const updated = await systemSettingsService.update(category, settings, userId);

      const response: ApiResponse<SystemSettingsDTO> = { data: updated };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/settings/features
   * Get feature flags (public endpoint, no admin required)
   */
  async getFeatureFlags(
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const features = await systemSettingsService.getFeatureFlags();

      const response: ApiResponse<typeof features> = { data: features };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  // ===========================================================================
  // User Preferences
  // ===========================================================================

  /**
   * GET /api/settings/preferences
   * Get current user's preferences
   */
  async getUserPreferences(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const preferences = await userPreferencesService.getPreferences(userId);

      const response: ApiResponse<UserPreferencesDTO> = { data: preferences };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/settings/preferences
   * Update current user's preferences
   */
  async updateUserPreferences(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const input = req.body as Record<string, unknown>;

      const updated = await userPreferencesService.updatePreferences(userId, input);

      const response: ApiResponse<UserPreferencesDTO> = { data: updated };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/settings/preferences/reset
   * Reset current user's preferences to defaults
   */
  async resetUserPreferences(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;

      const reset = await userPreferencesService.resetPreferences(userId);

      const response: ApiResponse<UserPreferencesDTO> = { data: reset };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/settings/preferences/theme
   * Get just the theme preference (for initial load optimization)
   */
  async getTheme(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const theme = await userPreferencesService.getTheme(userId);

      const response: ApiResponse<{ theme: string }> = { data: { theme } };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

}

// Export singleton instance
export const settingsController = new SettingsController();
