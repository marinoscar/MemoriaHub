import { Router } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listJobsQuerySchema,
  createJobBodySchema,
  batchRetryBodySchema,
  jobIdParamSchema,
} from '../validators/admin.validator.js';
import { ValidationError } from '../../domain/errors/index.js';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

// All admin routes require authentication and admin role
router.use(authMiddleware);
router.use(adminMiddleware);

/**
 * Middleware to validate query parameters
 */
function validateQuery(schema: typeof listJobsQuerySchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new ValidationError(result.error.message));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req.query = result.data as any;
    next();
  };
}

/**
 * Middleware to validate request body
 */
function validateBody(schema: typeof createJobBodySchema | typeof batchRetryBodySchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new ValidationError(result.error.message));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Middleware to validate path parameters
 */
function validateParams(schema: typeof jobIdParamSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(new ValidationError(result.error.message));
    }
    next();
  };
}

// =============================================================================
// Job Management Routes
// =============================================================================

/**
 * GET /api/admin/jobs
 * List jobs with filtering and pagination
 */
router.get(
  '/jobs',
  validateQuery(listJobsQuerySchema),
  asyncHandler((req, res) => adminController.listJobs(req, res))
);

/**
 * GET /api/admin/jobs/stats
 * Get comprehensive job statistics with queue breakdown
 */
router.get(
  '/jobs/stats',
  asyncHandler((req, res) => adminController.getStats(req, res))
);

/**
 * GET /api/admin/jobs/stats/summary
 * Get basic job statistics
 */
router.get(
  '/jobs/stats/summary',
  asyncHandler((req, res) => adminController.getStatsSummary(req, res))
);

/**
 * GET /api/admin/jobs/stuck
 * Find jobs stuck in processing state
 */
router.get(
  '/jobs/stuck',
  asyncHandler((req, res) => adminController.findStuckJobs(req, res))
);

/**
 * POST /api/admin/jobs/stuck/reset
 * Reset stuck jobs back to pending
 */
router.post(
  '/jobs/stuck/reset',
  asyncHandler((req, res) => adminController.resetStuckJobs(req, res))
);

/**
 * POST /api/admin/jobs/batch/retry
 * Batch retry failed jobs
 */
router.post(
  '/jobs/batch/retry',
  validateBody(batchRetryBodySchema),
  asyncHandler((req, res) => adminController.batchRetry(req, res))
);

/**
 * GET /api/admin/jobs/:id
 * Get job details
 */
router.get(
  '/jobs/:id',
  validateParams(jobIdParamSchema),
  asyncHandler((req, res) => adminController.getJob(req, res))
);

/**
 * POST /api/admin/jobs
 * Create a job manually
 */
router.post(
  '/jobs',
  validateBody(createJobBodySchema),
  asyncHandler((req, res) => adminController.createJob(req, res))
);

/**
 * POST /api/admin/jobs/:id/retry
 * Retry a failed job
 */
router.post(
  '/jobs/:id/retry',
  validateParams(jobIdParamSchema),
  asyncHandler((req, res) => adminController.retryJob(req, res))
);

/**
 * POST /api/admin/jobs/:id/cancel
 * Cancel a pending job
 */
router.post(
  '/jobs/:id/cancel',
  validateParams(jobIdParamSchema),
  asyncHandler((req, res) => adminController.cancelJob(req, res))
);

/**
 * DELETE /api/admin/jobs/:id
 * Delete a job
 */
router.delete(
  '/jobs/:id',
  validateParams(jobIdParamSchema),
  asyncHandler((req, res) => adminController.deleteJob(req, res))
);

export default router;
