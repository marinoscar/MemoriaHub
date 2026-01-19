import type { OAuthProvider } from '@memoriahub/shared';

/**
 * User information returned by OAuth provider
 */
export interface OAuthUserInfo {
  /** Provider's unique user identifier */
  subject: string;
  /** User's email address */
  email: string;
  /** Whether email is verified */
  emailVerified: boolean;
  /** Display name */
  displayName?: string;
  /** Avatar/profile picture URL */
  avatarUrl?: string;
  /** Raw payload from provider for debugging */
  rawPayload: Record<string, unknown>;
}

/**
 * Tokens returned by OAuth provider
 */
export interface OAuthTokens {
  /** OAuth access token */
  accessToken: string;
  /** OAuth refresh token (optional) */
  refreshToken?: string;
  /** ID token for OIDC providers */
  idToken?: string;
  /** Token expiration in seconds */
  expiresIn: number;
  /** Token type (usually "Bearer") */
  tokenType: string;
}

/**
 * OAuth provider interface (Open/Closed Principle)
 * Implement this interface to add new OAuth providers without modifying existing code
 */
export interface IOAuthProvider {
  /** Unique provider identifier */
  readonly providerId: OAuthProvider;
  /** Human-readable provider name */
  readonly providerName: string;
  /** Whether this provider is enabled */
  readonly isEnabled: boolean;

  /**
   * Generate the authorization URL for OAuth redirect
   * @param state CSRF state token
   * @param redirectUri The callback URI
   * @returns Full authorization URL
   */
  getAuthorizationUrl(state: string, redirectUri: string): string;

  /**
   * Exchange authorization code for tokens
   * @param code Authorization code from callback
   * @param redirectUri The callback URI (must match)
   * @returns OAuth tokens
   */
  exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokens>;

  /**
   * Get user information using tokens
   * @param tokens OAuth tokens
   * @returns User information from provider
   */
  getUserInfo(tokens: OAuthTokens): Promise<OAuthUserInfo>;

  /**
   * Revoke a token (optional)
   * @param token Token to revoke
   */
  revokeToken?(token: string): Promise<void>;
}
