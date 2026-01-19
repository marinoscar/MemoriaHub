/**
 * Media Routes
 *
 * Routes for media upload and management.
 *
 * Upload:
 *   POST   /api/media/upload/initiate   - Get presigned upload URL
 *   POST   /api/media/upload/complete   - Complete upload after S3 upload
 *
 * Media Assets:
 *   GET    /api/media/library/:libraryId   - List media in a library
 *   GET    /api/media/:id                  - Get single media asset
 *   DELETE /api/media/:id                  - Delete media asset
 */

import { Router } from 'express';
import { mediaController } from '../controllers/media.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  validateInitiateUpload,
  validateCompleteUpload,
  validateListMediaQuery,
} from '../validators/media.validator.js';
import { asyncHandler } from '../utils/async-handler.js';

export function createMediaRoutes(): Router {
  const router = Router();

  // All media routes require authentication
  router.use(authMiddleware);

  // ===========================================================================
  // Upload
  // ===========================================================================

  // Initiate upload - get presigned URL
  router.post(
    '/upload/initiate',
    validateInitiateUpload,
    asyncHandler((req, res, next) => mediaController.initiateUpload(req, res, next))
  );

  // Complete upload - finalize after S3 upload
  router.post(
    '/upload/complete',
    validateCompleteUpload,
    asyncHandler((req, res, next) => mediaController.completeUpload(req, res, next))
  );

  // ===========================================================================
  // Media Assets
  // ===========================================================================

  // List media in a library
  router.get(
    '/library/:libraryId',
    validateListMediaQuery,
    asyncHandler((req, res, next) => mediaController.listMedia(req, res, next))
  );

  // Get single media asset
  router.get(
    '/:id',
    asyncHandler((req, res, next) => mediaController.getMedia(req, res, next))
  );

  // Delete media asset
  router.delete(
    '/:id',
    asyncHandler((req, res, next) => mediaController.deleteMedia(req, res, next))
  );

  return router;
}
