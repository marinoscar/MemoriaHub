import type {
  ApiResponse,
  UserDTO,
  OAuthProviderInfo,
  RefreshTokenResponse,
} from '@memoriahub/shared';
import { apiClient } from './client';

/**
 * Auth API service
 */
export const authApi = {
  /**
   * Get available OAuth providers
   */
  async getProviders(): Promise<OAuthProviderInfo[]> {
    const response = await apiClient.get<ApiResponse<OAuthProviderInfo[]>>('/auth/providers');
    return response.data.data;
  },

  /**
   * Get current user
   */
  async getMe(): Promise<UserDTO> {
    const response = await apiClient.get<ApiResponse<UserDTO>>('/auth/me');
    return response.data.data;
  },

  /**
   * Refresh access token
   */
  async refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    const response = await apiClient.post<ApiResponse<RefreshTokenResponse>>('/auth/refresh', {
      refreshToken,
    });
    return response.data.data;
  },

  /**
   * Logout
   */
  async logout(refreshToken?: string): Promise<void> {
    await apiClient.post('/auth/logout', { refreshToken });
  },

  /**
   * Get OAuth authorization URL
   * Note: This triggers a redirect, so it's not an async API call
   */
  getOAuthUrl(provider: string): string {
    const baseUrl = window.location.origin;
    return `/api/auth/${provider}?redirect_uri=${encodeURIComponent(baseUrl)}`;
  },
};
