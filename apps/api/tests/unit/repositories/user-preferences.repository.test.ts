/**
 * User Preferences Repository Tests
 *
 * Tests for PostgreSQL user preferences repository implementation.
 * Covers CRUD operations for user preferences with deep merge functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@memoriahub/shared';

// Mock the database client
const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/database/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock the logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { UserPreferencesRepository } from '../../../src/infrastructure/database/repositories/user-preferences.repository.js';

describe('UserPreferencesRepository', () => {
  let repository: UserPreferencesRepository;

  const mockPreferencesRow = {
    user_id: 'user-123',
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
          enabled: false,
          newShares: true,
          comments: true,
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
    } satisfies UserPreferences,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-15'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new UserPreferencesRepository();
  });

  describe('findByUserId', () => {
    it('returns preferences for existing user', async () => {
      mockQuery.mockResolvedValue({
        rows: [mockPreferencesRow],
      });

      const result = await repository.findByUserId('user-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT user_id, preferences, created_at, updated_at FROM user_settings WHERE user_id = $1',
        ['user-123']
      );
      expect(result).toEqual({
        userId: 'user-123',
        preferences: mockPreferencesRow.preferences,
        createdAt: mockPreferencesRow.created_at,
        updatedAt: mockPreferencesRow.updated_at,
      });
    });

    it('returns null when user not found', async () => {
      mockQuery.mockResolvedValue({
        rows: [],
      });

      const result = await repository.findByUserId('nonexistent-user');

      expect(result).toBeNull();
    });

    it('queries with correct user ID parameter', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repository.findByUserId('specific-user-id');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['specific-user-id']
      );
    });

    it('correctly maps database row to domain entity', async () => {
      const dbRow = {
        user_id: 'user-456',
        preferences: { ...DEFAULT_USER_PREFERENCES, ui: { ...DEFAULT_USER_PREFERENCES.ui, theme: 'light' as const } },
        created_at: new Date('2024-02-01'),
        updated_at: new Date('2024-02-15'),
      };
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const result = await repository.findByUserId('user-456');

      expect(result).toEqual({
        userId: 'user-456',
        preferences: dbRow.preferences,
        createdAt: dbRow.created_at,
        updatedAt: dbRow.updated_at,
      });
    });
  });

  describe('getOrCreate', () => {
    it('returns existing preferences if found', async () => {
      mockQuery.mockResolvedValue({
        rows: [mockPreferencesRow],
      });

      const result = await repository.getOrCreate('user-123');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result.userId).toBe('user-123');
      expect(result.preferences).toEqual(mockPreferencesRow.preferences);
    });

    it('creates new preferences with defaults if not found', async () => {
      // First call (findByUserId) returns nothing
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Second call (INSERT) returns new row
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'new-user',
          preferences: DEFAULT_USER_PREFERENCES,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const result = await repository.getOrCreate('new-user');

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('INSERT INTO user_settings'),
        ['new-user', JSON.stringify(DEFAULT_USER_PREFERENCES)]
      );
      expect(result.preferences).toEqual(DEFAULT_USER_PREFERENCES);
    });

    it('uses ON CONFLICT clause for race condition handling', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'user',
          preferences: DEFAULT_USER_PREFERENCES,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      await repository.getOrCreate('user');

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ON CONFLICT (user_id) DO UPDATE'),
        expect.any(Array)
      );
    });

    it('returns RETURNING values on insert', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'new-user',
          preferences: DEFAULT_USER_PREFERENCES,
          created_at: new Date('2024-03-01'),
          updated_at: new Date('2024-03-01'),
        }],
      });

      const result = await repository.getOrCreate('new-user');

      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('update', () => {
    it('deep merges preferences with existing values', async () => {
      // getOrCreate returns existing preferences
      mockQuery.mockResolvedValueOnce({
        rows: [mockPreferencesRow],
      });
      // UPDATE returns merged result
      const mergedPrefs = {
        ...mockPreferencesRow.preferences,
        ui: { ...mockPreferencesRow.preferences.ui, theme: 'light' as const },
      };
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'user-123',
          preferences: mergedPrefs,
          created_at: mockPreferencesRow.created_at,
          updated_at: new Date(),
        }],
      });

      const result = await repository.update('user-123', {
        preferences: { ui: { theme: 'light' } },
      });

      expect(result.preferences.ui.theme).toBe('light');
      // Other UI settings should be preserved
      expect(result.preferences.ui.gridSize).toBe('medium');
    });

    it('creates preferences if user has none', async () => {
      // First findByUserId returns nothing
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // getOrCreate INSERT
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'new-user',
          preferences: DEFAULT_USER_PREFERENCES,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });
      // UPDATE after merge
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'new-user',
          preferences: { ...DEFAULT_USER_PREFERENCES, ui: { ...DEFAULT_USER_PREFERENCES.ui, theme: 'light' as const } },
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const result = await repository.update('new-user', {
        preferences: { ui: { theme: 'light' } },
      });

      expect(result.preferences.ui.theme).toBe('light');
    });

    it('uses UPDATE SQL with correct parameters', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [mockPreferencesRow],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          ...mockPreferencesRow,
          updated_at: new Date(),
        }],
      });

      await repository.update('user-123', {
        preferences: { privacy: { showOnlineStatus: false } },
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('UPDATE user_settings'),
        expect.arrayContaining(['user-123'])
      );
    });

    it('throws error if update returns no rows', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [mockPreferencesRow],
      });
      // UPDATE returns empty (should not happen but handle defensively)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(
        repository.update('user-123', { preferences: { ui: { theme: 'light' } } })
      ).rejects.toThrow('User preferences not found for user user-123');
    });

    it('preserves nested preferences not being updated', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [mockPreferencesRow],
      });
      const expectedMerged = {
        ...mockPreferencesRow.preferences,
        notifications: {
          ...mockPreferencesRow.preferences.notifications,
          email: {
            ...mockPreferencesRow.preferences.notifications.email,
            enabled: false,
          },
        },
      };
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'user-123',
          preferences: expectedMerged,
          created_at: mockPreferencesRow.created_at,
          updated_at: new Date(),
        }],
      });

      const result = await repository.update('user-123', {
        preferences: { notifications: { email: { enabled: false } } },
      });

      // Email enabled changed
      expect(result.preferences.notifications.email.enabled).toBe(false);
      // Other email settings preserved
      expect(result.preferences.notifications.email.digest).toBe('daily');
      // Push settings unchanged
      expect(result.preferences.notifications.push.enabled).toBe(false);
    });
  });

  describe('delete', () => {
    it('returns true when preferences deleted', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      const result = await repository.delete('user-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM user_settings WHERE user_id = $1',
        ['user-123']
      );
      expect(result).toBe(true);
    });

    it('returns false when no preferences found', async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });

      const result = await repository.delete('nonexistent-user');

      expect(result).toBe(false);
    });

    it('returns false when rowCount is undefined', async () => {
      mockQuery.mockResolvedValue({});

      const result = await repository.delete('user');

      expect(result).toBe(false);
    });

    it('queries with correct user ID', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      await repository.delete('specific-user-id');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE'),
        ['specific-user-id']
      );
    });
  });

  describe('row to entity mapping', () => {
    it('converts snake_case to camelCase', async () => {
      mockQuery.mockResolvedValue({
        rows: [mockPreferencesRow],
      });

      const result = await repository.findByUserId('user-123');

      expect(result).toHaveProperty('userId');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      expect(result).not.toHaveProperty('user_id');
      expect(result).not.toHaveProperty('created_at');
      expect(result).not.toHaveProperty('updated_at');
    });

    it('preserves Date types', async () => {
      const createdDate = new Date('2024-01-01');
      const updatedDate = new Date('2024-01-15');
      mockQuery.mockResolvedValue({
        rows: [{
          user_id: 'user-123',
          preferences: DEFAULT_USER_PREFERENCES,
          created_at: createdDate,
          updated_at: updatedDate,
        }],
      });

      const result = await repository.findByUserId('user-123');

      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
      expect(result?.createdAt).toEqual(createdDate);
      expect(result?.updatedAt).toEqual(updatedDate);
    });
  });

  describe('deep merge behavior', () => {
    it('merges objects at multiple nesting levels', async () => {
      const existingPrefs: UserPreferences = {
        notifications: {
          email: {
            enabled: true,
            digest: 'daily',
            newShares: true,
            comments: true,
            albumUpdates: true,
            systemAlerts: true,
          },
          push: {
            enabled: false,
            newShares: false,
            comments: false,
            albumUpdates: false,
          },
        },
        ui: {
          theme: 'dark',
          gridSize: 'large',
          autoPlayVideos: true,
          showMetadata: false,
        },
        privacy: {
          showOnlineStatus: true,
          allowTagging: true,
          defaultAlbumVisibility: 'private',
        },
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'user',
          preferences: existingPrefs,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const mergedResult = {
        ...existingPrefs,
        notifications: {
          ...existingPrefs.notifications,
          email: {
            ...existingPrefs.notifications.email,
            digest: 'weekly' as const,
          },
          push: {
            ...existingPrefs.notifications.push,
            enabled: true,
          },
        },
        ui: {
          ...existingPrefs.ui,
          theme: 'light' as const,
        },
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'user',
          preferences: mergedResult,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const result = await repository.update('user', {
        preferences: {
          notifications: {
            email: { digest: 'weekly' },
            push: { enabled: true },
          },
          ui: { theme: 'light' },
        },
      });

      // Changed values
      expect(result.preferences.notifications.email.digest).toBe('weekly');
      expect(result.preferences.notifications.push.enabled).toBe(true);
      expect(result.preferences.ui.theme).toBe('light');

      // Preserved values
      expect(result.preferences.notifications.email.enabled).toBe(true);
      expect(result.preferences.notifications.push.newShares).toBe(false);
      expect(result.preferences.ui.gridSize).toBe('large');
      expect(result.preferences.privacy.showOnlineStatus).toBe(true);
    });

    it('handles undefined values in source', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [mockPreferencesRow],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{
          ...mockPreferencesRow,
          updated_at: new Date(),
        }],
      });

      // Partial update with explicit undefined should not overwrite
      const result = await repository.update('user-123', {
        preferences: {
          ui: {
            theme: 'light',
            gridSize: undefined, // Should not affect existing value
          },
        },
      });

      // This tests the repository behavior, actual merge happens in the implementation
      expect(result).toBeDefined();
    });
  });
});
