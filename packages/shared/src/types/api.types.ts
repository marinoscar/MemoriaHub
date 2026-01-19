/**
 * Standard API success response wrapper
 */
export interface ApiResponse<T> {
  data: T;
  meta?: ApiMeta;
}

/**
 * Paginated response metadata
 */
export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
}

/**
 * Standard API error response
 */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    traceId?: string;
  };
}

/**
 * Common error codes
 */
export const ErrorCodes = {
  // Authentication errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  OAUTH_ERROR: 'OAUTH_ERROR',
  INVALID_STATE: 'INVALID_STATE',

  // Authorization errors
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',

  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DATABASE_ERROR: 'DATABASE_ERROR',

  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Pagination request parameters
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  version?: string;
}

/**
 * Ready check response with dependency status
 */
export interface ReadyResponse extends HealthResponse {
  dependencies: {
    database: 'ok' | 'unhealthy';
    storage?: 'ok' | 'unhealthy';
    cache?: 'ok' | 'unhealthy';
  };
}
