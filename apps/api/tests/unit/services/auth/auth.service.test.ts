/**
 * Auth Service Tests
 *
 * Tests for the authentication orchestration service.
 * Covers OAuth flow, token refresh, logout, and audit logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../../../../src/services/auth/auth.service.js';
import type { IUserRepository, ITokenService, IOAuthProvider, TokenPair } from '../../../../src/interfaces/index.js';
import type { User } from '@memoriahub/shared';
import { AuthError } from '../../../../src/domain/errors/index.js';

// Mock the database query for audit logging
vi.mock('../../../../src/infrastructure/database/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

// Mock logger
vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    AUTH_LOGIN_STARTED: 'auth.login.started',
    AUTH_LOGIN_SUCCESS: 'auth.login.success',
    AUTH_LOGIN_FAILED: 'auth.login.failed',
    AUTH_TOKEN_REFRESH: 'auth.token.refresh',
    AUTH_LOGOUT: 'auth.logout',
  },
}));

// Mock request context
vi.mock('../../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: vi.fn().mockReturnValue('test-trace-id'),
}));

// Mock metrics
vi.mock('../../../../src/infrastructure/telemetry/metrics.js', () => ({
  authMetrics: {
    loginAttempts: { inc: vi.fn() },
    loginDuration: { observe: vi.fn() },
    tokenRefreshAttempts: { inc: vi.fn() },
  },
}));

// Mock OAuth config
vi.mock('../../../../src/config/index.js', () => ({
  oauthConfig: {
    stateTtlMs: 600000, // 10 minutes
    frontendUrl: 'http://localhost:5173',
    google: {
      redirectUri: 'http://localhost:3000/api/auth/google/callback',
    },
  },
}));

describe('AuthService', () => {
  let authService: AuthService;
  let mockUserRepository: IUserRepository;
  let mockTokenService: ITokenService;
  let mockOAuthProvider: IOAuthProvider;

  const mockUser: User = {
    id: 'user-123',
    oauthProvider: 'google',
    oauthSubject: 'google-subject-456',
    email: 'test@example.com',
    emailVerified: true,
    displayName: 'Test User',
    avatarUrl: 'https://example.com/avatar.jpg',
    role: 'user',
    refreshTokenHash: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  };

  const mockAdminUser: User = {
    id: 'admin-123',
    oauthProvider: 'google',
    oauthSubject: 'google-admin-456',
    email: 'admin@example.com',
    emailVerified: true,
    displayName: 'Admin User',
    avatarUrl: 'https://example.com/admin-avatar.jpg',
    role: 'admin',
    refreshTokenHash: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
  };

  const mockTokenPair: TokenPair = {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresIn: 900,
  };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock user repository
    mockUserRepository = {
      findById: vi.fn(),
      findByOAuthIdentity: vi.fn(),
      findByEmail: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findOrCreate: vi.fn(),
    };

    // Create mock token service
    mockTokenService = {
      generateTokenPair: vi.fn().mockReturnValue(mockTokenPair),
      generateAccessToken: vi.fn().mockReturnValue('mock-access-token'),
      verifyAccessToken: vi.fn(),
      verifyRefreshToken: vi.fn(),
      hashRefreshToken: vi.fn().mockReturnValue('hashed-refresh-token'),
      verifyRefreshTokenHash: vi.fn(),
    };

    // Create mock OAuth provider
    mockOAuthProvider = {
      providerId: 'google',
      providerName: 'Google',
      isEnabled: true,
      getAuthorizationUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?...'),
      exchangeCodeForTokens: vi.fn(),
      getUserInfo: vi.fn(),
      revokeToken: vi.fn(),
    };

    authService = new AuthService(mockUserRepository, mockTokenService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initiateOAuth', () => {
    it('generates authorization URL with state token', () => {
      const result = authService.initiateOAuth(mockOAuthProvider);

      expect(result.authUrl).toBe('https://accounts.google.com/o/oauth2/auth?...');
      expect(result.state).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(mockOAuthProvider.getAuthorizationUrl).toHaveBeenCalledWith(
        result.state,
        'http://localhost:3000/api/auth/google/callback'
      );
    });

    it('uses custom frontend redirect URI when provided', () => {
      const customRedirectUri = 'http://localhost:8080/callback';
      const result = authService.initiateOAuth(mockOAuthProvider, customRedirectUri);

      expect(result.state).toHaveLength(64);
      // The state is stored with the custom redirect URI
    });

    it('generates unique state tokens for each call', () => {
      const result1 = authService.initiateOAuth(mockOAuthProvider);
      const result2 = authService.initiateOAuth(mockOAuthProvider);

      expect(result1.state).not.toBe(result2.state);
    });
  });

  describe('handleOAuthCallback', () => {
    it('authenticates user successfully with valid state and code', async () => {
      // Initiate OAuth to create state
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      // Mock provider responses
      const mockOAuthTokens = {
        accessToken: 'google-access-token',
        refreshToken: 'google-refresh-token',
        idToken: 'google-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const mockUserInfo = {
        subject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.jpg',
        rawPayload: {},
      };

      vi.mocked(mockOAuthProvider.exchangeCodeForTokens).mockResolvedValue(mockOAuthTokens);
      vi.mocked(mockOAuthProvider.getUserInfo).mockResolvedValue(mockUserInfo);
      vi.mocked(mockUserRepository.findOrCreate).mockResolvedValue({ user: mockUser, created: false });
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);

      const result = await authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state);

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe('test@example.com');
      expect(result.tokens).toEqual(mockTokenPair);
      expect(result.frontendRedirectUri).toBe('http://localhost:5173');
    });

    it('throws error for invalid state', async () => {
      await expect(
        authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', 'invalid-state')
      ).rejects.toThrow(AuthError);

      await expect(
        authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', 'invalid-state')
      ).rejects.toThrow('Invalid or expired state');
    });

    it('throws error for expired state', async () => {
      vi.useFakeTimers();

      // Initiate OAuth to create state
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      // Advance time past state TTL (10 minutes + 1 second)
      vi.advanceTimersByTime(600001);

      await expect(
        authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state)
      ).rejects.toThrow('State expired');
    });

    it('deletes state after successful use (prevents replay)', async () => {
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      const mockOAuthTokens = {
        accessToken: 'google-access-token',
        idToken: 'google-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const mockUserInfo = {
        subject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
        rawPayload: {},
      };

      vi.mocked(mockOAuthProvider.exchangeCodeForTokens).mockResolvedValue(mockOAuthTokens);
      vi.mocked(mockOAuthProvider.getUserInfo).mockResolvedValue(mockUserInfo);
      vi.mocked(mockUserRepository.findOrCreate).mockResolvedValue({ user: mockUser, created: false });
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);

      // First call should succeed
      await authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state);

      // Second call with same state should fail
      await expect(
        authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state)
      ).rejects.toThrow('Invalid or expired state');
    });

    it('creates new user when not found', async () => {
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      const mockOAuthTokens = {
        accessToken: 'google-access-token',
        idToken: 'google-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const mockUserInfo = {
        subject: 'new-user-subject',
        email: 'newuser@example.com',
        emailVerified: true,
        displayName: 'New User',
        rawPayload: {},
      };

      vi.mocked(mockOAuthProvider.exchangeCodeForTokens).mockResolvedValue(mockOAuthTokens);
      vi.mocked(mockOAuthProvider.getUserInfo).mockResolvedValue(mockUserInfo);
      vi.mocked(mockUserRepository.findOrCreate).mockResolvedValue({
        user: { ...mockUser, id: 'new-user-id', email: 'newuser@example.com' },
        created: true,
      });
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);

      const result = await authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state);

      expect(result.user.email).toBe('newuser@example.com');
      expect(mockUserRepository.findOrCreate).toHaveBeenCalledWith({
        oauthProvider: 'google',
        oauthSubject: 'new-user-subject',
        email: 'newuser@example.com',
        emailVerified: true,
        displayName: 'New User',
        avatarUrl: undefined,
      });
    });

    it('stores hashed refresh token for user', async () => {
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      const mockOAuthTokens = {
        accessToken: 'google-access-token',
        idToken: 'google-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const mockUserInfo = {
        subject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
        rawPayload: {},
      };

      vi.mocked(mockOAuthProvider.exchangeCodeForTokens).mockResolvedValue(mockOAuthTokens);
      vi.mocked(mockOAuthProvider.getUserInfo).mockResolvedValue(mockUserInfo);
      vi.mocked(mockUserRepository.findOrCreate).mockResolvedValue({ user: mockUser, created: false });
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);

      await authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state);

      expect(mockTokenService.hashRefreshToken).toHaveBeenCalledWith('mock-refresh-token');
      expect(mockUserRepository.update).toHaveBeenCalledWith('user-123', {
        refreshTokenHash: 'hashed-refresh-token',
      });
    });

    it('passes user role to token generation', async () => {
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      const mockOAuthTokens = {
        accessToken: 'google-access-token',
        idToken: 'google-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const mockUserInfo = {
        subject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
        rawPayload: {},
      };

      vi.mocked(mockOAuthProvider.exchangeCodeForTokens).mockResolvedValue(mockOAuthTokens);
      vi.mocked(mockOAuthProvider.getUserInfo).mockResolvedValue(mockUserInfo);
      vi.mocked(mockUserRepository.findOrCreate).mockResolvedValue({ user: mockUser, created: false });
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);

      await authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state);

      expect(mockTokenService.generateTokenPair).toHaveBeenCalledWith({
        userId: 'user-123',
        email: 'test@example.com',
        role: 'user',
      });
    });

    it('passes admin role to token generation for admin user', async () => {
      const { state } = authService.initiateOAuth(mockOAuthProvider);

      const mockOAuthTokens = {
        accessToken: 'google-access-token',
        idToken: 'google-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      };

      const mockUserInfo = {
        subject: 'google-admin-456',
        email: 'admin@example.com',
        emailVerified: true,
        rawPayload: {},
      };

      vi.mocked(mockOAuthProvider.exchangeCodeForTokens).mockResolvedValue(mockOAuthTokens);
      vi.mocked(mockOAuthProvider.getUserInfo).mockResolvedValue(mockUserInfo);
      vi.mocked(mockUserRepository.findOrCreate).mockResolvedValue({ user: mockAdminUser, created: false });
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockAdminUser);

      await authService.handleOAuthCallback(mockOAuthProvider, 'auth-code', state);

      expect(mockTokenService.generateTokenPair).toHaveBeenCalledWith({
        userId: 'admin-123',
        email: 'admin@example.com',
        role: 'admin',
      });
    });
  });

  describe('refreshToken', () => {
    it('generates new access token for valid refresh token', async () => {
      vi.mocked(mockTokenService.verifyRefreshToken).mockReturnValue({
        sub: 'user-123',
        type: 'refresh',
        jti: 'token-id',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'memoriahub',
        aud: 'memoriahub',
      });
      vi.mocked(mockUserRepository.findById).mockResolvedValue(mockUser);
      vi.mocked(mockTokenService.generateAccessToken).mockReturnValue('new-access-token');

      const result = await authService.refreshToken('valid-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      expect(result.expiresIn).toBe(900);
      expect(mockTokenService.verifyRefreshToken).toHaveBeenCalledWith('valid-refresh-token');
    });

    it('generates new access token with correct role', async () => {
      vi.mocked(mockTokenService.verifyRefreshToken).mockReturnValue({
        sub: 'admin-123',
        type: 'refresh',
        jti: 'token-id',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'memoriahub',
        aud: 'memoriahub',
      });
      vi.mocked(mockUserRepository.findById).mockResolvedValue(mockAdminUser);
      vi.mocked(mockTokenService.generateAccessToken).mockReturnValue('new-admin-access-token');

      await authService.refreshToken('valid-refresh-token');

      expect(mockTokenService.generateAccessToken).toHaveBeenCalledWith({
        userId: 'admin-123',
        email: 'admin@example.com',
        role: 'admin',
      });
    });

    it('throws error for invalid refresh token', async () => {
      vi.mocked(mockTokenService.verifyRefreshToken).mockImplementation(() => {
        throw new AuthError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
      });

      await expect(authService.refreshToken('invalid-token')).rejects.toThrow('Invalid refresh token');
    });

    it('throws error when user not found', async () => {
      vi.mocked(mockTokenService.verifyRefreshToken).mockReturnValue({
        sub: 'nonexistent-user',
        type: 'refresh',
        jti: 'token-id',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'memoriahub',
        aud: 'memoriahub',
      });
      vi.mocked(mockUserRepository.findById).mockResolvedValue(null);

      await expect(authService.refreshToken('valid-refresh-token')).rejects.toThrow('User not found');
    });
  });

  describe('logout', () => {
    it('clears refresh token hash from database', async () => {
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);
      vi.mocked(mockUserRepository.findById).mockResolvedValue(mockUser);

      await authService.logout('user-123');

      expect(mockUserRepository.update).toHaveBeenCalledWith('user-123', {
        refreshTokenHash: null,
      });
    });

    it('logs audit event for logout', async () => {
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);
      vi.mocked(mockUserRepository.findById).mockResolvedValue(mockUser);

      await authService.logout('user-123');

      // Verify audit logging was called (mocked query)
      const { query } = await import('../../../../src/infrastructure/database/client.js');
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_login_events'),
        expect.arrayContaining(['user-123', 'logout', 'google'])
      );
    });

    it('handles logout when user not found gracefully', async () => {
      vi.mocked(mockUserRepository.update).mockResolvedValue(mockUser);
      vi.mocked(mockUserRepository.findById).mockResolvedValue(null);

      // Should not throw
      await expect(authService.logout('nonexistent-user')).resolves.toBeUndefined();
    });
  });

  describe('getCurrentUser', () => {
    it('returns user DTO for valid user ID', async () => {
      vi.mocked(mockUserRepository.findById).mockResolvedValue(mockUser);

      const result = await authService.getCurrentUser('user-123');

      // UserDTO includes: id, email, displayName, avatarUrl, oauthProvider, role, createdAt
      expect(result).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.jpg',
        oauthProvider: 'google',
        role: 'user',
        createdAt: expect.any(String),
      });
    });

    it('returns admin role in DTO for admin user', async () => {
      vi.mocked(mockUserRepository.findById).mockResolvedValue(mockAdminUser);

      const result = await authService.getCurrentUser('admin-123');

      expect(result.role).toBe('admin');
    });

    it('throws error when user not found', async () => {
      vi.mocked(mockUserRepository.findById).mockResolvedValue(null);

      await expect(authService.getCurrentUser('nonexistent-user')).rejects.toThrow('User not found');
    });
  });
});
