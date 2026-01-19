/**
 * Auth Controller Tests
 *
 * Tests for authentication HTTP endpoints.
 * Covers providers listing, OAuth flow, token refresh, and logout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { AuthController } from '../../../src/api/controllers/auth.controller.js';
import { AuthError } from '../../../src/domain/errors/index.js';

// Mock auth service
const mockInitiateOAuth = vi.fn();
const mockHandleOAuthCallback = vi.fn();
const mockRefreshToken = vi.fn();
const mockLogout = vi.fn();
const mockGetCurrentUser = vi.fn();

vi.mock('../../../src/services/auth/index.js', () => ({
  authService: {
    initiateOAuth: (...args: unknown[]) => mockInitiateOAuth(...args),
    handleOAuthCallback: (...args: unknown[]) => mockHandleOAuthCallback(...args),
    refreshToken: (...args: unknown[]) => mockRefreshToken(...args),
    logout: (...args: unknown[]) => mockLogout(...args),
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
  },
  getOAuthProvider: vi.fn().mockImplementation((providerId: string) => {
    if (providerId === 'google') {
      return {
        providerId: 'google',
        providerName: 'Google',
        isEnabled: true,
      };
    }
    throw new Error(`Unknown provider: ${providerId}`);
  }),
  getAvailableProviders: vi.fn().mockReturnValue([
    { id: 'google', name: 'Google', enabled: true },
  ]),
}));

// Mock OAuth config
vi.mock('../../../src/config/index.js', () => ({
  oauthConfig: {
    frontendUrl: 'http://localhost:5173',
  },
}));

describe('AuthController', () => {
  let controller: AuthController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    controller = new AuthController();

    mockReq = {
      params: {},
      query: {},
      body: {},
      user: undefined,
    };

    mockRes = {
      json: vi.fn().mockReturnThis(),
      redirect: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();
  });

  describe('getProviders', () => {
    it('returns list of available OAuth providers', async () => {
      await controller.getProviders(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith({
        data: [{ id: 'google', name: 'Google', enabled: true }],
      });
    });
  });

  describe('initiateOAuth', () => {
    it('redirects to OAuth provider authorization URL', async () => {
      mockReq.params = { provider: 'google' };

      mockInitiateOAuth.mockReturnValue({
        authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=...',
        state: 'random-state',
      });

      await controller.initiateOAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/auth?client_id=...'
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('passes custom redirect URI to service', async () => {
      mockReq.params = { provider: 'google' };
      mockReq.query = { redirect_uri: 'http://custom.app/callback' };

      mockInitiateOAuth.mockReturnValue({
        authUrl: 'https://accounts.google.com/o/oauth2/auth?...',
        state: 'random-state',
      });

      await controller.initiateOAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockInitiateOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'google' }),
        'http://custom.app/callback'
      );
    });

    it('calls next with error for unknown provider', async () => {
      mockReq.params = { provider: 'unknown' };

      const { getOAuthProvider } = await import('../../../src/services/auth/index.js');
      vi.mocked(getOAuthProvider).mockImplementation(() => {
        throw new Error('Unknown provider');
      });

      await controller.initiateOAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('handleCallback', () => {
    it('redirects to frontend with tokens on success', async () => {
      mockReq.params = { provider: 'google' };
      mockReq.query = { code: 'auth-code', state: 'csrf-state' };

      mockHandleOAuthCallback.mockResolvedValue({
        user: { id: 'user-123', email: 'test@example.com' },
        tokens: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresIn: 900,
        },
        frontendRedirectUri: 'http://localhost:5173',
      });

      await controller.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:5173/auth/callback')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('access_token=access-token')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('refresh_token=refresh-token')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('expires_in=900')
      );
    });

    it('redirects to frontend with error when provider returns error', async () => {
      mockReq.params = { provider: 'google' };
      mockReq.query = {
        error: 'access_denied',
        error_description: 'User denied access',
      };

      await controller.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:5173/auth/callback')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('error=User%20denied%20access')
      );
      expect(mockHandleOAuthCallback).not.toHaveBeenCalled();
    });

    it('redirects to frontend with error on service failure', async () => {
      mockReq.params = { provider: 'google' };
      mockReq.query = { code: 'invalid-code', state: 'csrf-state' };

      mockHandleOAuthCallback.mockRejectedValue(new AuthError('Invalid state', 'INVALID_STATE'));

      await controller.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:5173/auth/callback')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('error=Invalid%20state')
      );
    });

    it('uses error code when error_description not provided', async () => {
      mockReq.params = { provider: 'google' };
      mockReq.query = {
        error: 'access_denied',
      };

      await controller.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('error=access_denied')
      );
    });
  });

  describe('refreshToken', () => {
    it('returns new access token for valid refresh token', async () => {
      mockReq.body = { refreshToken: 'valid-refresh-token' };

      mockRefreshToken.mockResolvedValue({
        accessToken: 'new-access-token',
        expiresIn: 900,
      });

      await controller.refreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({
        data: {
          accessToken: 'new-access-token',
          tokenType: 'Bearer',
          expiresIn: 900,
        },
      });
    });

    it('calls next with error for invalid refresh token', async () => {
      mockReq.body = { refreshToken: 'invalid-refresh-token' };

      mockRefreshToken.mockRejectedValue(new AuthError('Invalid refresh token', 'INVALID_REFRESH_TOKEN'));

      await controller.refreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
    });
  });

  describe('logout', () => {
    it('logs out authenticated user', async () => {
      mockReq.user = { id: 'user-123', email: 'test@example.com' };
      mockReq.body = { refreshToken: 'refresh-token' };

      mockLogout.mockResolvedValue(undefined);

      await controller.logout(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLogout).toHaveBeenCalledWith('user-123', 'refresh-token');
      expect(mockRes.json).toHaveBeenCalledWith({
        data: { message: 'Logged out successfully' },
      });
    });

    it('returns 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.logout(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('handles logout without refresh token', async () => {
      mockReq.user = { id: 'user-123', email: 'test@example.com' };
      mockReq.body = {};

      mockLogout.mockResolvedValue(undefined);

      await controller.logout(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLogout).toHaveBeenCalledWith('user-123', undefined);
    });

    it('calls next with error on service failure', async () => {
      mockReq.user = { id: 'user-123', email: 'test@example.com' };

      mockLogout.mockRejectedValue(new Error('Database error'));

      await controller.logout(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getCurrentUser', () => {
    it('returns current user for authenticated request', async () => {
      mockReq.user = { id: 'user-123', email: 'test@example.com' };

      mockGetCurrentUser.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.jpg',
        oauthProvider: 'google',
        emailVerified: true,
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      await controller.getCurrentUser(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetCurrentUser).toHaveBeenCalledWith('user-123');
      expect(mockRes.json).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'user-123',
          email: 'test@example.com',
        }),
      });
    });

    it('returns 401 when not authenticated', async () => {
      mockReq.user = undefined;

      await controller.getCurrentUser(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      });
      expect(mockGetCurrentUser).not.toHaveBeenCalled();
    });

    it('calls next with error on service failure', async () => {
      mockReq.user = { id: 'nonexistent-user', email: 'test@example.com' };

      mockGetCurrentUser.mockRejectedValue(new AuthError('User not found', 'UNAUTHORIZED'));

      await controller.getCurrentUser(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
    });
  });
});
