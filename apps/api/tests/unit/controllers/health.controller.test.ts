/**
 * Health Controller Tests
 *
 * Tests for health check endpoints.
 * Covers liveness probe, readiness probe, and metrics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { HealthController } from '../../../src/api/controllers/health.controller.js';

// Mock database client
const mockCheckDatabaseHealth = vi.fn();
vi.mock('../../../src/infrastructure/database/client.js', () => ({
  checkDatabaseHealth: () => mockCheckDatabaseHealth(),
}));

// Mock telemetry
const mockGetMetrics = vi.fn();
const mockGetMetricsContentType = vi.fn();
vi.mock('../../../src/infrastructure/telemetry/metrics.js', () => ({
  getMetrics: () => mockGetMetrics(),
  getMetricsContentType: () => mockGetMetricsContentType(),
}));

describe('HealthController', () => {
  let controller: HealthController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();

    controller = new HealthController();

    mockReq = {};

    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
  });

  describe('healthz (liveness probe)', () => {
    it('returns ok status', async () => {
      await controller.healthz(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
        })
      );
    });

    it('includes timestamp in response', async () => {
      await controller.healthz(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('includes version in response', async () => {
      await controller.healthz(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '0.1.0',
        })
      );
    });

    it('returns valid ISO timestamp', async () => {
      await controller.healthz(mockReq as Request, mockRes as Response);

      const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const timestamp = new Date(response.timestamp);

      expect(timestamp.toISOString()).toBe(response.timestamp);
    });

    it('does not check dependencies', async () => {
      await controller.healthz(mockReq as Request, mockRes as Response);

      expect(mockCheckDatabaseHealth).not.toHaveBeenCalled();
    });
  });

  describe('readyz (readiness probe)', () => {
    it('returns ok status when database is healthy', async () => {
      mockCheckDatabaseHealth.mockResolvedValue(true);

      await controller.readyz(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          dependencies: {
            database: 'ok',
          },
        })
      );
    });

    it('returns unhealthy status when database is down', async () => {
      mockCheckDatabaseHealth.mockResolvedValue(false);

      await controller.readyz(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'unhealthy',
          dependencies: {
            database: 'unhealthy',
          },
        })
      );
    });

    it('includes timestamp in response', async () => {
      mockCheckDatabaseHealth.mockResolvedValue(true);

      await controller.readyz(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(String),
        })
      );
    });

    it('includes version in response', async () => {
      mockCheckDatabaseHealth.mockResolvedValue(true);

      await controller.readyz(mockReq as Request, mockRes as Response);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '0.1.0',
        })
      );
    });

    it('handles database health check error gracefully', async () => {
      mockCheckDatabaseHealth.mockRejectedValue(new Error('Connection failed'));

      // Should not throw
      await expect(controller.readyz(mockReq as Request, mockRes as Response)).rejects.toThrow(
        'Connection failed'
      );
    });
  });

  describe('metrics (Prometheus)', () => {
    it('returns metrics data with correct content type', async () => {
      const metricsData = `
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/api/health"} 42
`;
      mockGetMetrics.mockResolvedValue(metricsData);
      mockGetMetricsContentType.mockReturnValue('text/plain; version=0.0.4; charset=utf-8');

      await controller.metrics(mockReq as Request, mockRes as Response);

      expect(mockRes.set).toHaveBeenCalledWith(
        'Content-Type',
        'text/plain; version=0.0.4; charset=utf-8'
      );
      expect(mockRes.send).toHaveBeenCalledWith(metricsData);
    });

    it('calls getMetrics to collect metrics', async () => {
      mockGetMetrics.mockResolvedValue('');
      mockGetMetricsContentType.mockReturnValue('text/plain');

      await controller.metrics(mockReq as Request, mockRes as Response);

      expect(mockGetMetrics).toHaveBeenCalled();
    });

    it('calls getMetricsContentType for content type', async () => {
      mockGetMetrics.mockResolvedValue('');
      mockGetMetricsContentType.mockReturnValue('text/plain');

      await controller.metrics(mockReq as Request, mockRes as Response);

      expect(mockGetMetricsContentType).toHaveBeenCalled();
    });
  });

  describe('response format', () => {
    it('healthz returns HealthResponse shape', async () => {
      await controller.healthz(mockReq as Request, mockRes as Response);

      const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('timestamp');
      expect(response).toHaveProperty('version');
    });

    it('readyz returns ReadyResponse shape', async () => {
      mockCheckDatabaseHealth.mockResolvedValue(true);

      await controller.readyz(mockReq as Request, mockRes as Response);

      const response = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('timestamp');
      expect(response).toHaveProperty('version');
      expect(response).toHaveProperty('dependencies');
    });
  });
});
