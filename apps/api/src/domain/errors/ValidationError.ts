import { ErrorCodes, type ErrorCode } from '@memoriahub/shared';
import { BaseError } from './BaseError.js';

/**
 * Input validation errors
 */
export class ValidationError extends BaseError {
  readonly statusCode = 400;
  readonly code: ErrorCode = ErrorCodes.VALIDATION_ERROR;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }

  /**
   * Create from Zod validation errors
   */
  static fromZodError(zodError: { errors: Array<{ path: (string | number)[]; message: string }> }): ValidationError {
    const details = zodError.errors.reduce(
      (acc, err) => {
        const path = err.path.join('.');
        acc[path] = err.message;
        return acc;
      },
      {} as Record<string, string>
    );

    return new ValidationError('Validation failed', { fields: details });
  }
}
