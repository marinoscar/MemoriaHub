import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  validateOAuthProvider,
  validateOAuthCallback,
  validateRefreshToken,
} from '../validators/auth.validator.js';
import { asyncHandler } from '../utils/async-handler.js';

/**
 * Authentication routes
 * Note: Static routes (/providers, /me, /refresh, /logout) must be defined
 * BEFORE parameterized routes (/:provider) to avoid matching conflicts
 */
export function createAuthRoutes(): Router {
  const router = Router();

  // List available OAuth providers
  router.get('/providers', asyncHandler((req, res) => authController.getProviders(req, res)));

  // Get current user (requires auth) - must be before /:provider
  router.get('/me', authMiddleware, asyncHandler((req, res, next) =>
    authController.getCurrentUser(req, res, next)
  ));

  // Refresh token
  router.post('/refresh', validateRefreshToken, asyncHandler((req, res, next) =>
    authController.refreshToken(req, res, next)
  ));

  // Logout (requires auth)
  router.post('/logout', authMiddleware, asyncHandler((req, res, next) =>
    authController.logout(req, res, next)
  ));

  // Initiate OAuth flow - parameterized route must come after static routes
  router.get('/:provider', validateOAuthProvider, asyncHandler((req, res, next) =>
    authController.initiateOAuth(req, res, next)
  ));

  // OAuth callback
  router.get('/:provider/callback', validateOAuthProvider, validateOAuthCallback, asyncHandler((req, res, next) =>
    authController.handleCallback(req, res, next)
  ));

  return router;
}
