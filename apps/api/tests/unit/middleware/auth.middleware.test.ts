/**
 * Auth Middleware Tests
 *
 * Tests for JWT authentication middleware.
 * Covers required auth, optional auth, token validation, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '../../../src/api/middleware/auth.middleware.js';
import { AuthError } from '../../../src/domain/errors/index.js';

// Mock token service
const mockVerifyAccessToken = vi.fn();
vi.mock('../../../src/services/auth/index.js', () => ({
  tokenService: {
    verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
  },
}));

// Mock logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    AUTH_TOKEN_INVALID: 'auth.token.invalid',
  },
}));

// Mock request context
const mockSetUserId = vi.fn();
vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  setUserId: (...args: unknown[]) => mockSetUserId(...args),
  getTraceId: vi.fn().mockReturnValue('test-trace-id'),
}));

describe('Auth Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      headers: {},
    };
    mockRes = {};
    mockNext = vi.fn();
  });

  describe('authMiddleware (required authentication)', () => {
    it('passes when valid Bearer token provided', () => {
      mockReq.headers = {
        authorization: 'Bearer valid-token',
      };

      mockVerifyAccessToken.mockReturnValue({
        sub: 'user-123',
        email: 'test@example.com',
        role: 'user',
        type: 'access',
      });

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        role: 'user',
      });
      expect(mockSetUserId).toHaveBeenCalledWith('user-123');
    });

    it('attaches role from token to req.user', () => {
      mockReq.headers = {
        authorization: 'Bearer admin-token',
      };

      mockVerifyAccessToken.mockReturnValue({
        sub: 'admin-123',
        email: 'admin@example.com',
        role: 'admin',
        type: 'access',
      });

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toEqual({
        id: 'admin-123',
        email: 'admin@example.com',
        role: 'admin',
      });
    });

    it('calls next with error when no authorization header', () => {
      mockReq.headers = {};

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
      const error = (mockNext as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuthError;
      expect(error.message).toBe('Authorization header required');
    });

    it('calls next with error when authorization header is empty', () => {
      mockReq.headers = {
        authorization: '',
      };

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
    });

    it('calls next with error when not Bearer scheme', () => {
      mockReq.headers = {
        authorization: 'Basic dXNlcjpwYXNz',
      };

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
      const error = (mockNext as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuthError;
      expect(error.message).toBe('Invalid authorization header format');
    });

    it('calls next with error when token is empty after Bearer', () => {
      mockReq.headers = {
        authorization: 'Bearer ',
      };

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
      const error = (mockNext as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuthError;
      expect(error.message).toBe('Token required');
    });

    it('calls next with AuthError when token verification fails', () => {
      mockReq.headers = {
        authorization: 'Bearer invalid-token',
      };

      mockVerifyAccessToken.mockImplementation(() => {
        throw new AuthError('Token expired', 'TOKEN_EXPIRED');
      });

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
      const error = (mockNext as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuthError;
      expect(error.message).toBe('Token expired');
    });

    it('calls next with generic AuthError for unknown verification errors', () => {
      mockReq.headers = {
        authorization: 'Bearer broken-token',
      };

      mockVerifyAccessToken.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
      const error = (mockNext as ReturnType<typeof vi.fn>).mock.calls[0][0] as AuthError;
      expect(error.message).toBe('Authentication failed');
    });

    it('extracts token correctly with extra whitespace', () => {
      mockReq.headers = {
        authorization: 'Bearer   token-with-spaces',
      };

      mockVerifyAccessToken.mockReturnValue({
        sub: 'user-123',
        email: 'test@example.com',
        role: 'user',
        type: 'access',
      });

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      // Token includes the extra spaces - testing actual behavior
      expect(mockVerifyAccessToken).toHaveBeenCalledWith('  token-with-spaces');
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('passes without error when no authorization header', () => {
      mockReq.headers = {};

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toBeUndefined();
    });

    it('passes without error when authorization header is not Bearer', () => {
      mockReq.headers = {
        authorization: 'Basic dXNlcjpwYXNz',
      };

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toBeUndefined();
    });

    it('passes without error when token is empty', () => {
      mockReq.headers = {
        authorization: 'Bearer ',
      };

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toBeUndefined();
    });

    it('attaches user when valid token provided', () => {
      mockReq.headers = {
        authorization: 'Bearer valid-token',
      };

      mockVerifyAccessToken.mockReturnValue({
        sub: 'user-456',
        email: 'optional@example.com',
        role: 'user',
        type: 'access',
      });

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toEqual({
        id: 'user-456',
        email: 'optional@example.com',
        role: 'user',
      });
      expect(mockSetUserId).toHaveBeenCalledWith('user-456');
    });

    it('attaches role when valid token provided', () => {
      mockReq.headers = {
        authorization: 'Bearer admin-token',
      };

      mockVerifyAccessToken.mockReturnValue({
        sub: 'admin-456',
        email: 'admin@example.com',
        role: 'admin',
        type: 'access',
      });

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toEqual({
        id: 'admin-456',
        email: 'admin@example.com',
        role: 'admin',
      });
    });

    it('continues without error when token is invalid', () => {
      mockReq.headers = {
        authorization: 'Bearer invalid-token',
      };

      mockVerifyAccessToken.mockImplementation(() => {
        throw new AuthError('Invalid token', 'INVALID_TOKEN');
      });

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toBeUndefined();
    });

    it('continues without error when token is expired', () => {
      mockReq.headers = {
        authorization: 'Bearer expired-token',
      };

      mockVerifyAccessToken.mockImplementation(() => {
        throw new AuthError('Token expired', 'TOKEN_EXPIRED');
      });

      optionalAuthMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
      expect(mockReq.user).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles case sensitivity in Bearer scheme', () => {
      // Authorization header values are case-insensitive for the scheme
      // but our implementation expects 'Bearer' (capital B)
      mockReq.headers = {
        authorization: 'bearer valid-token',
      };

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      // Should fail because we check for 'Bearer ' specifically
      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
    });

    it('handles authorization header with only Bearer keyword', () => {
      mockReq.headers = {
        authorization: 'Bearer',
      };

      authMiddleware(mockReq as Request, mockRes as Response, mockNext);

      // substring(7) on 'Bearer' (length 6) returns empty string
      expect(mockNext).toHaveBeenCalledWith(expect.any(AuthError));
    });
  });
});
