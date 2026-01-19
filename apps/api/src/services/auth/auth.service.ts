import { randomBytes } from 'crypto';
import type { OAuthProvider, UserDTO } from '@memoriahub/shared';
import { ErrorCodes } from '@memoriahub/shared';
import type { IUserRepository, IOAuthProvider, ITokenService, TokenPair } from '../../interfaces/index.js';
import { oauthConfig } from '../../config/index.js';
import { AuthError } from '../../domain/errors/index.js';
import { userToDTO } from '../../domain/entities/User.js';
import { logger, LogEventTypes } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';
import { authMetrics } from '../../infrastructure/telemetry/metrics.js';
import { query } from '../../infrastructure/database/client.js';

/**
 * Authentication result
 */
export interface AuthResult {
  user: UserDTO;
  tokens: TokenPair;
}

/**
 * OAuth state stored in memory (for development)
 * In production, use Redis or a database
 */
const oauthStates = new Map<string, { redirectUri: string; createdAt: number }>();

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of oauthStates.entries()) {
    if (now - data.createdAt > oauthConfig.stateTtlMs) {
      oauthStates.delete(state);
    }
  }
}, 60000); // Every minute

/**
 * Authentication service
 * Orchestrates the OAuth flow and user management
 * Single Responsibility: Only handles authentication logic
 */
export class AuthService {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly tokenService: ITokenService
  ) {}

  /**
   * Generate OAuth state and return authorization URL
   */
  initiateOAuth(provider: IOAuthProvider, frontendRedirectUri?: string): { authUrl: string; state: string } {
    // Generate CSRF state token
    const state = randomBytes(32).toString('hex');
    const redirectUri = frontendRedirectUri || oauthConfig.frontendUrl;

    // Store state for validation
    oauthStates.set(state, {
      redirectUri,
      createdAt: Date.now(),
    });

    const authUrl = provider.getAuthorizationUrl(state, provider.providerId === 'google' ? oauthConfig.google.redirectUri : provider.providerId);

    logger.info(
      {
        eventType: LogEventTypes.AUTH_LOGIN_STARTED,
        provider: provider.providerId,
        traceId: getTraceId(),
      },
      'OAuth flow initiated'
    );

    return { authUrl, state };
  }

  /**
   * Handle OAuth callback and authenticate user
   */
  async handleOAuthCallback(
    provider: IOAuthProvider,
    code: string,
    state: string
  ): Promise<AuthResult & { frontendRedirectUri: string }> {
    const startTime = Date.now();

    try {
      // Validate state (CSRF protection)
      const stateData = oauthStates.get(state);
      if (!stateData) {
        throw new AuthError('Invalid or expired state', ErrorCodes.INVALID_STATE);
      }

      // Check state expiration
      if (Date.now() - stateData.createdAt > oauthConfig.stateTtlMs) {
        oauthStates.delete(state);
        throw new AuthError('State expired', ErrorCodes.INVALID_STATE);
      }

      // Delete used state
      oauthStates.delete(state);

      // Exchange code for tokens
      const tokens = await provider.exchangeCodeForTokens(
        code,
        provider.providerId === 'google' ? oauthConfig.google.redirectUri : ''
      );

      // Get user info from provider
      const userInfo = await provider.getUserInfo(tokens);

      // Find or create user
      const { user, created } = await this.userRepository.findOrCreate({
        oauthProvider: provider.providerId,
        oauthSubject: userInfo.subject,
        email: userInfo.email,
        emailVerified: userInfo.emailVerified,
        displayName: userInfo.displayName,
        avatarUrl: userInfo.avatarUrl,
      });

      // Generate JWT tokens
      const jwtTokens = this.tokenService.generateTokenPair({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      // Store refresh token hash
      const refreshTokenHash = this.tokenService.hashRefreshToken(jwtTokens.refreshToken);
      await this.userRepository.update(user.id, { refreshTokenHash });

      // Log audit event
      await this.logAuditEvent(user.id, 'login', provider.providerId);

      const durationMs = Date.now() - startTime;

      // Update metrics
      authMetrics.loginAttempts.inc({ provider: provider.providerId, status: 'success' });
      authMetrics.loginDuration.observe({ provider: provider.providerId }, durationMs / 1000);

      logger.info(
        {
          eventType: LogEventTypes.AUTH_LOGIN_SUCCESS,
          userId: user.id,
          provider: provider.providerId,
          userCreated: created,
          durationMs,
          traceId: getTraceId(),
        },
        'User authenticated'
      );

      return {
        user: userToDTO(user),
        tokens: jwtTokens,
        frontendRedirectUri: stateData.redirectUri,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      authMetrics.loginAttempts.inc({ provider: provider.providerId, status: 'failure' });

      logger.warn(
        {
          eventType: LogEventTypes.AUTH_LOGIN_FAILED,
          provider: provider.providerId,
          error: error instanceof Error ? error.message : 'Unknown error',
          durationMs,
          traceId: getTraceId(),
        },
        'Login failed'
      );

      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    try {
      // Verify refresh token JWT
      const payload = this.tokenService.verifyRefreshToken(refreshToken);

      // Find user
      const user = await this.userRepository.findById(payload.sub);
      if (!user) {
        throw new AuthError('User not found', ErrorCodes.INVALID_REFRESH_TOKEN);
      }

      // Generate new access token
      const accessToken = this.tokenService.generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
      });

      // Log audit event
      await this.logAuditEvent(user.id, 'token_refresh', user.oauthProvider);

      authMetrics.tokenRefreshAttempts.inc({ status: 'success' });

      logger.debug(
        {
          eventType: LogEventTypes.AUTH_TOKEN_REFRESH,
          userId: user.id,
          traceId: getTraceId(),
        },
        'Token refreshed'
      );

      return {
        accessToken,
        expiresIn: 900, // 15 minutes
      };
    } catch (error) {
      authMetrics.tokenRefreshAttempts.inc({ status: 'failure' });
      throw error;
    }
  }

  /**
   * Logout user
   */
  async logout(userId: string, _refreshToken?: string): Promise<void> {
    // Clear refresh token hash from database
    await this.userRepository.update(userId, { refreshTokenHash: null });

    // Log audit event
    const user = await this.userRepository.findById(userId);
    if (user) {
      await this.logAuditEvent(userId, 'logout', user.oauthProvider);
    }

    logger.info(
      {
        eventType: LogEventTypes.AUTH_LOGOUT,
        userId,
        traceId: getTraceId(),
      },
      'User logged out'
    );
  }

  /**
   * Get current user
   */
  async getCurrentUser(userId: string): Promise<UserDTO> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AuthError('User not found', ErrorCodes.UNAUTHORIZED);
    }
    return userToDTO(user);
  }

  /**
   * Log audit event
   */
  private async logAuditEvent(
    userId: string,
    eventType: string,
    oauthProvider: OAuthProvider,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO audit_login_events (user_id, event_type, oauth_provider, trace_id, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, eventType, oauthProvider, getTraceId(), JSON.stringify(metadata)]
      );
    } catch (error) {
      // Don't fail the request if audit logging fails
      logger.error(
        {
          eventType: 'audit.log.failed',
          userId,
          auditEventType: eventType,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to log audit event'
      );
    }
  }
}
