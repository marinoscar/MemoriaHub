import { ErrorCodes, type ErrorCode } from '@memoriahub/shared';
import { BaseError } from './BaseError.js';

/**
 * Resource not found errors
 */
export class NotFoundError extends BaseError {
  readonly statusCode = 404;
  readonly code: ErrorCode = ErrorCodes.NOT_FOUND;

  constructor(message: string = 'Resource not found', details?: Record<string, unknown>) {
    super(message, details);
  }
}
