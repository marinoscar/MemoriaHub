/**
 * Error Middleware Tests
 *
 * Tests for global error handling middleware.
 * Covers application errors, validation errors, and unknown errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { ZodError, z } from 'zod';
import { errorMiddleware, notFoundHandler } from '../../../src/api/middleware/error.middleware.js';
import { AuthError, ValidationError, NotFoundError, ForbiddenError } from '../../../src/domain/errors/index.js';

// Mock logger
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
  LogEventTypes: {
    HTTP_REQUEST_ERROR: 'http.request.error',
  },
}));

// Mock request context
vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  getRequestId: vi.fn().mockReturnValue('request-123'),
  getTraceId: vi.fn().mockReturnValue('trace-456'),
}));

describe('Error Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      method: 'GET',
      path: '/api/test',
    };

    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();
  });

  describe('errorMiddleware', () => {
    describe('application errors (BaseError)', () => {
      it('handles AuthError with 401 status', () => {
        const error = new AuthError('Token expired', 'TOKEN_EXPIRED');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Token expired',
            traceId: 'trace-456',
          },
        });
      });

      it('handles ForbiddenError with 403 status', () => {
        const error = new ForbiddenError('Access denied');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied',
            traceId: 'trace-456',
          },
        });
      });

      it('handles NotFoundError with 404 status', () => {
        const error = new NotFoundError('Resource not found');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(404);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'NOT_FOUND',
            message: 'Resource not found',
            traceId: 'trace-456',
          },
        });
      });

      it('handles ValidationError with 400 status', () => {
        const error = new ValidationError('Invalid input', { field: 'email' });

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid input',
            details: { field: 'email' },
            traceId: 'trace-456',
          },
        });
      });

      it('includes details when present', () => {
        const error = new AuthError('OAuth failed', 'OAUTH_ERROR', { provider: 'google' });

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'OAUTH_ERROR',
            message: 'OAuth failed',
            details: { provider: 'google' },
            traceId: 'trace-456',
          },
        });
      });
    });

    describe('Zod validation errors', () => {
      it('converts ZodError to ValidationError response', () => {
        const schema = z.object({
          email: z.string().email(),
          age: z.number().min(18),
        });

        let zodError: ZodError | undefined;
        try {
          schema.parse({ email: 'invalid', age: 16 });
        } catch (e) {
          if (e instanceof ZodError) {
            zodError = e;
          }
        }

        errorMiddleware(zodError!, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: expect.any(Object),
            traceId: 'trace-456',
          },
        });
      });

      it('includes field-level error details', () => {
        const schema = z.object({
          email: z.string().email(),
        });

        let zodError: ZodError | undefined;
        try {
          schema.parse({ email: 'not-an-email' });
        } catch (e) {
          if (e instanceof ZodError) {
            zodError = e;
          }
        }

        errorMiddleware(zodError!, mockReq as Request, mockRes as Response, mockNext);

        const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(response.error.details).toBeDefined();
      });
    });

    describe('unknown errors', () => {
      it('returns 500 for generic Error', () => {
        const error = new Error('Something went wrong');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(500);
        expect(mockRes.json).toHaveBeenCalledWith({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
            traceId: 'trace-456',
          },
        });
      });

      it('does not expose error details for unknown errors', () => {
        const error = new Error('Database connection failed with secret credentials');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(response.error.message).not.toContain('Database');
        expect(response.error.message).not.toContain('secret');
      });

      it('logs unknown errors with stack trace', () => {
        const error = new Error('Unknown error');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockLoggerError).toHaveBeenCalledWith(
          expect.objectContaining({
            errorMessage: 'Unknown error',
            errorStack: expect.any(String),
          }),
          'Unhandled error'
        );
      });
    });

    describe('logging', () => {
      it('logs application errors at warn level', () => {
        const error = new AuthError('Invalid token', 'INVALID_TOKEN');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockLoggerWarn).toHaveBeenCalledWith(
          expect.objectContaining({
            errorCode: 'INVALID_TOKEN',
            errorMessage: 'Invalid token',
            statusCode: 401,
          }),
          'Invalid token'
        );
      });

      it('includes request and trace IDs in log', () => {
        const error = new AuthError('Test error', 'TEST');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        expect(mockLoggerWarn).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: 'request-123',
            traceId: 'trace-456',
          }),
          expect.any(String)
        );
      });
    });

    describe('traceId in response', () => {
      it('always includes traceId in error response', () => {
        const error = new Error('Any error');

        errorMiddleware(error, mockReq as Request, mockRes as Response, mockNext);

        const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(response.error.traceId).toBe('trace-456');
      });
    });
  });

  describe('notFoundHandler', () => {
    it('returns 404 status', () => {
      mockReq.method = 'GET';
      mockReq.path = '/api/unknown';

      notFoundHandler(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('includes method and path in message', () => {
      mockReq.method = 'POST';
      mockReq.path = '/api/nonexistent';

      notFoundHandler(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'NOT_FOUND',
          message: 'Cannot POST /api/nonexistent',
          traceId: 'trace-456',
        },
      });
    });

    it('handles different HTTP methods', () => {
      mockReq.method = 'DELETE';
      mockReq.path = '/api/resource/123';

      notFoundHandler(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'NOT_FOUND',
          message: 'Cannot DELETE /api/resource/123',
          traceId: 'trace-456',
        },
      });
    });

    it('includes traceId in response', () => {
      notFoundHandler(mockReq as Request, mockRes as Response);

      const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.error.traceId).toBe('trace-456');
    });
  });
});
