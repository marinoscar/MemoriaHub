import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';
import { asyncHandler } from '../utils/async-handler.js';

/**
 * Health check routes
 */
export function createHealthRoutes(): Router {
  const router = Router();

  // Liveness probe
  router.get('/healthz', asyncHandler((req, res) => healthController.healthz(req, res)));

  // Readiness probe
  router.get('/readyz', asyncHandler((req, res) => healthController.readyz(req, res)));

  // Prometheus metrics
  router.get('/metrics', asyncHandler((req, res) => healthController.metrics(req, res)));

  return router;
}
