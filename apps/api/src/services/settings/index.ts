/**
 * Settings Services
 *
 * Exports configured service instances with injected repositories.
 */

import { SystemSettingsService } from './system-settings.service.js';
import { UserPreferencesService } from './user-preferences.service.js';
import { systemSettingsRepository } from '../../infrastructure/database/repositories/system-settings.repository.js';
import { userPreferencesRepository } from '../../infrastructure/database/repositories/user-preferences.repository.js';

// Export service classes for testing with mocked dependencies
export { SystemSettingsService } from './system-settings.service.js';
export { UserPreferencesService } from './user-preferences.service.js';

// Export configured singleton instances
export const systemSettingsService = new SystemSettingsService(systemSettingsRepository);
export const userPreferencesService = new UserPreferencesService(userPreferencesRepository);
