import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  validateOAuthProvider,
  validateOAuthCallback,
  validateRefreshToken,
} from '../validators/auth.validator.js';

/**
 * Authentication routes
 */
export function createAuthRoutes(): Router {
  const router = Router();

  // List available OAuth providers
  router.get('/providers', (req, res) => authController.getProviders(req, res));

  // Initiate OAuth flow
  router.get('/:provider', validateOAuthProvider, (req, res, next) =>
    authController.initiateOAuth(req, res, next)
  );

  // OAuth callback
  router.get('/:provider/callback', validateOAuthProvider, validateOAuthCallback, (req, res, next) =>
    authController.handleCallback(req, res, next)
  );

  // Refresh token
  router.post('/refresh', validateRefreshToken, (req, res, next) =>
    authController.refreshToken(req, res, next)
  );

  // Logout (requires auth)
  router.post('/logout', authMiddleware, (req, res, next) =>
    authController.logout(req, res, next)
  );

  // Get current user (requires auth)
  router.get('/me', authMiddleware, (req, res, next) =>
    authController.getCurrentUser(req, res, next)
  );

  return router;
}
