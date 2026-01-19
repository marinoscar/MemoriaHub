/**
 * Media Routes
 *
 * Routes for media upload and management.
 *
 * Upload:
 *   POST   /api/media/upload/initiate   - Get presigned upload URL (libraryId optional)
 *   POST   /api/media/upload/proxy      - Upload file through API proxy (libraryId optional)
 *   POST   /api/media/upload/complete   - Complete upload after S3 upload
 *
 * Media Assets:
 *   GET    /api/media                      - List all accessible media (owned + shared + library)
 *   GET    /api/media/library/:libraryId   - List media in a library
 *   GET    /api/media/:id                  - Get single media asset
 *   DELETE /api/media/:id                  - Delete media asset (owner only)
 */

import { Router } from 'express';
import multer from 'multer';
import { mediaController } from '../controllers/media.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  validateInitiateUpload,
  validateCompleteUpload,
  validateListMediaQuery,
} from '../validators/media.validator.js';
import { asyncHandler } from '../utils/async-handler.js';
import { storageConfig } from '../../config/storage.config.js';

// Configure multer for memory storage (files stored in buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: storageConfig.maxUploadSize,
  },
  fileFilter: (_req, file, cb) => {
    // Accept images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

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

  // Proxy upload - upload file through API server (avoids CORS issues)
  router.post(
    '/upload/proxy',
    upload.single('file'),
    asyncHandler((req, res, next) => mediaController.proxyUpload(req, res, next))
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

  // List all accessible media for user (owned + shared + via libraries)
  // IMPORTANT: This route must come BEFORE /:id to avoid "library" being treated as an ID
  router.get(
    '/',
    validateListMediaQuery,
    asyncHandler((req, res, next) => mediaController.listAllAccessibleMedia(req, res, next))
  );

  // List media in a library (via library_assets junction table)
  router.get(
    '/library/:libraryId',
    validateListMediaQuery,
    asyncHandler((req, res, next) => mediaController.listMediaInLibrary(req, res, next))
  );

  // Get single media asset
  router.get(
    '/:id',
    asyncHandler((req, res, next) => mediaController.getMedia(req, res, next))
  );

  // Delete media asset (owner only)
  router.delete(
    '/:id',
    asyncHandler((req, res, next) => mediaController.deleteMedia(req, res, next))
  );

  return router;
}
