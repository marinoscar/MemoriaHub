/**
 * Token Service Tests
 *
 * Tests for JWT token generation, verification, and hashing.
 * Covers access tokens, refresh tokens, expiry handling, and security.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService } from '../../../../src/services/auth/token.service.js';
import { AuthError } from '../../../../src/domain/errors/index.js';

// Mock JWT config
vi.mock('../../../../src/config/index.js', () => ({
  jwtConfig: {
    secret: 'test-jwt-secret-for-testing-only',
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    issuer: 'memoriahub-test',
    audience: 'memoriahub-test',
  },
}));

// Mock logger
vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('TokenService', () => {
  let tokenService: TokenService;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenService = new TokenService();
  });

  describe('generateTokenPair', () => {
    it('generates both access and refresh tokens', () => {
      const input = {
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      };

      const result = tokenService.generateTokenPair(input);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.expiresIn).toBe(900); // 15 minutes in seconds
      expect(result.accessToken).not.toBe(result.refreshToken);
    });

    it('creates valid JWT tokens that can be decoded', () => {
      const input = {
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      };

      const result = tokenService.generateTokenPair(input);

      const accessPayload = jwt.decode(result.accessToken) as jwt.JwtPayload;
      expect(accessPayload.sub).toBe('user-123');
      expect(accessPayload.email).toBe('test@example.com');
      expect(accessPayload.type).toBe('access');
      expect(accessPayload.role).toBe('user');

      const refreshPayload = jwt.decode(result.refreshToken) as jwt.JwtPayload;
      expect(refreshPayload.sub).toBe('user-123');
      expect(refreshPayload.type).toBe('refresh');
      expect(refreshPayload.jti).toBeDefined(); // Unique token ID
    });

    it('includes role in access token payload', () => {
      const input = {
        userId: 'admin-123',
        email: 'admin@example.com',
        role: 'admin' as const,
      };

      const result = tokenService.generateTokenPair(input);

      const accessPayload = jwt.decode(result.accessToken) as jwt.JwtPayload;
      expect(accessPayload.role).toBe('admin');
    });
  });

  describe('generateAccessToken', () => {
    it('generates a valid access token', () => {
      const input = {
        userId: 'user-456',
        email: 'another@example.com',
        role: 'user' as const,
      };

      const token = tokenService.generateAccessToken(input);

      expect(token).toBeDefined();
      const payload = jwt.decode(token) as jwt.JwtPayload;
      expect(payload.sub).toBe('user-456');
      expect(payload.email).toBe('another@example.com');
      expect(payload.type).toBe('access');
      expect(payload.role).toBe('user');
      expect(payload.iss).toBe('memoriahub-test');
      expect(payload.aud).toBe('memoriahub-test');
    });

    it('includes role in payload', () => {
      const token = tokenService.generateAccessToken({
        userId: 'admin-123',
        email: 'admin@example.com',
        role: 'admin' as const,
      });

      const payload = jwt.decode(token) as jwt.JwtPayload;
      expect(payload.role).toBe('admin');
    });

    it('includes expiration time', () => {
      const token = tokenService.generateAccessToken({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      });

      const payload = jwt.decode(token) as jwt.JwtPayload;
      expect(payload.exp).toBeDefined();
      expect(payload.iat).toBeDefined();
      expect(payload.exp! - payload.iat!).toBe(900); // 15 minutes
    });
  });

  describe('verifyAccessToken', () => {
    it('verifies and returns payload for valid access token', () => {
      const token = tokenService.generateAccessToken({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      });

      const payload = tokenService.verifyAccessToken(token);

      expect(payload.sub).toBe('user-123');
      expect(payload.email).toBe('test@example.com');
      expect(payload.type).toBe('access');
      expect(payload.role).toBe('user');
    });

    it('returns role from payload for admin user', () => {
      const token = tokenService.generateAccessToken({
        userId: 'admin-123',
        email: 'admin@example.com',
        role: 'admin' as const,
      });

      const payload = tokenService.verifyAccessToken(token);

      expect(payload.role).toBe('admin');
    });

    it('throws AuthError for expired token', () => {
      // Create an expired token
      const expiredToken = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', type: 'access' },
        'test-jwt-secret-for-testing-only',
        { expiresIn: '-1h', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      expect(() => tokenService.verifyAccessToken(expiredToken)).toThrow(AuthError);
      expect(() => tokenService.verifyAccessToken(expiredToken)).toThrow('Token expired');
    });

    it('throws AuthError for invalid signature', () => {
      const invalidToken = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', type: 'access' },
        'wrong-secret',
        { expiresIn: '1h', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      expect(() => tokenService.verifyAccessToken(invalidToken)).toThrow(AuthError);
      expect(() => tokenService.verifyAccessToken(invalidToken)).toThrow('Invalid token');
    });

    it('throws AuthError for malformed token', () => {
      expect(() => tokenService.verifyAccessToken('not-a-jwt')).toThrow(AuthError);
      expect(() => tokenService.verifyAccessToken('')).toThrow(AuthError);
    });

    it('throws AuthError when token type is not access', () => {
      // Create a refresh token and try to verify as access
      const refreshToken = jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'token-id' },
        'test-jwt-secret-for-testing-only',
        { expiresIn: '7d', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      expect(() => tokenService.verifyAccessToken(refreshToken)).toThrow(AuthError);
      expect(() => tokenService.verifyAccessToken(refreshToken)).toThrow('Invalid token type');
    });

    it('throws AuthError for wrong issuer', () => {
      const token = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', type: 'access' },
        'test-jwt-secret-for-testing-only',
        { expiresIn: '1h', issuer: 'wrong-issuer', audience: 'memoriahub-test' }
      );

      expect(() => tokenService.verifyAccessToken(token)).toThrow(AuthError);
    });

    it('throws AuthError for wrong audience', () => {
      const token = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', type: 'access' },
        'test-jwt-secret-for-testing-only',
        { expiresIn: '1h', issuer: 'memoriahub-test', audience: 'wrong-audience' }
      );

      expect(() => tokenService.verifyAccessToken(token)).toThrow(AuthError);
    });
  });

  describe('verifyRefreshToken', () => {
    it('verifies and returns payload for valid refresh token', () => {
      const pair = tokenService.generateTokenPair({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      });

      const payload = tokenService.verifyRefreshToken(pair.refreshToken);

      expect(payload.sub).toBe('user-123');
      expect(payload.type).toBe('refresh');
      expect(payload.jti).toBeDefined();
    });

    it('throws AuthError for expired refresh token', () => {
      const expiredToken = jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'token-id' },
        'test-jwt-secret-for-testing-only',
        { expiresIn: '-1h', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      expect(() => tokenService.verifyRefreshToken(expiredToken)).toThrow(AuthError);
      expect(() => tokenService.verifyRefreshToken(expiredToken)).toThrow('Refresh token expired');
    });

    it('throws AuthError when token type is not refresh', () => {
      const accessToken = tokenService.generateAccessToken({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      });

      expect(() => tokenService.verifyRefreshToken(accessToken)).toThrow(AuthError);
      expect(() => tokenService.verifyRefreshToken(accessToken)).toThrow('Invalid token type');
    });

    it('throws AuthError for invalid signature', () => {
      const invalidToken = jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'token-id' },
        'wrong-secret',
        { expiresIn: '7d', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      expect(() => tokenService.verifyRefreshToken(invalidToken)).toThrow(AuthError);
    });
  });

  describe('hashRefreshToken', () => {
    it('returns SHA256 hash of token', () => {
      const token = 'my-refresh-token';
      const hash = tokenService.hashRefreshToken(token);

      expect(hash).toHaveLength(64); // SHA256 hex = 64 chars
      expect(hash).toMatch(/^[a-f0-9]+$/); // Only hex chars
    });

    it('produces consistent hash for same token', () => {
      const token = 'consistent-token';

      const hash1 = tokenService.hashRefreshToken(token);
      const hash2 = tokenService.hashRefreshToken(token);

      expect(hash1).toBe(hash2);
    });

    it('produces different hash for different tokens', () => {
      const hash1 = tokenService.hashRefreshToken('token-1');
      const hash2 = tokenService.hashRefreshToken('token-2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyRefreshTokenHash', () => {
    it('returns true for matching token and hash', () => {
      const token = 'my-refresh-token';
      const hash = tokenService.hashRefreshToken(token);

      expect(tokenService.verifyRefreshTokenHash(token, hash)).toBe(true);
    });

    it('returns false for non-matching token and hash', () => {
      const token = 'my-refresh-token';
      const wrongHash = tokenService.hashRefreshToken('different-token');

      expect(tokenService.verifyRefreshTokenHash(token, wrongHash)).toBe(false);
    });
  });

  describe('parseExpiryToSeconds (private method - tested via generateTokenPair)', () => {
    it('correctly parses minutes', () => {
      const result = tokenService.generateTokenPair({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      });

      // Default is 15m = 900 seconds
      expect(result.expiresIn).toBe(900);
    });
  });

  describe('security considerations', () => {
    it('does not include sensitive data in token payload', () => {
      const token = tokenService.generateAccessToken({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user' as const,
      });

      const payload = jwt.decode(token) as Record<string, unknown>;

      // Should not include password, refresh token, etc.
      expect(payload).not.toHaveProperty('password');
      expect(payload).not.toHaveProperty('refreshToken');
      expect(payload).not.toHaveProperty('secret');
    });

    it('generates unique jti for each refresh token', () => {
      const pair1 = tokenService.generateTokenPair({ userId: 'user-123', email: 'a@b.com', role: 'user' as const });
      const pair2 = tokenService.generateTokenPair({ userId: 'user-123', email: 'a@b.com', role: 'user' as const });

      const payload1 = jwt.decode(pair1.refreshToken) as jwt.JwtPayload;
      const payload2 = jwt.decode(pair2.refreshToken) as jwt.JwtPayload;

      expect(payload1.jti).not.toBe(payload2.jti);
    });
  });
});
