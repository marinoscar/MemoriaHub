/**
 * User Preferences Service Tests
 *
 * Tests for per-user settings management.
 * Covers caching, validation, defaults, and authorization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserPreferencesService } from '../../../../src/services/settings/user-preferences.service.js';
import type { IUserPreferencesRepository } from '../../../../src/interfaces/index.js';
import { ValidationError } from '../../../../src/domain/errors/index.js';

// Mock settings cache
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockCacheInvalidate = vi.fn();
const mockCacheInvalidatePattern = vi.fn();

vi.mock('../../../../src/infrastructure/cache/settings-cache.js', () => ({
  settingsCache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
    invalidate: (...args: unknown[]) => mockCacheInvalidate(...args),
    invalidatePattern: (...args: unknown[]) => mockCacheInvalidatePattern(...args),
  },
  CacheKeys: {
    userPreferences: (userId: string) => `user:${userId}:preferences`,
  },
  CachePatterns: {
    userSpecific: (userId: string) => `user:${userId}:*`,
    allUserPreferences: 'user:*:preferences',
  },
  CacheTTL: {
    userPreferences: 300000,
  },
}));

// Mock logger
vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('UserPreferencesService', () => {
  let service: UserPreferencesService;
  let mockRepository: IUserPreferencesRepository;

  const mockPreferencesRow = {
    userId: 'user-123',
    preferences: {
      notifications: {
        email: {
          enabled: true,
          digest: 'daily' as const,
          newShares: true,
          comments: true,
          albumUpdates: true,
          systemAlerts: true,
        },
        push: {
          enabled: true,
          newShares: true,
          comments: false,
          albumUpdates: true,
        },
      },
      ui: {
        theme: 'dark' as const,
        gridSize: 'medium' as const,
        autoPlayVideos: true,
        showMetadata: true,
      },
      privacy: {
        showOnlineStatus: true,
        allowTagging: true,
        defaultAlbumVisibility: 'private' as const,
      },
    },
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRepository = {
      getOrCreate: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    service = new UserPreferencesService(mockRepository);
  });

  describe('getPreferences', () => {
    it('returns cached preferences when available', async () => {
      mockCacheGet.mockReturnValue(mockPreferencesRow.preferences);

      const result = await service.getPreferences('user-123');

      expect(result.userId).toBe('user-123');
      expect(result.preferences).toEqual(mockPreferencesRow.preferences);
      expect(mockRepository.getOrCreate).not.toHaveBeenCalled();
    });

    it('fetches from database when cache misses', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue(mockPreferencesRow);

      const result = await service.getPreferences('user-123');

      expect(mockRepository.getOrCreate).toHaveBeenCalledWith('user-123');
      expect(result.preferences.ui.theme).toBe('dark');
    });

    it('caches fetched preferences', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue(mockPreferencesRow);

      await service.getPreferences('user-123');

      expect(mockCacheSet).toHaveBeenCalledWith(
        'user:user-123:preferences',
        expect.any(Object),
        expect.any(Number)
      );
    });

    it('merges with defaults for backwards compatibility', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue({
        ...mockPreferencesRow,
        preferences: {
          notifications: {
            email: { enabled: true },
            push: { enabled: false },
          },
          ui: { theme: 'light' },
          privacy: {},
        },
      });

      const result = await service.getPreferences('user-123');

      // Should have default fields filled in
      expect(result.preferences.ui.theme).toBe('light');
      expect(result.preferences.ui).toHaveProperty('gridSize');
      expect(result.preferences.privacy).toHaveProperty('showOnlineStatus');
    });
  });

  describe('updatePreferences', () => {
    it('updates preferences successfully', async () => {
      vi.mocked(mockRepository.update).mockResolvedValue({
        ...mockPreferencesRow,
        preferences: {
          ...mockPreferencesRow.preferences,
          ui: { ...mockPreferencesRow.preferences.ui, theme: 'light' },
        },
      });

      const result = await service.updatePreferences('user-123', {
        ui: { theme: 'light' },
      });

      expect(result.preferences.ui.theme).toBe('light');
      expect(mockRepository.update).toHaveBeenCalledWith('user-123', {
        preferences: { ui: { theme: 'light' } },
      });
    });

    it('validates input before updating', async () => {
      // Invalid theme value
      await expect(
        service.updatePreferences('user-123', {
          ui: { theme: 'invalid' as 'dark' },
        })
      ).rejects.toThrow(ValidationError);

      expect(mockRepository.update).not.toHaveBeenCalled();
    });

    it('invalidates cache after update', async () => {
      vi.mocked(mockRepository.update).mockResolvedValue(mockPreferencesRow);

      await service.updatePreferences('user-123', {
        ui: { showMetadata: false },
      });

      expect(mockCacheInvalidate).toHaveBeenCalledWith('user:user-123:preferences');
    });

    it('accepts partial notification updates', async () => {
      vi.mocked(mockRepository.update).mockResolvedValue(mockPreferencesRow);

      await service.updatePreferences('user-123', {
        notifications: {
          email: { enabled: false },
        },
      });

      expect(mockRepository.update).toHaveBeenCalledWith('user-123', {
        preferences: {
          notifications: {
            email: { enabled: false },
          },
        },
      });
    });

    it('accepts partial privacy updates', async () => {
      vi.mocked(mockRepository.update).mockResolvedValue(mockPreferencesRow);

      await service.updatePreferences('user-123', {
        privacy: { allowTagging: false },
      });

      expect(mockRepository.update).toHaveBeenCalledWith('user-123', {
        preferences: {
          privacy: { allowTagging: false },
        },
      });
    });
  });

  describe('resetPreferences', () => {
    it('deletes existing preferences', async () => {
      vi.mocked(mockRepository.delete).mockResolvedValue(undefined);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue(mockPreferencesRow);

      await service.resetPreferences('user-123');

      expect(mockRepository.delete).toHaveBeenCalledWith('user-123');
    });

    it('invalidates cache after reset', async () => {
      vi.mocked(mockRepository.delete).mockResolvedValue(undefined);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue(mockPreferencesRow);

      await service.resetPreferences('user-123');

      expect(mockCacheInvalidate).toHaveBeenCalledWith('user:user-123:preferences');
    });

    it('returns default preferences after reset', async () => {
      vi.mocked(mockRepository.delete).mockResolvedValue(undefined);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue({
        ...mockPreferencesRow,
        preferences: {
          notifications: {
            email: { enabled: true, digest: 'daily', newShares: true, comments: true, albumUpdates: true, systemAlerts: true },
            push: { enabled: true, newShares: true, comments: true, albumUpdates: true },
          },
          ui: { theme: 'dark', gridSize: 'medium', autoPlayVideos: true, showMetadata: true },
          privacy: { showOnlineStatus: true, allowTagging: true, defaultAlbumVisibility: 'private' },
        },
      });

      const result = await service.resetPreferences('user-123');

      expect(result.userId).toBe('user-123');
      expect(result.preferences.ui.theme).toBe('dark'); // Default
    });
  });

  describe('getTheme', () => {
    it('returns user theme preference', async () => {
      mockCacheGet.mockReturnValue(mockPreferencesRow.preferences);

      const result = await service.getTheme('user-123');

      expect(result).toBe('dark');
    });

    it('returns theme from different user', async () => {
      mockCacheGet.mockReturnValue({
        ...mockPreferencesRow.preferences,
        ui: { ...mockPreferencesRow.preferences.ui, theme: 'light' },
      });

      const result = await service.getTheme('user-456');

      expect(result).toBe('light');
    });
  });

  describe('isEmailNotificationsEnabled', () => {
    it('returns true when email notifications enabled', async () => {
      mockCacheGet.mockReturnValue(mockPreferencesRow.preferences);

      const result = await service.isEmailNotificationsEnabled('user-123');

      expect(result).toBe(true);
    });

    it('returns false when email notifications disabled', async () => {
      mockCacheGet.mockReturnValue({
        ...mockPreferencesRow.preferences,
        notifications: {
          ...mockPreferencesRow.preferences.notifications,
          email: { ...mockPreferencesRow.preferences.notifications.email, enabled: false },
        },
      });

      const result = await service.isEmailNotificationsEnabled('user-123');

      expect(result).toBe(false);
    });
  });

  describe('isPushNotificationsEnabled', () => {
    it('returns true when push notifications enabled', async () => {
      mockCacheGet.mockReturnValue(mockPreferencesRow.preferences);

      const result = await service.isPushNotificationsEnabled('user-123');

      expect(result).toBe(true);
    });

    it('returns false when push notifications disabled', async () => {
      mockCacheGet.mockReturnValue({
        ...mockPreferencesRow.preferences,
        notifications: {
          ...mockPreferencesRow.preferences.notifications,
          push: { ...mockPreferencesRow.preferences.notifications.push, enabled: false },
        },
      });

      const result = await service.isPushNotificationsEnabled('user-123');

      expect(result).toBe(false);
    });
  });

  describe('getNotificationPreferences', () => {
    it('returns full notification preferences', async () => {
      mockCacheGet.mockReturnValue(mockPreferencesRow.preferences);

      const result = await service.getNotificationPreferences('user-123');

      expect(result.email.enabled).toBe(true);
      expect(result.push.enabled).toBe(true);
    });
  });

  describe('invalidateUserCache', () => {
    it('invalidates cache pattern for user', () => {
      service.invalidateUserCache('user-123');

      expect(mockCacheInvalidatePattern).toHaveBeenCalledWith('user:user-123:*');
    });
  });

  describe('invalidateAllUserCache', () => {
    it('invalidates all user preferences cache', () => {
      service.invalidateAllUserCache();

      expect(mockCacheInvalidatePattern).toHaveBeenCalledWith('user:*:preferences');
    });
  });

  describe('mergeWithDefaults (via getPreferences)', () => {
    it('fills in missing notification email fields', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue({
        ...mockPreferencesRow,
        preferences: {
          notifications: {
            email: { enabled: true },
            push: { enabled: false },
          },
          ui: { theme: 'dark' },
          privacy: {},
        },
      });

      const result = await service.getPreferences('user-123');

      // Should fill in default fields: newShares, comments, albumUpdates, systemAlerts, digest
      expect(result.preferences.notifications.email).toHaveProperty('newShares');
      expect(result.preferences.notifications.email).toHaveProperty('comments');
    });

    it('fills in missing UI fields', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue({
        ...mockPreferencesRow,
        preferences: {
          notifications: {
            email: { enabled: true },
            push: { enabled: true },
          },
          ui: { theme: 'light' },
          privacy: { showOnlineStatus: true },
        },
      });

      const result = await service.getPreferences('user-123');

      // Should fill in default fields: gridSize, autoPlayVideos, showMetadata
      expect(result.preferences.ui).toHaveProperty('gridSize');
      expect(result.preferences.ui).toHaveProperty('autoPlayVideos');
    });

    it('preserves user values over defaults', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.getOrCreate).mockResolvedValue({
        ...mockPreferencesRow,
        preferences: {
          notifications: {
            email: { enabled: false, newShares: false },
            push: { enabled: false },
          },
          ui: { theme: 'light', gridSize: 'large' },
          privacy: { showOnlineStatus: false },
        },
      });

      const result = await service.getPreferences('user-123');

      expect(result.preferences.ui.theme).toBe('light');
      expect(result.preferences.ui.gridSize).toBe('large');
      expect(result.preferences.notifications.email.enabled).toBe(false);
    });
  });
});
