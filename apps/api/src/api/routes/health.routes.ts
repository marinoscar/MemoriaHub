import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';

/**
 * Health check routes
 */
export function createHealthRoutes(): Router {
  const router = Router();

  // Liveness probe
  router.get('/healthz', (req, res) => healthController.healthz(req, res));

  // Readiness probe
  router.get('/readyz', (req, res) => healthController.readyz(req, res));

  // Prometheus metrics
  router.get('/metrics', (req, res) => healthController.metrics(req, res));

  return router;
}
