/**
 * Media Routes Integration Tests
 *
 * Tests for media upload endpoints including proxy upload.
 * Verifies authentication, authorization, and upload flows.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
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

// Mock storage config
vi.mock('../../src/config/storage.config.js', () => ({
  storageConfig: {
    bucket: 'test-bucket',
    presignedUrlExpiration: 3600,
    maxUploadSize: 100 * 1024 * 1024, // 100MB
  },
}));

// Mock the validators to pass through (avoids issues with @memoriahub/shared schemas)
vi.mock('../../src/api/validators/media.validator.js', () => ({
  validateInitiateUpload: (_req: unknown, _res: unknown, next: () => void) => next(),
  validateCompleteUpload: (_req: unknown, _res: unknown, next: () => void) => next(),
  validateListMediaQuery: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock upload service
const mockInitiateUpload = vi.fn();
const mockProxyUpload = vi.fn();
const mockCompleteUpload = vi.fn();
const mockListAssets = vi.fn();
const mockGetAsset = vi.fn();
const mockDeleteAsset = vi.fn();

vi.mock('../../src/services/upload/upload.service.js', () => ({
  uploadService: {
    initiateUpload: (...args: unknown[]) => mockInitiateUpload(...args),
    proxyUpload: (...args: unknown[]) => mockProxyUpload(...args),
    completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
    listAssets: (...args: unknown[]) => mockListAssets(...args),
    getAsset: (...args: unknown[]) => mockGetAsset(...args),
    deleteAsset: (...args: unknown[]) => mockDeleteAsset(...args),
  },
}));

describe('Media Routes Integration Tests', () => {
  let app: Express;

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

  const userToken = generateAccessToken('user-123', 'user@example.com', 'user');

  const mockAssetDTO = {
    id: 'asset-789',
    libraryId: 'library-456',
    originalFilename: 'test-image.jpg',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    fileSource: 'web',
    width: 1920,
    height: 1080,
    durationSeconds: null,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15',
    latitude: null,
    longitude: null,
    country: null,
    state: null,
    city: null,
    locationName: null,
    capturedAtUtc: '2024-01-01T12:00:00.000Z',
    timezoneOffset: 0,
    thumbnailUrl: null,
    previewUrl: null,
    originalUrl: 'https://example.com/original.jpg',
    exifData: {},
    status: 'METADATA_EXTRACTED',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeAll(async () => {
    // Import app after mocks are set up
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/media/upload/proxy', () => {
    it('returns 201 on successful proxy upload', async () => {
      mockProxyUpload.mockResolvedValue(mockAssetDTO);

      const response = await request(app)
        .post('/api/media/upload/proxy')
        .set('Authorization', `Bearer ${userToken}`)
        .field('libraryId', 'library-456')
        .attach('file', Buffer.from('test image content'), {
          filename: 'test-image.jpg',
          contentType: 'image/jpeg',
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(mockAssetDTO);
      expect(mockProxyUpload).toHaveBeenCalledWith(
        'user-123',
        'library-456',
        expect.objectContaining({
          originalname: 'test-image.jpg',
          mimetype: 'image/jpeg',
        })
      );
    });

    it('returns 401 for unauthenticated request', async () => {
      const response = await request(app)
        .post('/api/media/upload/proxy')
        .field('libraryId', 'library-456')
        .attach('file', Buffer.from('test'), {
          filename: 'test.jpg',
          contentType: 'image/jpeg',
        });

      expect(response.status).toBe(401);
      expect(mockProxyUpload).not.toHaveBeenCalled();
    });

    it('returns 400 when file is missing', async () => {
      const response = await request(app)
        .post('/api/media/upload/proxy')
        .set('Authorization', `Bearer ${userToken}`)
        .field('libraryId', 'library-456');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MISSING_FILE');
    });

    it('returns 400 when libraryId is missing', async () => {
      const response = await request(app)
        .post('/api/media/upload/proxy')
        .set('Authorization', `Bearer ${userToken}`)
        .attach('file', Buffer.from('test'), {
          filename: 'test.jpg',
          contentType: 'image/jpeg',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MISSING_LIBRARY_ID');
    });

    it('rejects non-media file types', async () => {
      const response = await request(app)
        .post('/api/media/upload/proxy')
        .set('Authorization', `Bearer ${userToken}`)
        .field('libraryId', 'library-456')
        .attach('file', Buffer.from('not an image'), {
          filename: 'document.pdf',
          contentType: 'application/pdf',
        });

      // Multer fileFilter rejects non-image/video files
      expect(response.status).toBe(500); // Multer throws error for rejected files
    });

    it('accepts video files', async () => {
      const videoAssetDTO = { ...mockAssetDTO, mediaType: 'video', mimeType: 'video/mp4' };
      mockProxyUpload.mockResolvedValue(videoAssetDTO);

      const response = await request(app)
        .post('/api/media/upload/proxy')
        .set('Authorization', `Bearer ${userToken}`)
        .field('libraryId', 'library-456')
        .attach('file', Buffer.from('video content'), {
          filename: 'test-video.mp4',
          contentType: 'video/mp4',
        });

      expect(response.status).toBe(201);
      expect(mockProxyUpload).toHaveBeenCalled();
    });
  });

  describe('POST /api/media/upload/initiate', () => {
    it('returns 201 on successful initiate', async () => {
      const mockResponse = {
        assetId: 'asset-123',
        uploadUrl: 'https://s3.example.com/presigned-url',
        storageKey: 'libraries/library-456/originals/asset-123.jpg',
        expiresAt: '2024-01-01T01:00:00.000Z',
      };
      mockInitiateUpload.mockResolvedValue(mockResponse);

      const response = await request(app)
        .post('/api/media/upload/initiate')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          libraryId: 'library-456',
          filename: 'test.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024,
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(mockResponse);
    });

    it('returns 401 for unauthenticated request', async () => {
      const response = await request(app)
        .post('/api/media/upload/initiate')
        .send({
          libraryId: 'library-456',
          filename: 'test.jpg',
          mimeType: 'image/jpeg',
          fileSize: 1024,
        });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/media/upload/complete', () => {
    it('returns 200 on successful complete', async () => {
      mockCompleteUpload.mockResolvedValue(mockAssetDTO);

      const response = await request(app)
        .post('/api/media/upload/complete')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ assetId: 'asset-789' });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockAssetDTO);
    });

    it('returns 401 for unauthenticated request', async () => {
      const response = await request(app)
        .post('/api/media/upload/complete')
        .send({ assetId: 'asset-789' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/media/library/:libraryId', () => {
    it('returns 200 with list of assets', async () => {
      mockListAssets.mockResolvedValue({
        assets: [mockAssetDTO],
        total: 1,
        page: 1,
        limit: 50,
      });

      const response = await request(app)
        .get('/api/media/library/library-456')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([mockAssetDTO]);
      expect(response.body.meta).toEqual({ page: 1, limit: 50, total: 1 });
    });

    it('returns 401 for unauthenticated request', async () => {
      const response = await request(app).get('/api/media/library/library-456');

      expect(response.status).toBe(401);
    });

    it('passes query parameters to service', async () => {
      mockListAssets.mockResolvedValue({ assets: [], total: 0, page: 1, limit: 20 });

      await request(app)
        .get('/api/media/library/library-456')
        .query({ page: '1', limit: '20', mediaType: 'image' })
        .set('Authorization', `Bearer ${userToken}`);

      expect(mockListAssets).toHaveBeenCalledWith(
        'user-123',
        'library-456',
        expect.objectContaining({
          page: 1,
          limit: 20,
          mediaType: 'image',
        })
      );
    });
  });

  describe('GET /api/media/:id', () => {
    it('returns 200 with asset details', async () => {
      mockGetAsset.mockResolvedValue(mockAssetDTO);

      const response = await request(app)
        .get('/api/media/asset-789')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(mockAssetDTO);
    });

    it('returns 401 for unauthenticated request', async () => {
      const response = await request(app).get('/api/media/asset-789');

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/media/:id', () => {
    it('returns 204 on successful delete', async () => {
      mockDeleteAsset.mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/media/asset-789')
        .set('Authorization', `Bearer ${userToken}`);

      expect(response.status).toBe(204);
      expect(mockDeleteAsset).toHaveBeenCalledWith('user-123', 'asset-789');
    });

    it('returns 401 for unauthenticated request', async () => {
      const response = await request(app).delete('/api/media/asset-789');

      expect(response.status).toBe(401);
    });
  });
});
