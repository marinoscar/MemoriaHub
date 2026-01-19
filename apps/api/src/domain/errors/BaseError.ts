import type { ErrorCode } from '@memoriahub/shared';

/**
 * Base error class for all application errors
 */
export abstract class BaseError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to API response format
   */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}
