import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';

describe('Health Endpoints (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('GET /api/health', () => {
    it('should return 200 with overall health status', async () => {
      // Mock successful database query
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return all health indicators', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.info).toBeDefined();
      expect(response.body.data.info.database).toBeDefined();
      expect(response.body.data.info.database.status).toBe('up');
    });

    it('should include response time in database indicator', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.info.database.responseTime).toBeDefined();
      expect(response.body.data.info.database.responseTime).toMatch(/^\d+ms$/);
    });

    it('should return 503 when database is down', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Connection refused'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'ERROR',
        timestamp: expect.any(String),
      });
    });

    it('should include error message when database check fails', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Database connection timeout'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body.message).toBeDefined();
    });

    it('should not require authentication', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);
    });

    it('should include timestamp in response', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      const timestamp = new Date(response.body.data.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.data.timestamp);
    });
  });

  describe('GET /api/health/live', () => {
    it('should return 200 when service is running', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should return ok status regardless of database state', async () => {
      // Even with database down, liveness should pass
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Database is down'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('should be accessible without authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);
    });

    it('should include valid timestamp', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      const timestamp = new Date(response.body.data.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.data.timestamp);
    });

    it('should not check database connectivity', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      // Verify database was not queried
      expect(context.prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('should return quickly', async () => {
      const startTime = Date.now();

      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      const duration = Date.now() - startTime;
      // Liveness check should be very fast (under 100ms)
      expect(duration).toBeLessThan(100);
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return 200 when all dependencies healthy', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });
    });

    it('should include database status', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.info).toBeDefined();
      expect(response.body.data.info.database).toBeDefined();
      expect(response.body.data.info.database.status).toBe('up');
    });

    it('should return 503 when database is unhealthy', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Connection failed'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.code).toBe('ERROR');
    });

    it('should be accessible without authentication', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);
    });

    it('should verify database connectivity', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      // Verify database was queried
      expect(context.prismaMock.$queryRaw).toHaveBeenCalled();
    });

    it('should include response time in database check', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.info.database.responseTime).toBeDefined();
      expect(response.body.data.info.database.responseTime).toMatch(/^\d+ms$/);
    });

    it('should include timestamp in response', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      const timestamp = new Date(response.body.data.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.data.timestamp);
    });

    it('should include error details when database fails', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Network timeout'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.message).toBeDefined();
      expect(response.body.statusCode).toBe(503);
    });
  });

  describe('Public Access', () => {
    it('should allow GET /api/health without Authorization header', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('should allow GET /api/health/live without Authorization header', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });

    it('should allow GET /api/health/ready without Authorization header', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.status).toBe('ok');
    });
  });

  describe('Error Scenarios', () => {
    it('should handle database timeout', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Query timeout exceeded'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.message).toBeDefined();
    });

    it('should handle database connection pool exhaustion', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Connection pool exhausted'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.message).toBeDefined();
    });

    it('should handle generic database errors', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(
        new Error('Unexpected database error'),
      );

      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);

      expect(response.body.statusCode).toBe(503);
      expect(response.body.code).toBe('ERROR');
    });
  });

  describe('Response Format', () => {
    it('should return consistent format for healthy status', async () => {
      context.prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
        info: expect.any(Object),
        details: expect.any(Object),
        timestamp: expect.any(String),
      });
    });

    it('should return consistent format for unhealthy status', async () => {
      context.prismaMock.$queryRaw.mockRejectedValue(new Error('DB Error'));

      const response = await request(context.app.getHttpServer())
        .get('/api/health')
        .expect(503);

      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'ERROR',
        message: expect.any(String),
        timestamp: expect.any(String),
        path: expect.any(String),
      });
    });
  });
});
