import { ErrorCodes, type ErrorCode } from '@memoriahub/shared';
import { BaseError } from './BaseError.js';

/**
 * Authorization-related errors (user is authenticated but not allowed)
 */
export class ForbiddenError extends BaseError {
  readonly statusCode = 403;
  readonly code: ErrorCode;

  constructor(message: string = 'Access denied', code: ErrorCode = ErrorCodes.FORBIDDEN, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}
