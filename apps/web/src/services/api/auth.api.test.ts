/**
 * Auth API Service Tests
 *
 * Tests for authentication API methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authApi } from './auth.api';

// Mock apiClient
vi.mock('./client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { apiClient } from './client';

const mockApiClient = vi.mocked(apiClient);

describe('authApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getProviders', () => {
    it('calls GET /auth/providers', async () => {
      const mockProviders = [
        { provider: 'google', name: 'Google', enabled: true },
      ];

      mockApiClient.get.mockResolvedValue({
        data: { data: mockProviders },
      });

      await authApi.getProviders();

      expect(mockApiClient.get).toHaveBeenCalledWith('/auth/providers');
    });

    it('returns array of provider objects', async () => {
      const mockProviders = [
        { provider: 'google', name: 'Google', enabled: true },
        { provider: 'microsoft', name: 'Microsoft', enabled: false },
      ];

      mockApiClient.get.mockResolvedValue({
        data: { data: mockProviders },
      });

      const result = await authApi.getProviders();

      expect(result).toEqual(mockProviders);
    });
  });

  describe('getMe', () => {
    it('calls GET /auth/me', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockUser },
      });

      await authApi.getMe();

      expect(mockApiClient.get).toHaveBeenCalledWith('/auth/me');
    });

    it('returns user object', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.jpg',
        oauthProvider: 'google',
      };

      mockApiClient.get.mockResolvedValue({
        data: { data: mockUser },
      });

      const result = await authApi.getMe();

      expect(result).toEqual(mockUser);
    });
  });

  describe('refresh', () => {
    it('calls POST /auth/refresh with refresh token', async () => {
      const mockResponse = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      };

      mockApiClient.post.mockResolvedValue({
        data: { data: mockResponse },
      });

      await authApi.refresh('my-refresh-token');

      expect(mockApiClient.post).toHaveBeenCalledWith('/auth/refresh', {
        refreshToken: 'my-refresh-token',
      });
    });

    it('returns new token pair', async () => {
      const mockResponse = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      };

      mockApiClient.post.mockResolvedValue({
        data: { data: mockResponse },
      });

      const result = await authApi.refresh('refresh-token');

      expect(result).toEqual(mockResponse);
    });
  });

  describe('logout', () => {
    it('calls POST /auth/logout', async () => {
      mockApiClient.post.mockResolvedValue({});

      await authApi.logout('refresh-token');

      expect(mockApiClient.post).toHaveBeenCalledWith('/auth/logout', {
        refreshToken: 'refresh-token',
      });
    });

    it('calls POST /auth/logout without token if not provided', async () => {
      mockApiClient.post.mockResolvedValue({});

      await authApi.logout();

      expect(mockApiClient.post).toHaveBeenCalledWith('/auth/logout', {
        refreshToken: undefined,
      });
    });
  });

  describe('getOAuthUrl', () => {
    beforeEach(() => {
      // Mock window.location.origin
      Object.defineProperty(window, 'location', {
        value: {
          origin: 'http://localhost:5173',
        },
        writable: true,
      });
    });

    it('builds correct URL for google provider', () => {
      const url = authApi.getOAuthUrl('google');

      expect(url).toContain('/api/auth/google');
    });

    it('includes redirect URI', () => {
      const url = authApi.getOAuthUrl('google');

      expect(url).toContain('redirect_uri=');
      expect(url).toContain(encodeURIComponent('http://localhost:5173'));
    });

    it('encodes parameters correctly', () => {
      const url = authApi.getOAuthUrl('google');

      // Should not contain unencoded special characters
      expect(url).not.toContain(' ');
      expect(url).toContain('%3A'); // Encoded colon
      expect(url).toContain('%2F'); // Encoded slash
    });

    it('works for different providers', () => {
      const googleUrl = authApi.getOAuthUrl('google');
      const microsoftUrl = authApi.getOAuthUrl('microsoft');

      expect(googleUrl).toContain('/api/auth/google');
      expect(microsoftUrl).toContain('/api/auth/microsoft');
    });
  });
});
