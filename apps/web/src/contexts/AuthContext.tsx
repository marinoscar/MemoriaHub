import { create } from 'zustand';
import type { UserDTO } from '@memoriahub/shared';
import { authApi } from '../services/api';
import { tokenStorage } from '../services/storage/token.storage';

/**
 * Auth state interface
 */
export interface AuthState {
  /** Current authenticated user */
  user: UserDTO | null;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether auth state is being loaded */
  isLoading: boolean;
  /** Error message */
  error: string | null;

  // Actions
  /** Login with tokens from OAuth callback */
  login: (accessToken: string, refreshToken: string) => Promise<void>;
  /** Logout user */
  logout: () => Promise<void>;
  /** Refresh access token */
  refreshToken: () => Promise<boolean>;
  /** Check auth status on app load */
  checkAuth: () => Promise<void>;
  /** Clear error */
  clearError: () => void;
}

/**
 * Auth store using Zustand
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (accessToken: string, refreshToken: string) => {
    try {
      // Store tokens
      tokenStorage.setAccessToken(accessToken);
      tokenStorage.setRefreshToken(refreshToken);

      // Fetch user info
      const user = await authApi.getMe();

      set({
        user,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      tokenStorage.clearAll();
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
      throw error;
    }
  },

  logout: async () => {
    try {
      const refreshToken = tokenStorage.getRefreshToken();
      if (refreshToken) {
        await authApi.logout(refreshToken);
      }
    } catch {
      // Ignore errors during logout API call
    } finally {
      tokenStorage.clearAll();
      set({
        user: null,
        isAuthenticated: false,
        error: null,
      });
    }
  },

  refreshToken: async () => {
    const refreshToken = tokenStorage.getRefreshToken();
    if (!refreshToken) {
      return false;
    }

    try {
      const response = await authApi.refresh(refreshToken);
      tokenStorage.setAccessToken(response.accessToken);

      // If a new refresh token is provided, update it
      if (response.refreshToken) {
        tokenStorage.setRefreshToken(response.refreshToken);
      }

      return true;
    } catch {
      tokenStorage.clearAll();
      set({
        user: null,
        isAuthenticated: false,
      });
      return false;
    }
  },

  checkAuth: async () => {
    set({ isLoading: true });

    const accessToken = tokenStorage.getAccessToken();
    const refreshToken = tokenStorage.getRefreshToken();

    // No tokens - not authenticated
    if (!accessToken && !refreshToken) {
      set({
        isLoading: false,
        isAuthenticated: false,
      });
      return;
    }

    // Try to get user with current access token
    if (accessToken) {
      try {
        const user = await authApi.getMe();
        set({
          user,
          isAuthenticated: true,
          isLoading: false,
        });
        return;
      } catch {
        // Access token invalid, try refresh
      }
    }

    // Try to refresh token
    const refreshed = await get().refreshToken();
    if (refreshed) {
      try {
        const user = await authApi.getMe();
        set({
          user,
          isAuthenticated: true,
          isLoading: false,
        });
        return;
      } catch {
        // Refresh succeeded but getMe failed
      }
    }

    // All attempts failed
    set({
      isLoading: false,
      isAuthenticated: false,
    });
  },

  clearError: () => {
    set({ error: null });
  },
}));
