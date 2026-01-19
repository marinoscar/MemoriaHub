/**
 * Token storage keys
 */
const ACCESS_TOKEN_KEY = 'memoriahub_access_token';
const REFRESH_TOKEN_KEY = 'memoriahub_refresh_token';

/**
 * Token storage service
 * Uses sessionStorage for access tokens (cleared on tab close)
 * Uses localStorage for refresh tokens (persists across sessions)
 */
export const tokenStorage = {
  /**
   * Get access token from session storage
   */
  getAccessToken(): string | null {
    return sessionStorage.getItem(ACCESS_TOKEN_KEY);
  },

  /**
   * Set access token in session storage
   */
  setAccessToken(token: string): void {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
  },

  /**
   * Remove access token from session storage
   */
  removeAccessToken(): void {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  },

  /**
   * Get refresh token from local storage
   */
  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },

  /**
   * Set refresh token in local storage
   */
  setRefreshToken(token: string): void {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  },

  /**
   * Remove refresh token from local storage
   */
  removeRefreshToken(): void {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },

  /**
   * Clear all tokens
   */
  clearAll(): void {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },

  /**
   * Check if tokens exist
   */
  hasTokens(): boolean {
    return !!(this.getAccessToken() || this.getRefreshToken());
  },
};
