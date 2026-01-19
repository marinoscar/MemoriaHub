import type { OAuthProvider, UserDTO } from './user.types.js';

/**
 * OAuth provider information for login page
 */
export interface OAuthProviderInfo {
  id: OAuthProvider;
  name: string;
  authUrl: string;
}

/**
 * Token response from authentication
 */
export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/**
 * Refresh token request
 */
export interface RefreshTokenRequest {
  refreshToken: string;
}

/**
 * Refresh token response (may include new refresh token for rotation)
 */
export interface RefreshTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken?: string;
}

/**
 * Logout request (optional refresh token for server-side invalidation)
 */
export interface LogoutRequest {
  refreshToken?: string;
}

/**
 * Login success response
 */
export interface LoginResponse {
  user: UserDTO;
  tokens: TokenResponse;
}

/**
 * JWT access token payload
 */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  type: 'access';
  iat: number;
  exp: number;
}

/**
 * JWT refresh token payload
 */
export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  jti: string;
  iat: number;
  exp: number;
}

/**
 * OAuth callback query parameters from provider
 */
export interface OAuthCallbackParams {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

/**
 * OAuth state stored in session/cookie for CSRF protection
 */
export interface OAuthState {
  csrf: string;
  redirectUri: string;
  createdAt: number;
}
