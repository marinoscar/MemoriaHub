/**
 * Auth Flow Integration Tests
 *
 * End-to-end tests for the complete authentication flow.
 * These tests verify the integration between controllers, services, and repositories.
 *
 * Note: These tests mock the database and external OAuth providers but test
 * the full request/response cycle through the Express app.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Mock database client before importing app
vi.mock('../../src/infrastructure/database/client.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  checkDatabaseHealth: vi.fn().mockResolvedValue(true),
  closePool: vi.fn(),
}));

// Mock the OAuth provider
const mockGenerateAuthUrl = vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?...');
const mockGetToken = vi.fn();
const mockVerifyIdToken = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    generateAuthUrl: mockGenerateAuthUrl,
    getToken: mockGetToken,
    verifyIdToken: mockVerifyIdToken,
  })),
}));

// Mock telemetry
vi.mock('../../src/infrastructure/telemetry/metrics.js', () => ({
  httpMetrics: {
    activeRequests: { inc: vi.fn(), dec: vi.fn() },
    requestsTotal: { inc: vi.fn() },
    requestDuration: { observe: vi.fn() },
  },
  authMetrics: {
    loginAttempts: { inc: vi.fn() },
    loginDuration: { observe: vi.fn() },
    tokenRefreshAttempts: { inc: vi.fn() },
  },
  getMetrics: vi.fn().mockResolvedValue(''),
  getMetricsContentType: vi.fn().mockReturnValue('text/plain'),
}));

// Mock logger
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  LogEventTypes: {
    AUTH_LOGIN_STARTED: 'auth.login.started',
    AUTH_LOGIN_SUCCESS: 'auth.login.success',
    AUTH_LOGIN_FAILED: 'auth.login.failed',
    AUTH_TOKEN_REFRESH: 'auth.token.refresh',
    AUTH_LOGOUT: 'auth.logout',
    AUTH_TOKEN_INVALID: 'auth.token.invalid',
    HTTP_REQUEST_START: 'http.request.start',
    HTTP_REQUEST_END: 'http.request.end',
    HTTP_REQUEST_ERROR: 'http.request.error',
  },
}));

// Mock request context
vi.mock('../../src/infrastructure/logging/request-context.js', () => ({
  runWithRequestContext: (_context: unknown, fn: () => void) => fn(),
  getRequestContext: vi.fn().mockReturnValue({}),
  getRequestId: vi.fn().mockReturnValue('test-request-id'),
  getTraceId: vi.fn().mockReturnValue('test-trace-id'),
  setUserId: vi.fn(),
}));

// Mock config
vi.mock('../../src/config/index.js', () => ({
  serverConfig: {
    port: 3000,
    host: 'localhost',
    corsOrigins: ['http://localhost:5173'],
    logLevel: 'silent',
  },
  jwtConfig: {
    secret: 'test-jwt-secret-for-testing-only',
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    issuer: 'memoriahub-test',
    audience: 'memoriahub-test',
  },
  oauthConfig: {
    stateTtlMs: 600000,
    frontendUrl: 'http://localhost:5173',
    google: {
      enabled: true,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3000/api/auth/google/callback',
    },
  },
  databaseConfig: {
    connectionString: 'postgresql://test:test@localhost:5432/test',
    poolMin: 1,
    poolMax: 5,
  },
}));

describe('Auth Flow Integration Tests', () => {
  let app: Express;
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockWithTransaction: ReturnType<typeof vi.fn>;

  const JWT_SECRET = 'test-jwt-secret-for-testing-only';

  const mockUser = {
    id: 'user-123',
    oauth_provider: 'google',
    oauth_subject: 'google-subject-456',
    email: 'test@example.com',
    email_verified: true,
    display_name: 'Test User',
    avatar_url: 'https://example.com/avatar.jpg',
    refresh_token_hash: null,
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    last_login_at: null,
  };

  beforeAll(async () => {
    // Import app after mocks are set up
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get reference to mocked query function
    const dbClient = await import('../../src/infrastructure/database/client.js');
    mockQuery = dbClient.query as ReturnType<typeof vi.fn>;
    mockWithTransaction = dbClient.withTransaction as ReturnType<typeof vi.fn>;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/auth/providers', () => {
    it('returns list of available OAuth providers', async () => {
      const response = await request(app)
        .get('/api/auth/providers')
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toContainEqual(
        expect.objectContaining({
          id: 'google',
          name: 'Google',
        })
      );
    });
  });

  describe('GET /api/auth/google', () => {
    it('redirects to Google OAuth', async () => {
      const response = await request(app)
        .get('/api/auth/google')
        .expect(302);

      expect(response.headers.location).toContain('accounts.google.com');
    });

    it('accepts custom redirect_uri parameter', async () => {
      await request(app)
        .get('/api/auth/google')
        .query({ redirect_uri: 'http://custom.app/callback' })
        .expect(302);

      expect(mockGenerateAuthUrl).toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('returns 400 when refreshToken is missing', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({})
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns new access token for valid refresh token', async () => {
      // Create a valid refresh token
      const refreshToken = jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'token-id' },
        JWT_SECRET,
        { expiresIn: '7d', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      // Mock user lookup
      mockQuery.mockResolvedValue({
        rows: [mockUser],
      });

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.tokenType).toBe('Bearer');
      expect(response.body.data.expiresIn).toBe(900);
    });

    it('returns 401 for expired refresh token', async () => {
      const expiredToken = jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'token-id' },
        JWT_SECRET,
        { expiresIn: '-1h', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: expiredToken })
        .expect(401);

      expect(response.body.error.code).toBeDefined();
    });

    it('returns 401 for invalid token signature', async () => {
      const invalidToken = jwt.sign(
        { sub: 'user-123', type: 'refresh', jti: 'token-id' },
        'wrong-secret',
        { expiresIn: '7d', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: invalidToken })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 without authorization header', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 with invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    it('returns current user for valid token', async () => {
      const accessToken = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', type: 'access' },
        JWT_SECRET,
        { expiresIn: '15m', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      mockQuery.mockResolvedValue({
        rows: [mockUser],
      });

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.id).toBe('user-123');
      expect(response.body.data.email).toBe('test@example.com');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns 401 without authentication', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('logs out authenticated user', async () => {
      const accessToken = jwt.sign(
        { sub: 'user-123', email: 'test@example.com', type: 'access' },
        JWT_SECRET,
        { expiresIn: '15m', issuer: 'memoriahub-test', audience: 'memoriahub-test' }
      );

      mockQuery.mockResolvedValue({ rows: [mockUser] });

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data.message).toBe('Logged out successfully');
    });
  });

  describe('Health endpoints', () => {
    it('GET /healthz returns ok', async () => {
      const response = await request(app)
        .get('/healthz')
        .expect(200);

      expect(response.body.status).toBe('ok');
    });

    it('GET /readyz returns ok when database is healthy', async () => {
      const response = await request(app)
        .get('/readyz')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.dependencies.database).toBe('ok');
    });
  });

  describe('Settings endpoints', () => {
    it('GET /api/settings/features returns feature flags without auth', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          category: 'features',
          settings: { aiSearch: true, sharing: true },
          updated_at: new Date(),
          updated_by: null,
        }],
      });

      const response = await request(app)
        .get('/api/settings/features')
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('GET /api/settings/system requires authentication', async () => {
      const response = await request(app)
        .get('/api/settings/system')
        .expect(401);

      expect(response.body.error).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('returns 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/api/unknown/route')
        .expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.message).toContain('Cannot GET');
    });

    it('includes traceId in error responses', async () => {
      const response = await request(app)
        .get('/api/unknown')
        .expect(404);

      expect(response.body.error.traceId).toBeDefined();
    });
  });

  describe('Request tracing', () => {
    it('returns X-Request-Id header', async () => {
      const response = await request(app)
        .get('/healthz')
        .expect(200);

      expect(response.headers['x-request-id']).toBeDefined();
    });

    it('returns X-Trace-Id header', async () => {
      const response = await request(app)
        .get('/healthz')
        .expect(200);

      expect(response.headers['x-trace-id']).toBeDefined();
    });

    it('propagates provided X-Request-Id', async () => {
      const response = await request(app)
        .get('/healthz')
        .set('X-Request-Id', 'custom-request-id')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('custom-request-id');
    });
  });
});
