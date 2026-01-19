import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { adminMiddleware } from '../../../src/api/middleware/auth.middleware.js';
import { AuthError, ForbiddenError } from '../../../src/domain/errors/index.js';

// Mock the logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    AUTH_TOKEN_INVALID: 'auth.token.invalid',
  },
}));

// Mock request context
vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: vi.fn(() => 'test-trace-id'),
  setUserId: vi.fn(),
}));

describe('adminMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      path: '/api/settings/system',
      method: 'GET',
    };
    mockResponse = {};
    nextFunction = vi.fn();
    vi.clearAllMocks();
  });

  it('allows admin users to proceed', () => {
    mockRequest.user = {
      id: 'user-123',
      email: 'admin@example.com',
      role: 'admin',
    };

    adminMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalledTimes(1);
    expect(nextFunction).toHaveBeenCalledWith();
  });

  it('rejects non-admin users with 403 ForbiddenError', () => {
    mockRequest.user = {
      id: 'user-456',
      email: 'user@example.com',
      role: 'user',
    };

    adminMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalledTimes(1);
    const error = (nextFunction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.message).toBe('Admin access required');
  });

  it('rejects unauthenticated requests with 401 AuthError', () => {
    // No user attached to request
    mockRequest.user = undefined;

    adminMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(nextFunction).toHaveBeenCalledTimes(1);
    const error = (nextFunction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toBe('Authentication required');
  });

  it('logs warning for denied admin access attempts', async () => {
    const { logger } = await import('../../../src/infrastructure/logging/logger.js');

    mockRequest.user = {
      id: 'user-789',
      email: 'regular@example.com',
      role: 'user',
    };

    adminMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth.admin.denied',
        userId: 'user-789',
        role: 'user',
        path: '/api/settings/system',
        method: 'GET',
      }),
      'Non-admin user attempted admin action'
    );
  });

  it('logs debug message for verified admin access', async () => {
    const { logger } = await import('../../../src/infrastructure/logging/logger.js');

    mockRequest.user = {
      id: 'admin-123',
      email: 'admin@example.com',
      role: 'admin',
    };

    adminMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth.admin.verified',
        userId: 'admin-123',
      }),
      'Admin access verified'
    );
  });
});
