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
 *
 * Library Assets (many-to-many with media):
 *   POST   /api/libraries/:id/assets            - Add asset to library
 *   POST   /api/libraries/:id/assets/bulk       - Add multiple assets to library
 *   DELETE /api/libraries/:id/assets/:assetId   - Remove asset from library
 */

import { Router } from 'express';
import { libraryController } from '../controllers/library.controller.js';
import { libraryAssetController } from '../controllers/library-asset.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  validateCreateLibrary,
  validateUpdateLibrary,
  validateAddLibraryMember,
  validateUpdateLibraryMember,
  validateListLibrariesQuery,
  validateAddAssetToLibrary,
  validateAddAssetsToLibrary,
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

  // ===========================================================================
  // Library Assets (many-to-many with media)
  // ===========================================================================

  // Add single asset to library
  router.post(
    '/:id/assets',
    validateAddAssetToLibrary,
    asyncHandler((req, res, next) => libraryAssetController.addAsset(req, res, next))
  );

  // Add multiple assets to library
  router.post(
    '/:id/assets/bulk',
    validateAddAssetsToLibrary,
    asyncHandler((req, res, next) => libraryAssetController.addAssets(req, res, next))
  );

  // Remove asset from library
  router.delete(
    '/:id/assets/:assetId',
    asyncHandler((req, res, next) => libraryAssetController.removeAsset(req, res, next))
  );

  return router;
}
