/**
 * Settings Controller Tests
 *
 * Tests for settings HTTP endpoints.
 * Covers system settings, user preferences, and authorization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { SettingsController } from '../../../src/api/controllers/settings.controller.js';
import { ForbiddenError } from '../../../src/domain/errors/index.js';

// Mock settings services
const mockGetAllSystemSettings = vi.fn();
const mockGetByCategory = vi.fn();
const mockUpdateSystemSettings = vi.fn();
const mockGetFeatureFlags = vi.fn();
const mockGetUserPreferences = vi.fn();
const mockUpdateUserPreferences = vi.fn();
const mockResetUserPreferences = vi.fn();
const mockGetTheme = vi.fn();

vi.mock('../../../src/services/settings/index.js', () => ({
  systemSettingsService: {
    getAll: (...args: unknown[]) => mockGetAllSystemSettings(...args),
    getByCategory: (...args: unknown[]) => mockGetByCategory(...args),
    update: (...args: unknown[]) => mockUpdateSystemSettings(...args),
    getFeatureFlags: () => mockGetFeatureFlags(),
  },
  userPreferencesService: {
    getPreferences: (...args: unknown[]) => mockGetUserPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdateUserPreferences(...args),
    resetPreferences: (...args: unknown[]) => mockResetUserPreferences(...args),
    getTheme: (...args: unknown[]) => mockGetTheme(...args),
  },
}));

describe('SettingsController', () => {
  let controller: SettingsController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    controller = new SettingsController();

    mockReq = {
      params: {},
      body: {},
      user: { id: 'user-123', email: 'test@example.com' },
    };

    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();
  });

  describe('getAllSystemSettings', () => {
    it('returns all system settings for authenticated user', async () => {
      const mockSettings = [
        { category: 'smtp', settings: { enabled: true }, updatedAt: '2024-01-01', updatedBy: 'admin' },
        { category: 'features', settings: { aiSearch: true }, updatedAt: '2024-01-01', updatedBy: 'admin' },
      ];
      mockGetAllSystemSettings.mockResolvedValue(mockSettings);

      await controller.getAllSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetAllSystemSettings).toHaveBeenCalledWith(true); // masked=true
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockSettings });
    });

    it('throws ForbiddenError when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.getAllSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });
  });

  describe('getSystemSettingsByCategory', () => {
    it('returns settings for specific category', async () => {
      mockReq.params = { category: 'smtp' };
      const mockSettings = { enabled: true, host: 'smtp.example.com' };
      mockGetByCategory.mockResolvedValue(mockSettings);

      await controller.getSystemSettingsByCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetByCategory).toHaveBeenCalledWith('smtp', true);
      expect(mockRes.json).toHaveBeenCalledWith({
        data: { category: 'smtp', settings: mockSettings },
      });
    });

    it('throws ForbiddenError when not authenticated', async () => {
      mockReq.user = undefined;
      mockReq.params = { category: 'smtp' };

      await controller.getSystemSettingsByCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('handles different categories', async () => {
      mockReq.params = { category: 'features' };
      mockGetByCategory.mockResolvedValue({ aiSearch: true });

      await controller.getSystemSettingsByCategory(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetByCategory).toHaveBeenCalledWith('features', true);
    });
  });

  describe('updateSystemSettings', () => {
    it('updates settings for category', async () => {
      mockReq.params = { category: 'smtp' };
      mockReq.body = { settings: { enabled: false } };

      const mockUpdated = {
        category: 'smtp',
        settings: { enabled: false },
        updatedAt: '2024-01-01',
        updatedBy: 'user-123',
      };
      mockUpdateSystemSettings.mockResolvedValue(mockUpdated);

      await controller.updateSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      expect(mockUpdateSystemSettings).toHaveBeenCalledWith('smtp', { enabled: false }, 'user-123');
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockUpdated });
    });

    it('throws ForbiddenError when not authenticated', async () => {
      mockReq.user = undefined;
      mockReq.params = { category: 'smtp' };
      mockReq.body = { settings: { enabled: false } };

      await controller.updateSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('passes error to next on service failure', async () => {
      mockReq.params = { category: 'smtp' };
      mockReq.body = { settings: { port: 'invalid' } };

      mockUpdateSystemSettings.mockRejectedValue(new Error('Validation failed'));

      await controller.updateSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getFeatureFlags', () => {
    it('returns feature flags without authentication', async () => {
      mockReq.user = undefined;
      const mockFlags = { aiSearch: true, sharing: true, publicLinks: false };
      mockGetFeatureFlags.mockResolvedValue(mockFlags);

      await controller.getFeatureFlags(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetFeatureFlags).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockFlags });
    });

    it('returns feature flags with authentication', async () => {
      const mockFlags = { aiSearch: true, sharing: false };
      mockGetFeatureFlags.mockResolvedValue(mockFlags);

      await controller.getFeatureFlags(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({ data: mockFlags });
    });
  });

  describe('getUserPreferences', () => {
    it('returns current user preferences', async () => {
      const mockPrefs = {
        userId: 'user-123',
        preferences: { ui: { theme: 'dark' } },
        updatedAt: '2024-01-01',
      };
      mockGetUserPreferences.mockResolvedValue(mockPrefs);

      await controller.getUserPreferences(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetUserPreferences).toHaveBeenCalledWith('user-123');
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockPrefs });
    });

    it('passes error to next on service failure', async () => {
      mockGetUserPreferences.mockRejectedValue(new Error('Database error'));

      await controller.getUserPreferences(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('updateUserPreferences', () => {
    it('updates current user preferences', async () => {
      mockReq.body = { ui: { theme: 'light' } };

      const mockUpdated = {
        userId: 'user-123',
        preferences: { ui: { theme: 'light' } },
        updatedAt: '2024-01-02',
      };
      mockUpdateUserPreferences.mockResolvedValue(mockUpdated);

      await controller.updateUserPreferences(mockReq as Request, mockRes as Response, mockNext);

      expect(mockUpdateUserPreferences).toHaveBeenCalledWith('user-123', { ui: { theme: 'light' } });
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockUpdated });
    });

    it('passes validation error to next', async () => {
      mockReq.body = { ui: { theme: 'invalid' } };

      mockUpdateUserPreferences.mockRejectedValue(new Error('Invalid theme'));

      await controller.updateUserPreferences(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('resetUserPreferences', () => {
    it('resets current user preferences to defaults', async () => {
      const mockReset = {
        userId: 'user-123',
        preferences: { ui: { theme: 'dark' } },
        updatedAt: '2024-01-02',
      };
      mockResetUserPreferences.mockResolvedValue(mockReset);

      await controller.resetUserPreferences(mockReq as Request, mockRes as Response, mockNext);

      expect(mockResetUserPreferences).toHaveBeenCalledWith('user-123');
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockReset });
    });
  });

  describe('getTheme', () => {
    it('returns user theme preference', async () => {
      mockGetTheme.mockResolvedValue('dark');

      await controller.getTheme(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetTheme).toHaveBeenCalledWith('user-123');
      expect(mockRes.json).toHaveBeenCalledWith({ data: { theme: 'dark' } });
    });

    it('returns light theme', async () => {
      mockGetTheme.mockResolvedValue('light');

      await controller.getTheme(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({ data: { theme: 'light' } });
    });
  });

  describe('requireAdmin (private method)', () => {
    it('allows authenticated users (current implementation)', async () => {
      mockGetAllSystemSettings.mockResolvedValue([]);

      await controller.getAllSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      // Should not throw - current implementation allows any authenticated user
      expect(mockGetAllSystemSettings).toHaveBeenCalled();
    });

    it('blocks unauthenticated users', async () => {
      mockReq.user = undefined;

      await controller.getAllSystemSettings(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ForbiddenError));
      expect(mockGetAllSystemSettings).not.toHaveBeenCalled();
    });
  });
});
