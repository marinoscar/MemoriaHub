import { Router } from 'express';
import { createAuthRoutes } from './auth.routes.js';
import { createSettingsRoutes } from './settings.routes.js';

/**
 * Create all API routes
 */
export function createApiRoutes(): Router {
  const router = Router();

  // Auth routes
  router.use('/auth', createAuthRoutes());

  // Settings routes
  router.use('/settings', createSettingsRoutes());

  // Future routes:
  // router.use('/users', createUserRoutes());
  // router.use('/libraries', createLibraryRoutes());
  // router.use('/media', createMediaRoutes());

  return router;
}
