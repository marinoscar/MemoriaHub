import { pino, type Logger } from 'pino';
import { serverConfig } from '../../config/index.js';

/**
 * Structured JSON logger using Pino
 * All logs include: timestamp, level, service, env
 */
export const logger: Logger = pino({
  level: serverConfig.logLevel,
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  base: {
    service: 'api',
    env: serverConfig.nodeEnv,
  },
  // Pretty print in development
  ...(serverConfig.nodeEnv === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,service,env',
      },
    },
  }),
});

/**
 * Create a child logger with additional context
 */
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/**
 * Log event types for consistent logging
 */
export const LogEventTypes = {
  // Server lifecycle
  SERVER_STARTING: 'server.starting',
  SERVER_STARTED: 'server.started',
  SERVER_STOPPING: 'server.stopping',
  SERVER_STOPPED: 'server.stopped',

  // HTTP
  HTTP_REQUEST_START: 'http.request.start',
  HTTP_REQUEST_END: 'http.request.end',
  HTTP_REQUEST_ERROR: 'http.request.error',

  // Auth
  AUTH_LOGIN_STARTED: 'auth.login.started',
  AUTH_LOGIN_SUCCESS: 'auth.login.success',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_TOKEN_REFRESH: 'auth.token.refresh',
  AUTH_TOKEN_INVALID: 'auth.token.invalid',

  // Database
  DB_CONNECTED: 'db.connected',
  DB_DISCONNECTED: 'db.disconnected',
  DB_QUERY_ERROR: 'db.query.error',

  // User
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
} as const;

export type LogEventType = (typeof LogEventTypes)[keyof typeof LogEventTypes];
