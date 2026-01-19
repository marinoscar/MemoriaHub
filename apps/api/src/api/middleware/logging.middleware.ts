import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger, LogEventTypes } from '../../infrastructure/logging/logger.js';
import { runWithRequestContext, getRequestContext } from '../../infrastructure/logging/request-context.js';
import { httpMetrics } from '../../infrastructure/telemetry/metrics.js';
import { HttpHeaders } from '@memoriahub/shared';

/**
 * Logging middleware that:
 * 1. Creates request context with requestId and traceId
 * 2. Logs request start/end
 * 3. Records metrics
 */
export function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Extract or generate request/trace IDs
  const requestId = (req.headers[HttpHeaders.REQUEST_ID.toLowerCase()] as string) || uuidv4();
  const traceId = (req.headers[HttpHeaders.TRACE_ID.toLowerCase()] as string) || uuidv4();

  // Set response headers
  res.setHeader(HttpHeaders.REQUEST_ID, requestId);
  res.setHeader(HttpHeaders.TRACE_ID, traceId);

  // Run with request context
  runWithRequestContext({ requestId, traceId }, () => {
    const startTime = Date.now();

    // Increment active requests
    httpMetrics.activeRequests.inc();

    // Log request start
    logger.info(
      {
        eventType: LogEventTypes.HTTP_REQUEST_START,
        requestId,
        traceId,
        method: req.method,
        path: req.path,
        query: req.query,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      },
      `${req.method} ${req.path}`
    );

    // Capture response finish
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const context = getRequestContext();

      // Decrement active requests
      httpMetrics.activeRequests.dec();

      // Record metrics
      const normalizedPath = normalizePath(req.path);
      httpMetrics.requestsTotal.inc({
        method: req.method,
        path: normalizedPath,
        status: res.statusCode.toString(),
      });
      httpMetrics.requestDuration.observe(
        { method: req.method, path: normalizedPath },
        durationMs / 1000
      );

      // Log request end
      const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[logLevel](
        {
          eventType: LogEventTypes.HTTP_REQUEST_END,
          requestId,
          traceId,
          userId: context?.userId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs,
        },
        `${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`
      );
    });

    next();
  });
}

/**
 * Normalize path for metrics (replace IDs with placeholders)
 */
function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id') // UUIDs
    .replace(/\/\d+/g, '/:id'); // Numeric IDs
}
