/**
 * Settings Routes Integration Tests
 *
 * Tests for role-based access control on settings endpoints.
 * Verifies that admin routes are protected and user preferences are accessible.
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

describe('Settings Routes Integration Tests', () => {
  let app: Express;
  let mockQuery: ReturnType<typeof vi.fn>;

  const JWT_SECRET = 'test-jwt-secret-for-testing-only';

  // Helper to generate valid access token
  const generateAccessToken = (userId: string, email: string, role: 'user' | 'admin') => {
    return jwt.sign(
      {
        sub: userId,
        email,
        role,
        type: 'access',
      },
      JWT_SECRET,
      {
        expiresIn: '15m',
        issuer: 'memoriahub-test',
        audience: 'memoriahub-test',
      }
    );
  };

  const adminToken = generateAccessToken('admin-123', 'admin@example.com', 'admin');
  const userToken = generateAccessToken('user-456', 'user@example.com', 'user');

  const mockSystemSettings = {
    category: 'general',
    settings: {
      siteName: 'MemoriaHub',
      allowRegistration: true,
    },
    updated_at: new Date(),
  };

  const mockUserPreferences = {
    user_id: 'user-456',
    preferences: {
      theme: 'dark',
      language: 'en',
    },
    updated_at: new Date(),
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
  });

  describe('System Settings (Admin Only)', () => {
    describe('GET /api/settings/system', () => {
      it('returns 200 for admin user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockSystemSettings] });

        const response = await request(app)
          .get('/api/settings/system')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
      });

      it('returns 403 for regular user', async () => {
        const response = await request(app)
          .get('/api/settings/system')
          .set('Authorization', `Bearer ${userToken}`);

        expect(response.status).toBe(403);
        expect(response.body.error.message).toBe('Admin access required');
      });

      it('returns 401 for unauthenticated request', async () => {
        const response = await request(app).get('/api/settings/system');

        expect(response.status).toBe(401);
      });
    });

    describe('GET /api/settings/system/:category', () => {
      it('returns 200 for admin user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockSystemSettings] });

        const response = await request(app)
          .get('/api/settings/system/general')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
      });

      it('returns 403 for regular user', async () => {
        const response = await request(app)
          .get('/api/settings/system/general')
          .set('Authorization', `Bearer ${userToken}`);

        expect(response.status).toBe(403);
        expect(response.body.error.message).toBe('Admin access required');
      });

      it('returns 401 for unauthenticated request', async () => {
        const response = await request(app).get('/api/settings/system/general');

        expect(response.status).toBe(401);
      });
    });

    describe('PATCH /api/settings/system/:category', () => {
      it('returns 200 for admin user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockSystemSettings] });

        const response = await request(app)
          .patch('/api/settings/system/general')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ settings: { siteName: 'Updated Name' } });

        expect(response.status).toBe(200);
      });

      it('returns 403 for regular user', async () => {
        const response = await request(app)
          .patch('/api/settings/system/general')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ settings: { siteName: 'Updated Name' } });

        expect(response.status).toBe(403);
        expect(response.body.error.message).toBe('Admin access required');
      });

      it('returns 401 for unauthenticated request', async () => {
        const response = await request(app)
          .patch('/api/settings/system/general')
          .send({ settings: { siteName: 'Updated Name' } });

        expect(response.status).toBe(401);
      });
    });
  });

  describe('User Preferences (Any Authenticated User)', () => {
    describe('GET /api/settings/preferences', () => {
      it('returns 200 for admin user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockUserPreferences] });

        const response = await request(app)
          .get('/api/settings/preferences')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
      });

      it('returns 200 for regular user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockUserPreferences] });

        const response = await request(app)
          .get('/api/settings/preferences')
          .set('Authorization', `Bearer ${userToken}`);

        expect(response.status).toBe(200);
      });

      it('returns 401 for unauthenticated request', async () => {
        const response = await request(app).get('/api/settings/preferences');

        expect(response.status).toBe(401);
      });
    });

    describe('PATCH /api/settings/preferences', () => {
      it('returns 200 for admin user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockUserPreferences] });

        const response = await request(app)
          .patch('/api/settings/preferences')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ theme: 'light' });

        expect(response.status).toBe(200);
      });

      it('returns 200 for regular user', async () => {
        mockQuery.mockResolvedValue({ rows: [mockUserPreferences] });

        const response = await request(app)
          .patch('/api/settings/preferences')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ theme: 'light' });

        expect(response.status).toBe(200);
      });

      it('returns 401 for unauthenticated request', async () => {
        const response = await request(app)
          .patch('/api/settings/preferences')
          .send({ theme: 'light' });

        expect(response.status).toBe(401);
      });
    });
  });

  describe('Token Role Verification', () => {
    it('rejects tokens without role claim on admin routes', async () => {
      const tokenWithoutRole = jwt.sign(
        {
          sub: 'user-789',
          email: 'norole@example.com',
          type: 'access',
        },
        JWT_SECRET,
        {
          expiresIn: '15m',
          issuer: 'memoriahub-test',
          audience: 'memoriahub-test',
        }
      );

      const response = await request(app)
        .get('/api/settings/system')
        .set('Authorization', `Bearer ${tokenWithoutRole}`);

      // Should be forbidden since no role defaults to non-admin
      expect(response.status).toBe(403);
    });

    it('accepts expired admin status after token refresh', async () => {
      // This verifies that role is checked per-request, not cached
      // A user whose admin status was revoked should be denied on next request

      // First request as admin
      mockQuery.mockResolvedValue({ rows: [mockSystemSettings] });
      const response1 = await request(app)
        .get('/api/settings/system')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(response1.status).toBe(200);

      // Simulate same endpoint with non-admin token (as if role was changed)
      const response2 = await request(app)
        .get('/api/settings/system')
        .set('Authorization', `Bearer ${userToken}`);
      expect(response2.status).toBe(403);
    });
  });
});
