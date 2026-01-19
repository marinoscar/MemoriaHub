import { OAuth2Client } from 'google-auth-library';
import type { OAuthProvider } from '@memoriahub/shared';
import { ErrorCodes } from '@memoriahub/shared';
import type { IOAuthProvider, OAuthUserInfo, OAuthTokens } from '../../../interfaces/index.js';
import { oauthConfig } from '../../../config/index.js';
import { AuthError } from '../../../domain/errors/index.js';
import { logger } from '../../../infrastructure/logging/logger.js';

/**
 * Google OAuth provider implementation
 * Implements IOAuthProvider interface (Liskov Substitution Principle)
 */
export class GoogleOAuthProvider implements IOAuthProvider {
  readonly providerId: OAuthProvider = 'google';
  readonly providerName = 'Google';

  private readonly client: OAuth2Client;
  private readonly config = oauthConfig.google;

  constructor() {
    this.client = new OAuth2Client(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );
  }

  get isEnabled(): boolean {
    return this.config.enabled && !!this.config.clientId && !!this.config.clientSecret;
  }

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const url = this.client.generateAuthUrl({
      access_type: 'offline', // Request refresh token
      scope: [
        'openid',
        'email',
        'profile',
      ],
      state,
      redirect_uri: redirectUri,
      prompt: 'consent', // Force consent screen to get refresh token
    });

    logger.debug(
      { eventType: 'oauth.google.auth_url_generated', redirectUri },
      'Generated Google OAuth URL'
    );

    return url;
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokens> {
    try {
      const { tokens } = await this.client.getToken({
        code,
        redirect_uri: redirectUri,
      });

      logger.debug(
        {
          eventType: 'oauth.google.tokens_exchanged',
          hasAccessToken: !!tokens.access_token,
          hasRefreshToken: !!tokens.refresh_token,
          hasIdToken: !!tokens.id_token,
        },
        'Exchanged code for tokens'
      );

      if (!tokens.access_token) {
        throw new AuthError('No access token returned from Google', ErrorCodes.OAUTH_ERROR);
      }

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? undefined,
        idToken: tokens.id_token ?? undefined,
        expiresIn: tokens.expiry_date
          ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
          : 3600,
        tokenType: tokens.token_type || 'Bearer',
      };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      logger.error(
        {
          eventType: 'oauth.google.token_exchange_failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to exchange code for tokens'
      );

      throw new AuthError(
        'Failed to exchange authorization code',
        ErrorCodes.OAUTH_ERROR,
        { provider: 'google' }
      );
    }
  }

  async getUserInfo(tokens: OAuthTokens): Promise<OAuthUserInfo> {
    try {
      if (!tokens.idToken) {
        throw new AuthError('ID token required for Google OAuth', ErrorCodes.OAUTH_ERROR);
      }

      // Verify and decode the ID token
      const ticket = await this.client.verifyIdToken({
        idToken: tokens.idToken,
        audience: this.config.clientId,
      });

      const payload = ticket.getPayload();
      if (!payload) {
        throw new AuthError('Invalid ID token payload', ErrorCodes.OAUTH_ERROR);
      }

      if (!payload.sub) {
        throw new AuthError('No subject in ID token', ErrorCodes.OAUTH_ERROR);
      }

      if (!payload.email) {
        throw new AuthError('No email in ID token', ErrorCodes.OAUTH_ERROR);
      }

      logger.debug(
        {
          eventType: 'oauth.google.user_info_retrieved',
          subject: payload.sub,
          emailVerified: payload.email_verified,
        },
        'Retrieved user info from Google'
      );

      return {
        subject: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified ?? false,
        displayName: payload.name,
        avatarUrl: payload.picture,
        rawPayload: payload as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      logger.error(
        {
          eventType: 'oauth.google.user_info_failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to get user info from Google'
      );

      throw new AuthError(
        'Failed to get user information from Google',
        ErrorCodes.OAUTH_ERROR,
        { provider: 'google' }
      );
    }
  }

  async revokeToken(token: string): Promise<void> {
    try {
      await this.client.revokeToken(token);
      logger.info({ eventType: 'oauth.google.token_revoked' }, 'Google token revoked');
    } catch (error) {
      logger.warn(
        {
          eventType: 'oauth.google.revoke_failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to revoke Google token'
      );
      // Don't throw - token revocation failure shouldn't break logout
    }
  }
}

// Export singleton instance
export const googleOAuthProvider = new GoogleOAuthProvider();
