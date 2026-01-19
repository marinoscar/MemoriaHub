import { ErrorCodes, type ErrorCode } from '@memoriahub/shared';
import { BaseError } from './BaseError.js';

/**
 * Authentication error codes
 */
export type AuthErrorCode =
  | typeof ErrorCodes.UNAUTHORIZED
  | typeof ErrorCodes.INVALID_TOKEN
  | typeof ErrorCodes.TOKEN_EXPIRED
  | typeof ErrorCodes.INVALID_REFRESH_TOKEN
  | typeof ErrorCodes.OAUTH_ERROR
  | typeof ErrorCodes.INVALID_STATE;

/**
 * Authentication-related errors
 */
export class AuthError extends BaseError {
  readonly statusCode = 401;
  readonly code: ErrorCode;

  constructor(message: string, code: AuthErrorCode = ErrorCodes.UNAUTHORIZED, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}
