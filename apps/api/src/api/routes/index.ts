import { Router } from 'express';
import { createAuthRoutes } from './auth.routes.js';
import { createSettingsRoutes } from './settings.routes.js';
import { createLibraryRoutes } from './libraries.routes.js';
import { createMediaRoutes } from './media.routes.js';

/**
 * Create all API routes
 */
export function createApiRoutes(): Router {
  const router = Router();

  // Auth routes
  router.use('/auth', createAuthRoutes());

  // Settings routes
  router.use('/settings', createSettingsRoutes());

  // Library routes
  router.use('/libraries', createLibraryRoutes());

  // Media routes
  router.use('/media', createMediaRoutes());

  return router;
}
