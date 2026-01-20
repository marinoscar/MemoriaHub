/**
 * Media Controller
 *
 * Handles HTTP requests for media upload and management.
 * All endpoints require authentication.
 * Authorization is checked at the service layer.
 */

import type { Request, Response, NextFunction } from 'express';
import type {
  ApiResponse,
  MediaAssetDTO,
  PresignedUploadResponse,
  InitiateUploadInput,
  CompleteUploadInput,
  BulkUpdateMetadataInput,
  BulkUpdateMetadataResult,
  BulkDeleteInput,
  BulkDeleteResult,
} from '@memoriahub/shared';
import { uploadService } from '../../services/upload/upload.service.js';

/**
 * Media controller
 */
export class MediaController {
  // ===========================================================================
  // Upload
  // ===========================================================================

  /**
   * POST /api/media/upload/initiate
   * Initiate an upload and get a presigned URL
   */
  async initiateUpload(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const input = req.body as InitiateUploadInput;

      const result = await uploadService.initiateUpload(userId, input, 'web');

      const response: ApiResponse<PresignedUploadResponse> = { data: result };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/media/upload/proxy
   * Upload a file directly through the API server (proxied to S3)
   * This avoids CORS issues with direct S3 uploads
   * libraryId is optional - if provided, asset will be added to library
   */
  async proxyUpload(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.body.libraryId as string | undefined;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          error: { code: 'MISSING_FILE', message: 'No file provided' },
        });
        return;
      }

      const asset = await uploadService.proxyUpload(userId, libraryId || null, {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      });

      const response: ApiResponse<MediaAssetDTO> = { data: asset };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/media/upload/complete
   * Complete an upload after file has been uploaded to S3
   */
  async completeUpload(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const input = req.body as CompleteUploadInput;

      const asset = await uploadService.completeUpload(userId, input.assetId);

      const response: ApiResponse<MediaAssetDTO> = { data: asset };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  // ===========================================================================
  // Media Assets
  // ===========================================================================

  /**
   * GET /api/media/library/:libraryId
   * List media assets in a library (via library_assets junction table)
   */
  async listMediaInLibrary(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.libraryId;
      const query = req.query as Record<string, string | undefined>;

      const result = await uploadService.listAssetsInLibrary(userId, libraryId, {
        page: query.page ? parseInt(query.page, 10) : undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        status: query.status,
        mediaType: query.mediaType as 'image' | 'video' | undefined,
        country: query.country,
        state: query.state,
        city: query.city,
        cameraMake: query.cameraMake,
        cameraModel: query.cameraModel,
        startDate: query.startDate,
        endDate: query.endDate,
        sortBy: query.sortBy as 'capturedAt' | 'createdAt' | 'filename' | 'fileSize' | undefined,
        sortOrder: query.sortOrder as 'asc' | 'desc' | undefined,
      });

      const response: ApiResponse<MediaAssetDTO[]> = {
        data: result.assets,
        meta: {
          page: result.page,
          limit: result.limit,
          total: result.total,
        },
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/media
   * List all accessible media for the current user (owned + shared + via libraries)
   */
  async listAllAccessibleMedia(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const query = req.query as Record<string, string | undefined>;

      const result = await uploadService.listAllAccessibleAssets(userId, {
        page: query.page ? parseInt(query.page, 10) : undefined,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        status: query.status,
        mediaType: query.mediaType as 'image' | 'video' | undefined,
        country: query.country,
        state: query.state,
        city: query.city,
        cameraMake: query.cameraMake,
        cameraModel: query.cameraModel,
        startDate: query.startDate,
        endDate: query.endDate,
        sortBy: query.sortBy as 'capturedAt' | 'createdAt' | 'filename' | 'fileSize' | undefined,
        sortOrder: query.sortOrder as 'asc' | 'desc' | undefined,
      });

      const response: ApiResponse<MediaAssetDTO[]> = {
        data: result.assets,
        meta: {
          page: result.page,
          limit: result.limit,
          total: result.total,
        },
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/media/:id
   * Get a single media asset
   */
  async getMedia(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;

      const asset = await uploadService.getAsset(userId, assetId);

      const response: ApiResponse<MediaAssetDTO> = { data: asset };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/media/:id
   * Delete a media asset
   */
  async deleteMedia(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;

      await uploadService.deleteAsset(userId, assetId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  // ===========================================================================
  // Bulk Operations
  // ===========================================================================

  /**
   * PATCH /api/media/bulk
   * Bulk update metadata for multiple assets
   */
  async bulkUpdateMetadata(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const input = req.body as BulkUpdateMetadataInput;

      const result = await uploadService.bulkUpdateMetadata(userId, input.updates);

      const response: ApiResponse<BulkUpdateMetadataResult> = { data: result };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/media/bulk
   * Bulk delete multiple assets
   */
  async bulkDelete(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const input = req.body as BulkDeleteInput;

      const result = await uploadService.bulkDeleteAssets(userId, input.assetIds);

      const response: ApiResponse<BulkDeleteResult> = { data: result };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/media/:id/reset-metadata
   * Reset metadata to EXIF-extracted values (owner only)
   */
  async resetMetadata(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;

      const asset = await uploadService.resetMetadata(userId, assetId);

      const response: ApiResponse<MediaAssetDTO> = { data: asset };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
}

// Export singleton instance
export const mediaController = new MediaController();
