import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger, LogEventTypes } from '../../infrastructure/logging/logger.js';
import { getRequestId, getTraceId } from '../../infrastructure/logging/request-context.js';
import { BaseError, ValidationError } from '../../domain/errors/index.js';
import { ErrorCodes, HttpStatus } from '@memoriahub/shared';

/**
 * Global error handling middleware
 * Converts errors to standardized API responses
 */
export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = getRequestId();
  const traceId = getTraceId();

  // Handle known application errors
  if (err instanceof BaseError) {
    logger.warn(
      {
        eventType: LogEventTypes.HTTP_REQUEST_ERROR,
        requestId,
        traceId,
        errorCode: err.code,
        errorMessage: err.message,
        statusCode: err.statusCode,
      },
      err.message
    );

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
        traceId,
      },
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const validationError = ValidationError.fromZodError(err);
    logger.warn(
      {
        eventType: LogEventTypes.HTTP_REQUEST_ERROR,
        requestId,
        traceId,
        errorCode: validationError.code,
        errorMessage: validationError.message,
        details: validationError.details,
      },
      'Validation error'
    );

    res.status(HttpStatus.BAD_REQUEST).json({
      error: {
        code: validationError.code,
        message: validationError.message,
        details: validationError.details,
        traceId,
      },
    });
    return;
  }

  // Handle unknown errors
  logger.error(
    {
      eventType: LogEventTypes.HTTP_REQUEST_ERROR,
      requestId,
      traceId,
      errorMessage: err.message,
      errorStack: err.stack,
    },
    'Unhandled error'
  );

  res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
      traceId,
    },
  });
}

/**
 * Not found handler for undefined routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const traceId = getTraceId();
  res.status(HttpStatus.NOT_FOUND).json({
    error: {
      code: ErrorCodes.NOT_FOUND,
      message: `Cannot ${req.method} ${req.path}`,
      traceId,
    },
  });
}
