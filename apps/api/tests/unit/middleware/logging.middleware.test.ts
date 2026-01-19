/**
 * Logging Middleware Tests
 *
 * Tests for request/response logging and metrics collection.
 * Covers request context, traceId propagation, and metrics recording.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { loggingMiddleware } from '../../../src/api/middleware/logging.middleware.js';

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('generated-uuid'),
}));

// Mock logger
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
  },
  LogEventTypes: {
    HTTP_REQUEST_START: 'http.request.start',
    HTTP_REQUEST_END: 'http.request.end',
  },
}));

// Mock request context
const mockRunWithRequestContext = vi.fn();
const mockGetRequestContext = vi.fn();

vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  runWithRequestContext: (context: unknown, fn: () => void) => {
    mockRunWithRequestContext(context, fn);
    fn();
  },
  getRequestContext: () => mockGetRequestContext(),
}));

// Mock metrics
const mockActiveRequestsInc = vi.fn();
const mockActiveRequestsDec = vi.fn();
const mockRequestsTotalInc = vi.fn();
const mockRequestDurationObserve = vi.fn();

vi.mock('../../../src/infrastructure/telemetry/metrics.js', () => ({
  httpMetrics: {
    activeRequests: {
      inc: () => mockActiveRequestsInc(),
      dec: () => mockActiveRequestsDec(),
    },
    requestsTotal: {
      inc: (labels: unknown) => mockRequestsTotalInc(labels),
    },
    requestDuration: {
      observe: (labels: unknown, value: unknown) => mockRequestDurationObserve(labels, value),
    },
  },
}));

describe('Logging Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let finishHandler: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    finishHandler = undefined;

    mockReq = {
      method: 'GET',
      path: '/api/test',
      query: {},
      headers: {},
      ip: '127.0.0.1',
    };

    mockRes = {
      setHeader: vi.fn(),
      statusCode: 200,
      on: vi.fn().mockImplementation((event: string, handler: () => void) => {
        if (event === 'finish') {
          finishHandler = handler;
        }
        return mockRes;
      }),
    };

    mockNext = vi.fn();
    mockGetRequestContext.mockReturnValue({ userId: undefined });
  });

  describe('request context', () => {
    it('generates requestId and traceId when not provided', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRunWithRequestContext).toHaveBeenCalledWith(
        {
          requestId: 'generated-uuid',
          traceId: 'generated-uuid',
        },
        expect.any(Function)
      );
    });

    it('uses provided requestId from header', () => {
      mockReq.headers = {
        'x-request-id': 'custom-request-id',
      };

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRunWithRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'custom-request-id',
        }),
        expect.any(Function)
      );
    });

    it('uses provided traceId from header', () => {
      mockReq.headers = {
        'x-trace-id': 'custom-trace-id',
      };

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRunWithRequestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'custom-trace-id',
        }),
        expect.any(Function)
      );
    });

    it('sets requestId and traceId in response headers', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Request-Id', 'generated-uuid');
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Trace-Id', 'generated-uuid');
    });
  });

  describe('request logging', () => {
    it('logs request start', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'http.request.start',
          method: 'GET',
          path: '/api/test',
        }),
        'GET /api/test'
      );
    });

    it('includes query parameters in log', () => {
      mockReq.query = { page: '1', limit: '10' };

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { page: '1', limit: '10' },
        }),
        expect.any(String)
      );
    });

    it('includes user agent in log', () => {
      mockReq.headers = {
        'user-agent': 'Mozilla/5.0',
      };

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'Mozilla/5.0',
        }),
        expect.any(String)
      );
    });

    it('includes IP address in log', () => {
      mockReq.ip = '192.168.1.100';

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '192.168.1.100',
        }),
        expect.any(String)
      );
    });
  });

  describe('response logging', () => {
    it('logs request end on response finish', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      // Simulate response finish
      finishHandler?.();

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'http.request.end',
          statusCode: 200,
          durationMs: expect.any(Number),
        }),
        expect.stringMatching(/GET \/api\/test 200 \d+ms/)
      );
    });

    it('logs at warn level for 4xx status codes', () => {
      mockRes.statusCode = 404;

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('logs at error level for 5xx status codes', () => {
      mockRes.statusCode = 500;

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockLoggerError).toHaveBeenCalled();
    });

    it('includes userId if authenticated', () => {
      mockGetRequestContext.mockReturnValue({ userId: 'user-123' });

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
        }),
        expect.any(String)
      );
    });
  });

  describe('metrics', () => {
    it('increments active requests on start', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockActiveRequestsInc).toHaveBeenCalled();
    });

    it('decrements active requests on finish', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockActiveRequestsDec).toHaveBeenCalled();
    });

    it('records request total with labels', () => {
      mockReq.method = 'POST';
      mockReq.path = '/api/users';
      mockRes.statusCode = 201;

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockRequestsTotalInc).toHaveBeenCalledWith({
        method: 'POST',
        path: '/api/users',
        status: '201',
      });
    });

    it('records request duration', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockRequestDurationObserve).toHaveBeenCalledWith(
        { method: 'GET', path: '/api/test' },
        expect.any(Number)
      );
    });

    it('normalizes UUIDs in path for metrics', () => {
      mockReq.path = '/api/users/550e8400-e29b-41d4-a716-446655440000';

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockRequestsTotalInc).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/users/:id',
        })
      );
    });

    it('normalizes numeric IDs in path for metrics', () => {
      mockReq.path = '/api/items/12345';

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockRequestsTotalInc).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/items/:id',
        })
      );
    });

    it('normalizes multiple IDs in path', () => {
      mockReq.path = '/api/users/123/posts/456';

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishHandler?.();

      expect(mockRequestsTotalInc).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/users/:id/posts/:id',
        })
      );
    });
  });

  describe('middleware chain', () => {
    it('calls next to continue middleware chain', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('registers finish handler on response', () => {
      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.on).toHaveBeenCalledWith('finish', expect.any(Function));
    });
  });

  describe('duration calculation', () => {
    it('calculates duration in milliseconds', () => {
      vi.useFakeTimers();

      loggingMiddleware(mockReq as Request, mockRes as Response, mockNext);

      // Advance time by 150ms
      vi.advanceTimersByTime(150);

      finishHandler?.();

      expect(mockRequestDurationObserve).toHaveBeenCalledWith(
        expect.any(Object),
        0.15 // 150ms in seconds
      );

      vi.useRealTimers();
    });
  });
});
