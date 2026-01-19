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
   * List media assets in a library
   */
  async listMedia(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.libraryId;
      const query = req.query as Record<string, string | undefined>;

      const result = await uploadService.listAssets(userId, libraryId, {
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
}

// Export singleton instance
export const mediaController = new MediaController();
