/**
 * HTTP status codes used throughout the application
 */
export const HttpStatus = {
  // Success
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,

  // Redirection
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  SEE_OTHER: 303,
  NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,

  // Client errors
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  GONE: 410,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,

  // Server errors
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

export type HttpStatusCode = (typeof HttpStatus)[keyof typeof HttpStatus];

/**
 * Standard HTTP headers
 */
export const HttpHeaders = {
  // Request ID for tracing
  REQUEST_ID: 'X-Request-Id',
  TRACE_ID: 'X-Trace-Id',

  // Authorization
  AUTHORIZATION: 'Authorization',

  // Content
  CONTENT_TYPE: 'Content-Type',
  ACCEPT: 'Accept',

  // CORS
  ACCESS_CONTROL_ALLOW_ORIGIN: 'Access-Control-Allow-Origin',
  ACCESS_CONTROL_ALLOW_METHODS: 'Access-Control-Allow-Methods',
  ACCESS_CONTROL_ALLOW_HEADERS: 'Access-Control-Allow-Headers',
  ACCESS_CONTROL_EXPOSE_HEADERS: 'Access-Control-Expose-Headers',

  // Security
  X_FRAME_OPTIONS: 'X-Frame-Options',
  X_CONTENT_TYPE_OPTIONS: 'X-Content-Type-Options',
  X_XSS_PROTECTION: 'X-XSS-Protection',
  STRICT_TRANSPORT_SECURITY: 'Strict-Transport-Security',

  // Caching
  CACHE_CONTROL: 'Cache-Control',
  ETAG: 'ETag',
  IF_NONE_MATCH: 'If-None-Match',
} as const;

/**
 * Content types
 */
export const ContentTypes = {
  JSON: 'application/json',
  FORM_URLENCODED: 'application/x-www-form-urlencoded',
  MULTIPART_FORM_DATA: 'multipart/form-data',
  TEXT_PLAIN: 'text/plain',
  TEXT_HTML: 'text/html',
} as const;

/**
 * API route prefixes
 */
export const ApiRoutes = {
  AUTH: '/api/auth',
  USERS: '/api/users',
  LIBRARIES: '/api/libraries',
  MEDIA: '/api/media',
  SEARCH: '/api/search',
  HEALTH: '/healthz',
  READY: '/readyz',
  METRICS: '/metrics',
} as const;
