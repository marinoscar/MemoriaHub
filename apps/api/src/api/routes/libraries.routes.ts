/**
 * Library Routes
 *
 * Routes for library management.
 *
 * Library CRUD:
 *   GET    /api/libraries           - List user's libraries
 *   POST   /api/libraries           - Create a new library
 *   GET    /api/libraries/:id       - Get library by ID
 *   PATCH  /api/libraries/:id       - Update library
 *   DELETE /api/libraries/:id       - Delete library (owner only)
 *
 * Library Members:
 *   GET    /api/libraries/:id/members           - Get library members
 *   POST   /api/libraries/:id/members           - Add a member
 *   PATCH  /api/libraries/:id/members/:userId   - Update member role
 *   DELETE /api/libraries/:id/members/:userId   - Remove member
 */

import { Router } from 'express';
import { libraryController } from '../controllers/library.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  validateCreateLibrary,
  validateUpdateLibrary,
  validateAddLibraryMember,
  validateUpdateLibraryMember,
  validateListLibrariesQuery,
} from '../validators/library.validator.js';
import { asyncHandler } from '../utils/async-handler.js';

export function createLibraryRoutes(): Router {
  const router = Router();

  // All library routes require authentication
  router.use(authMiddleware);

  // ===========================================================================
  // Library CRUD
  // ===========================================================================

  // List libraries
  router.get(
    '/',
    validateListLibrariesQuery,
    asyncHandler((req, res, next) => libraryController.listLibraries(req, res, next))
  );

  // Create library
  router.post(
    '/',
    validateCreateLibrary,
    asyncHandler((req, res, next) => libraryController.createLibrary(req, res, next))
  );

  // Get library by ID
  router.get(
    '/:id',
    asyncHandler((req, res, next) => libraryController.getLibrary(req, res, next))
  );

  // Update library
  router.patch(
    '/:id',
    validateUpdateLibrary,
    asyncHandler((req, res, next) => libraryController.updateLibrary(req, res, next))
  );

  // Delete library
  router.delete(
    '/:id',
    asyncHandler((req, res, next) => libraryController.deleteLibrary(req, res, next))
  );

  // ===========================================================================
  // Library Members
  // ===========================================================================

  // Get members
  router.get(
    '/:id/members',
    asyncHandler((req, res, next) => libraryController.getMembers(req, res, next))
  );

  // Add member
  router.post(
    '/:id/members',
    validateAddLibraryMember,
    asyncHandler((req, res, next) => libraryController.addMember(req, res, next))
  );

  // Update member role
  router.patch(
    '/:id/members/:userId',
    validateUpdateLibraryMember,
    asyncHandler((req, res, next) => libraryController.updateMember(req, res, next))
  );

  // Remove member
  router.delete(
    '/:id/members/:userId',
    asyncHandler((req, res, next) => libraryController.removeMember(req, res, next))
  );

  return router;
}
