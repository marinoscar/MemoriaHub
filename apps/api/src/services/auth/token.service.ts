import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { AccessTokenPayload, RefreshTokenPayload } from '@memoriahub/shared';
import { ErrorCodes } from '@memoriahub/shared';
import type { ITokenService, GenerateTokenInput, TokenPair } from '../../interfaces/index.js';
import { jwtConfig } from '../../config/index.js';
import { AuthError } from '../../domain/errors/index.js';
import { logger } from '../../infrastructure/logging/logger.js';

/**
 * JWT token service implementation
 * Single Responsibility: Only handles JWT operations
 */
export class TokenService implements ITokenService {
  private readonly secret: string;
  private readonly accessTokenExpiry: string;
  private readonly refreshTokenExpiry: string;
  private readonly issuer: string;
  private readonly audience: string;

  constructor() {
    this.secret = jwtConfig.secret;
    this.accessTokenExpiry = jwtConfig.accessTokenExpiresIn;
    this.refreshTokenExpiry = jwtConfig.refreshTokenExpiresIn;
    this.issuer = jwtConfig.issuer;
    this.audience = jwtConfig.audience;
  }

  generateTokenPair(input: GenerateTokenInput): TokenPair {
    const accessToken = this.generateAccessToken(input);
    const refreshToken = this.generateRefreshToken(input.userId);

    // Parse expiry to get seconds
    const expiresIn = this.parseExpiryToSeconds(this.accessTokenExpiry);

    return {
      accessToken,
      refreshToken,
      expiresIn,
    };
  }

  generateAccessToken(input: GenerateTokenInput): string {
    const payload = {
      sub: input.userId,
      email: input.email,
      type: 'access' as const,
    };

    return jwt.sign(payload, this.secret, {
      expiresIn: this.accessTokenExpiry,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  private generateRefreshToken(userId: string): string {
    const payload = {
      sub: userId,
      type: 'refresh' as const,
      jti: uuidv4(), // Unique token ID for revocation
    };

    return jwt.sign(payload, this.secret, {
      expiresIn: this.refreshTokenExpiry,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const payload = jwt.verify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
      }) as AccessTokenPayload;

      if (payload.type !== 'access') {
        throw new AuthError('Invalid token type', ErrorCodes.INVALID_TOKEN);
      }

      return payload;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (error instanceof jwt.TokenExpiredError) {
        logger.debug({ eventType: 'auth.token.expired' }, 'Access token expired');
        throw new AuthError('Token expired', ErrorCodes.TOKEN_EXPIRED);
      }

      if (error instanceof jwt.JsonWebTokenError) {
        logger.debug({ eventType: 'auth.token.invalid', error: error.message }, 'Invalid token');
        throw new AuthError('Invalid token', ErrorCodes.INVALID_TOKEN);
      }

      throw new AuthError('Token verification failed', ErrorCodes.INVALID_TOKEN);
    }
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      const payload = jwt.verify(token, this.secret, {
        issuer: this.issuer,
        audience: this.audience,
      }) as RefreshTokenPayload;

      if (payload.type !== 'refresh') {
        throw new AuthError('Invalid token type', ErrorCodes.INVALID_REFRESH_TOKEN);
      }

      return payload;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (error instanceof jwt.TokenExpiredError) {
        logger.debug({ eventType: 'auth.refresh.expired' }, 'Refresh token expired');
        throw new AuthError('Refresh token expired', ErrorCodes.INVALID_REFRESH_TOKEN);
      }

      if (error instanceof jwt.JsonWebTokenError) {
        logger.debug({ eventType: 'auth.refresh.invalid', error: error.message }, 'Invalid refresh token');
        throw new AuthError('Invalid refresh token', ErrorCodes.INVALID_REFRESH_TOKEN);
      }

      throw new AuthError('Refresh token verification failed', ErrorCodes.INVALID_REFRESH_TOKEN);
    }
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  verifyRefreshTokenHash(token: string, hash: string): boolean {
    const computedHash = this.hashRefreshToken(token);
    return computedHash === hash;
  }

  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
      return 900; // Default 15 minutes
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 900;
    }
  }
}

// Export singleton instance
export const tokenService = new TokenService();
