/**
 * AuthContext (Zustand Store) Tests
 *
 * Tests for the authentication state management store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { useAuthStore } from './AuthContext';

// Mock dependencies
vi.mock('../services/api', () => ({
  authApi: {
    getMe: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock('../services/storage/token.storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(),
    setAccessToken: vi.fn(),
    getRefreshToken: vi.fn(),
    setRefreshToken: vi.fn(),
    clearAll: vi.fn(),
  },
}));

// Import mocked modules
import { authApi } from '../services/api';
import { tokenStorage } from '../services/storage/token.storage';

// Type the mocks
const mockAuthApi = vi.mocked(authApi);
const mockTokenStorage = vi.mocked(tokenStorage);

// Mock user data
const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  displayName: 'Test User',
  avatarUrl: 'https://example.com/avatar.jpg',
  oauthProvider: 'google' as const,
  role: 'user' as const,
  createdAt: '2024-01-01T00:00:00Z',
};

describe('useAuthStore', () => {
  // Reset store and mocks before each test
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the Zustand store to initial state
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('initial state', () => {
    it('starts with user as null', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
    });

    it('starts with isAuthenticated as false', () => {
      const state = useAuthStore.getState();
      expect(state.isAuthenticated).toBe(false);
    });

    it('starts with isLoading as true', () => {
      const state = useAuthStore.getState();
      expect(state.isLoading).toBe(true);
    });

    it('starts with error as null', () => {
      const state = useAuthStore.getState();
      expect(state.error).toBeNull();
    });
  });

  describe('login', () => {
    it('stores access token in session storage', async () => {
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().login('access-token', 'refresh-token');
      });

      expect(mockTokenStorage.setAccessToken).toHaveBeenCalledWith('access-token');
    });

    it('stores refresh token in local storage', async () => {
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().login('access-token', 'refresh-token');
      });

      expect(mockTokenStorage.setRefreshToken).toHaveBeenCalledWith('refresh-token');
    });

    it('fetches user info after storing tokens', async () => {
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().login('access-token', 'refresh-token');
      });

      expect(mockAuthApi.getMe).toHaveBeenCalled();
    });

    it('sets isAuthenticated to true on success', async () => {
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().login('access-token', 'refresh-token');
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('sets user state from API response', async () => {
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().login('access-token', 'refresh-token');
      });

      expect(useAuthStore.getState().user).toEqual(mockUser);
    });

    it('sets isLoading to false on success', async () => {
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().login('access-token', 'refresh-token');
      });

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('sets error state on API failure', async () => {
      mockAuthApi.getMe.mockRejectedValue(new Error('API error'));

      await act(async () => {
        try {
          await useAuthStore.getState().login('access-token', 'refresh-token');
        } catch {
          // Expected to throw
        }
      });

      expect(useAuthStore.getState().error).toBe('API error');
    });

    it('clears tokens on API failure', async () => {
      mockAuthApi.getMe.mockRejectedValue(new Error('API error'));

      await act(async () => {
        try {
          await useAuthStore.getState().login('access-token', 'refresh-token');
        } catch {
          // Expected to throw
        }
      });

      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('sets isAuthenticated to false on failure', async () => {
      mockAuthApi.getMe.mockRejectedValue(new Error('API error'));

      await act(async () => {
        try {
          await useAuthStore.getState().login('access-token', 'refresh-token');
        } catch {
          // Expected to throw
        }
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('throws error on failure', async () => {
      mockAuthApi.getMe.mockRejectedValue(new Error('API error'));

      await expect(
        useAuthStore.getState().login('access-token', 'refresh-token')
      ).rejects.toThrow('API error');
    });
  });

  describe('logout', () => {
    beforeEach(() => {
      // Set authenticated state
      useAuthStore.setState({
        user: mockUser,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    });

    it('calls logout API endpoint', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.logout.mockResolvedValue(undefined);

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(mockAuthApi.logout).toHaveBeenCalledWith('refresh-token');
    });

    it('clears access token from session storage', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.logout.mockResolvedValue(undefined);

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('clears refresh token from local storage', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.logout.mockResolvedValue(undefined);

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      // clearAll handles both tokens
      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('sets user to null', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.logout.mockResolvedValue(undefined);

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(useAuthStore.getState().user).toBeNull();
    });

    it('sets isAuthenticated to false', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.logout.mockResolvedValue(undefined);

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('handles API error gracefully (still clears local state)', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.logout.mockRejectedValue(new Error('API error'));

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      // Should still clear state even if API fails
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('does not call API if no refresh token', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue(null);

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      expect(mockAuthApi.logout).not.toHaveBeenCalled();
    });
  });

  describe('checkAuth', () => {
    it('returns early if no tokens exist', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue(null);
      mockTokenStorage.getRefreshToken.mockReturnValue(null);

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(mockAuthApi.getMe).not.toHaveBeenCalled();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('sets isLoading to true while checking', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue('access-token');
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');

      let loadingDuringCheck = false;
      mockAuthApi.getMe.mockImplementation(async () => {
        loadingDuringCheck = useAuthStore.getState().isLoading;
        return mockUser;
      });

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(loadingDuringCheck).toBe(true);
    });

    it('fetches user if access token exists', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue('access-token');
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(mockAuthApi.getMe).toHaveBeenCalled();
    });

    it('sets isAuthenticated true if user fetch succeeds', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue('access-token');
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).toEqual(mockUser);
    });

    it('attempts refresh if user fetch returns 401', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue('access-token');
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');

      // First call fails, second succeeds (after refresh)
      mockAuthApi.getMe
        .mockRejectedValueOnce(new Error('Unauthorized'))
        .mockResolvedValueOnce(mockUser);
      mockAuthApi.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(mockAuthApi.refresh).toHaveBeenCalled();
    });

    it('logs out if refresh fails', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue('access-token');
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');

      mockAuthApi.getMe.mockRejectedValue(new Error('Unauthorized'));
      mockAuthApi.refresh.mockRejectedValue(new Error('Refresh failed'));

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('sets isLoading to false when complete', async () => {
      mockTokenStorage.getAccessToken.mockReturnValue('access-token');
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.getMe.mockResolvedValue(mockUser);

      await act(async () => {
        await useAuthStore.getState().checkAuth();
      });

      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  describe('refreshToken', () => {
    it('calls refresh API with refresh token', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      await act(async () => {
        await useAuthStore.getState().refreshToken();
      });

      expect(mockAuthApi.refresh).toHaveBeenCalledWith('refresh-token');
    });

    it('stores new access token on success', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      await act(async () => {
        await useAuthStore.getState().refreshToken();
      });

      expect(mockTokenStorage.setAccessToken).toHaveBeenCalledWith('new-access-token');
    });

    it('stores new refresh token on success', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      await act(async () => {
        await useAuthStore.getState().refreshToken();
      });

      expect(mockTokenStorage.setRefreshToken).toHaveBeenCalledWith('new-refresh-token');
    });

    it('returns true on success', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      let result: boolean = false;
      await act(async () => {
        result = await useAuthStore.getState().refreshToken();
      });

      expect(result).toBe(true);
    });

    it('clears tokens on failure', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockRejectedValue(new Error('Refresh failed'));

      await act(async () => {
        await useAuthStore.getState().refreshToken();
      });

      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('returns false on failure', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockRejectedValue(new Error('Refresh failed'));

      let result: boolean = true;
      await act(async () => {
        result = await useAuthStore.getState().refreshToken();
      });

      expect(result).toBe(false);
    });

    it('returns false if no refresh token exists', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue(null);

      let result: boolean = true;
      await act(async () => {
        result = await useAuthStore.getState().refreshToken();
      });

      expect(result).toBe(false);
      expect(mockAuthApi.refresh).not.toHaveBeenCalled();
    });

    it('sets isAuthenticated to false on failure', async () => {
      useAuthStore.setState({ isAuthenticated: true });
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAuthApi.refresh.mockRejectedValue(new Error('Refresh failed'));

      await act(async () => {
        await useAuthStore.getState().refreshToken();
      });

      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('clearError', () => {
    it('sets error to null', () => {
      useAuthStore.setState({ error: 'Some error' });

      act(() => {
        useAuthStore.getState().clearError();
      });

      expect(useAuthStore.getState().error).toBeNull();
    });
  });
});
