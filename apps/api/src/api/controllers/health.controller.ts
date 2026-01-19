import type { Request, Response } from 'express';
import { checkDatabaseHealth } from '../../infrastructure/database/client.js';
import { getMetrics, getMetricsContentType } from '../../infrastructure/telemetry/metrics.js';
import type { HealthResponse, ReadyResponse } from '@memoriahub/shared';

/**
 * Health check controller
 * Single Responsibility: Only handles health-related endpoints
 */
export class HealthController {
  /**
   * GET /healthz - Liveness probe
   * Returns 200 if the process is alive
   */
  async healthz(_req: Request, res: Response): Promise<void> {
    const response: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    };
    res.json(response);
  }

  /**
   * GET /readyz - Readiness probe
   * Returns 200 if all dependencies are healthy
   */
  async readyz(_req: Request, res: Response): Promise<void> {
    const dbHealthy = await checkDatabaseHealth();

    const response: ReadyResponse = {
      status: dbHealthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      dependencies: {
        database: dbHealthy ? 'ok' : 'unhealthy',
      },
    };

    const statusCode = response.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(response);
  }

  /**
   * GET /metrics - Prometheus metrics
   */
  async metrics(_req: Request, res: Response): Promise<void> {
    const metricsData = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metricsData);
  }
}

// Export singleton instance
export const healthController = new HealthController();
