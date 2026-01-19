import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics registry
 */
export const registry = new Registry();

// Collect default Node.js metrics
collectDefaultMetrics({ register: registry });

/**
 * HTTP request metrics
 */
export const httpMetrics = {
  requestsTotal: new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  }),

  requestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [registry],
  }),

  activeRequests: new Gauge({
    name: 'http_active_requests',
    help: 'Number of active HTTP requests',
    registers: [registry],
  }),
};

/**
 * Authentication metrics
 */
export const authMetrics = {
  loginAttempts: new Counter({
    name: 'auth_login_attempts_total',
    help: 'Total login attempts',
    labelNames: ['provider', 'status'] as const,
    registers: [registry],
  }),

  loginDuration: new Histogram({
    name: 'auth_login_duration_seconds',
    help: 'Login duration in seconds',
    labelNames: ['provider'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [registry],
  }),

  tokenRefreshAttempts: new Counter({
    name: 'auth_token_refresh_attempts_total',
    help: 'Total token refresh attempts',
    labelNames: ['status'] as const,
    registers: [registry],
  }),

  activeUsers: new Gauge({
    name: 'auth_active_users',
    help: 'Number of users with valid sessions',
    registers: [registry],
  }),
};

/**
 * Database metrics
 */
export const dbMetrics = {
  queriesTotal: new Counter({
    name: 'db_queries_total',
    help: 'Total database queries',
    labelNames: ['operation', 'status'] as const,
    registers: [registry],
  }),

  queryDuration: new Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    registers: [registry],
  }),

  connectionPoolSize: new Gauge({
    name: 'db_connection_pool_size',
    help: 'Database connection pool size',
    labelNames: ['state'] as const,
    registers: [registry],
  }),
};

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Get content type for metrics endpoint
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
