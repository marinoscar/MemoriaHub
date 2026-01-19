import type { AccessTokenPayload, RefreshTokenPayload } from '@memoriahub/shared';

/**
 * Token generation input
 */
export interface GenerateTokenInput {
  /** User ID */
  userId: string;
  /** User email */
  email: string;
}

/**
 * Generated token pair
 */
export interface TokenPair {
  /** JWT access token */
  accessToken: string;
  /** JWT refresh token */
  refreshToken: string;
  /** Access token expiration in seconds */
  expiresIn: number;
}

/**
 * Token service interface (Single Responsibility)
 * Handles JWT generation and verification only
 */
export interface ITokenService {
  /**
   * Generate access and refresh token pair
   * @param input User information
   * @returns Token pair
   */
  generateTokenPair(input: GenerateTokenInput): TokenPair;

  /**
   * Generate a new access token
   * @param input User information
   * @returns Access token
   */
  generateAccessToken(input: GenerateTokenInput): string;

  /**
   * Verify an access token
   * @param token JWT access token
   * @returns Decoded payload
   * @throws AuthError if invalid
   */
  verifyAccessToken(token: string): AccessTokenPayload;

  /**
   * Verify a refresh token
   * @param token JWT refresh token
   * @returns Decoded payload
   * @throws AuthError if invalid
   */
  verifyRefreshToken(token: string): RefreshTokenPayload;

  /**
   * Generate a hash for storing refresh tokens
   * @param token Refresh token
   * @returns Hash string
   */
  hashRefreshToken(token: string): string;

  /**
   * Verify a refresh token against its hash
   * @param token Refresh token
   * @param hash Stored hash
   * @returns Whether they match
   */
  verifyRefreshTokenHash(token: string, hash: string): boolean;
}
