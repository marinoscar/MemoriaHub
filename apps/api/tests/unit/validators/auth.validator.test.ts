/**
 * Auth Validator Tests
 *
 * Tests for authentication input validation middleware.
 * Covers OAuth provider, callback params, and refresh token validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  validateOAuthProvider,
  validateOAuthCallback,
  validateRefreshToken,
} from '../../../src/api/validators/auth.validator.js';

describe('Auth Validators', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      params: {},
      query: {},
      body: {},
    };
    mockRes = {};
    mockNext = vi.fn();
  });

  describe('validateOAuthProvider', () => {
    it('passes for valid google provider', () => {
      mockReq.params = { provider: 'google' };

      validateOAuthProvider(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid microsoft provider', () => {
      mockReq.params = { provider: 'microsoft' };

      validateOAuthProvider(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes for valid github provider', () => {
      mockReq.params = { provider: 'github' };

      validateOAuthProvider(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error for invalid provider', () => {
      mockReq.params = { provider: 'facebook' };

      validateOAuthProvider(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      }));
    });

    it('calls next with error for empty provider', () => {
      mockReq.params = { provider: '' };

      validateOAuthProvider(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for missing provider', () => {
      mockReq.params = {};

      validateOAuthProvider(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });
  });

  describe('validateOAuthCallback', () => {
    it('passes for valid callback params', () => {
      mockReq.query = {
        code: 'authorization-code-123',
        state: 'csrf-state-token',
      };

      validateOAuthCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error when code is missing', () => {
      mockReq.query = {
        state: 'csrf-state-token',
      };

      validateOAuthCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when state is missing', () => {
      mockReq.query = {
        code: 'authorization-code-123',
      };

      validateOAuthCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when code is empty', () => {
      mockReq.query = {
        code: '',
        state: 'csrf-state-token',
      };

      validateOAuthCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when state is empty', () => {
      mockReq.query = {
        code: 'authorization-code-123',
        state: '',
      };

      validateOAuthCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when both are missing', () => {
      mockReq.query = {};

      validateOAuthCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });
  });

  describe('validateRefreshToken', () => {
    it('passes for valid refresh token', () => {
      mockReq.body = {
        refreshToken: 'valid-refresh-token-jwt',
      };

      validateRefreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error when refreshToken is missing', () => {
      mockReq.body = {};

      validateRefreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when refreshToken is empty', () => {
      mockReq.body = { refreshToken: '' };

      validateRefreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when refreshToken is not a string', () => {
      mockReq.body = { refreshToken: 12345 };

      validateRefreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error when refreshToken is null', () => {
      mockReq.body = { refreshToken: null };

      validateRefreshToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });
  });
});
