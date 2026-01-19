/**
 * Settings API Service Tests
 *
 * Tests for settings and user preferences API methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settingsApi } from './settings.api';

// Mock apiClient
vi.mock('./client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

import { apiClient } from './client';

const mockApiClient = apiClient as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

describe('settingsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPreferences', () => {
    it('calls GET /settings/preferences', async () => {
      const mockPreferences = {
        userId: 'user-123',
        preferences: {
          ui: { theme: 'dark', gridSize: 'medium', showMetadata: true },
          notifications: {
            email: { enabled: false, digest: 'daily' },
            push: { enabled: false },
          },
          privacy: { defaultAlbumVisibility: 'private', allowTagging: true },
        },
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockPreferences },
      });

      await settingsApi.getPreferences();

      expect(mockApiClient.get).toHaveBeenCalledWith('/settings/preferences');
    });

    it('returns preferences object', async () => {
      const mockPreferences = {
        userId: 'user-123',
        preferences: {
          ui: { theme: 'dark', gridSize: 'medium', showMetadata: true },
          notifications: {
            email: { enabled: false, digest: 'daily' },
            push: { enabled: false },
          },
          privacy: { defaultAlbumVisibility: 'private', allowTagging: true },
        },
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockPreferences },
      });

      const result = await settingsApi.getPreferences();

      expect(result).toEqual(mockPreferences);
    });
  });

  describe('updatePreferences', () => {
    it('calls PATCH /settings/preferences', async () => {
      const update = { ui: { theme: 'light' } };
      const mockUpdated = {
        userId: 'user-123',
        preferences: {
          ui: { theme: 'light', gridSize: 'medium', showMetadata: true },
          notifications: {
            email: { enabled: false, digest: 'daily' },
            push: { enabled: false },
          },
          privacy: { defaultAlbumVisibility: 'private', allowTagging: true },
        },
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockApiClient.patch.mockResolvedValue({
        data: { data: mockUpdated },
      });

      await settingsApi.updatePreferences(update);

      expect(mockApiClient.patch).toHaveBeenCalledWith('/settings/preferences', update);
    });

    it('sends partial update in body', async () => {
      const update = { notifications: { email: { enabled: true } } };

      mockApiClient.patch.mockResolvedValue({
        data: { data: {} },
      });

      await settingsApi.updatePreferences(update);

      expect(mockApiClient.patch).toHaveBeenCalledWith(
        '/settings/preferences',
        { notifications: { email: { enabled: true } } }
      );
    });

    it('returns updated preferences', async () => {
      const mockUpdated = {
        userId: 'user-123',
        preferences: {
          ui: { theme: 'light', gridSize: 'medium', showMetadata: true },
        },
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockApiClient.patch.mockResolvedValue({
        data: { data: mockUpdated },
      });

      const result = await settingsApi.updatePreferences({ ui: { theme: 'light' } });

      expect(result).toEqual(mockUpdated);
    });
  });

  describe('resetPreferences', () => {
    it('calls POST /settings/preferences/reset', async () => {
      const mockDefaults = {
        userId: 'user-123',
        preferences: {
          ui: { theme: 'dark', gridSize: 'medium', showMetadata: true },
        },
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockApiClient.post.mockResolvedValue({
        data: { data: mockDefaults },
      });

      await settingsApi.resetPreferences();

      expect(mockApiClient.post).toHaveBeenCalledWith('/settings/preferences/reset');
    });

    it('returns default preferences', async () => {
      const mockDefaults = {
        userId: 'user-123',
        preferences: {
          ui: { theme: 'dark', gridSize: 'medium', showMetadata: true },
          notifications: {
            email: { enabled: false, digest: 'daily' },
            push: { enabled: false },
          },
          privacy: { defaultAlbumVisibility: 'private', allowTagging: true },
        },
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockApiClient.post.mockResolvedValue({
        data: { data: mockDefaults },
      });

      const result = await settingsApi.resetPreferences();

      expect(result).toEqual(mockDefaults);
    });
  });

  describe('getFeatureFlags', () => {
    it('calls GET /settings/features', async () => {
      const mockFeatures = {
        enableAiTagging: true,
        enableFaceRecognition: false,
        enablePublicSharing: true,
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockFeatures },
      });

      await settingsApi.getFeatureFlags();

      expect(mockApiClient.get).toHaveBeenCalledWith('/settings/features');
    });

    it('returns feature flags object', async () => {
      const mockFeatures = {
        enableAiTagging: true,
        enableFaceRecognition: false,
        enablePublicSharing: true,
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockFeatures },
      });

      const result = await settingsApi.getFeatureFlags();

      expect(result).toEqual(mockFeatures);
    });
  });

  describe('getTheme', () => {
    it('calls GET /settings/preferences/theme', async () => {
      mockApiClient.get.mockResolvedValue({
        data: { data: { theme: 'dark' } },
      });

      await settingsApi.getTheme();

      expect(mockApiClient.get).toHaveBeenCalledWith('/settings/preferences/theme');
    });

    it('returns theme string', async () => {
      mockApiClient.get.mockResolvedValue({
        data: { data: { theme: 'light' } },
      });

      const result = await settingsApi.getTheme();

      expect(result).toEqual({ theme: 'light' });
    });
  });

  describe('getAllSystemSettings (admin)', () => {
    it('calls GET /settings/system', async () => {
      const mockSettings = [
        { category: 'storage', settings: {} },
        { category: 'email', settings: {} },
      ];

      mockApiClient.get.mockResolvedValue({
        data: { data: mockSettings },
      });

      await settingsApi.getAllSystemSettings();

      expect(mockApiClient.get).toHaveBeenCalledWith('/settings/system');
    });
  });

  describe('getSystemSettings (admin)', () => {
    it('calls GET /settings/system/:category', async () => {
      const mockSetting = {
        category: 'storage',
        settings: { maxUploadSize: 100 },
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockSetting },
      });

      await settingsApi.getSystemSettings('storage');

      expect(mockApiClient.get).toHaveBeenCalledWith('/settings/system/storage');
    });
  });

  describe('updateSystemSettings (admin)', () => {
    it('calls PATCH /settings/system/:category', async () => {
      const mockUpdated = {
        category: 'storage',
        settings: { maxUploadSize: 200 },
      };

      mockApiClient.patch.mockResolvedValue({
        data: { data: mockUpdated },
      });

      await settingsApi.updateSystemSettings('storage', { maxUploadSize: 200 });

      expect(mockApiClient.patch).toHaveBeenCalledWith(
        '/settings/system/storage',
        { settings: { maxUploadSize: 200 } }
      );
    });
  });
});
