/**
 * Settings Routes
 *
 * Routes for managing system settings and user preferences.
 *
 * System Settings (Admin):
 *   GET    /api/settings/system              - Get all system settings
 *   GET    /api/settings/system/:category    - Get settings by category
 *   PATCH  /api/settings/system/:category    - Update settings by category
 *
 * Feature Flags (Public):
 *   GET    /api/settings/features            - Get feature flags
 *
 * User Preferences (Authenticated):
 *   GET    /api/settings/preferences         - Get current user's preferences
 *   PATCH  /api/settings/preferences         - Update preferences
 *   POST   /api/settings/preferences/reset   - Reset to defaults
 *   GET    /api/settings/preferences/theme   - Get just theme (for quick load)
 */

import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller.js';
import { authMiddleware, optionalAuthMiddleware, adminMiddleware } from '../middleware/auth.middleware.js';
import {
  validateSystemSettingsCategory,
  validateSystemSettingsUpdate,
  validateUserPreferencesUpdate,
} from '../validators/settings.validator.js';
import { asyncHandler } from '../utils/async-handler.js';

export function createSettingsRoutes(): Router {
  const router = Router();

  // ===========================================================================
  // Feature Flags (Public - optional auth for personalization)
  // ===========================================================================

  router.get('/features', optionalAuthMiddleware, asyncHandler((req, res, next) =>
    settingsController.getFeatureFlags(req, res, next)
  ));

  // ===========================================================================
  // System Settings (Admin required)
  // ===========================================================================

  // Get all system settings
  router.get('/system', authMiddleware, adminMiddleware, asyncHandler((req, res, next) =>
    settingsController.getAllSystemSettings(req, res, next)
  ));

  // Get system settings by category
  router.get(
    '/system/:category',
    authMiddleware,
    adminMiddleware,
    validateSystemSettingsCategory,
    asyncHandler((req, res, next) => settingsController.getSystemSettingsByCategory(req, res, next))
  );

  // Update system settings by category
  router.patch(
    '/system/:category',
    authMiddleware,
    adminMiddleware,
    validateSystemSettingsCategory,
    validateSystemSettingsUpdate,
    asyncHandler((req, res, next) => settingsController.updateSystemSettings(req, res, next))
  );

  // ===========================================================================
  // User Preferences (Authenticated)
  // ===========================================================================

  // Get current user's preferences
  router.get('/preferences', authMiddleware, asyncHandler((req, res, next) =>
    settingsController.getUserPreferences(req, res, next)
  ));

  // Update current user's preferences
  router.patch(
    '/preferences',
    authMiddleware,
    validateUserPreferencesUpdate,
    asyncHandler((req, res, next) => settingsController.updateUserPreferences(req, res, next))
  );

  // Reset preferences to defaults
  router.post('/preferences/reset', authMiddleware, asyncHandler((req, res, next) =>
    settingsController.resetUserPreferences(req, res, next)
  ));

  // Get just theme (optimized for initial load)
  router.get('/preferences/theme', authMiddleware, asyncHandler((req, res, next) =>
    settingsController.getTheme(req, res, next)
  ));

  return router;
}
