/**
 * Media Share Controller
 *
 * Handles HTTP requests for direct user-to-user media sharing.
 * All endpoints require authentication.
 * Authorization is checked at the service layer.
 */

import type { Request, Response, NextFunction } from 'express';
import type { ApiResponse, MediaShareDTO, ShareMediaInput } from '@memoriahub/shared';
import { mediaShareService } from '../../services/media-share/media-share.service.js';

/**
 * Media share controller
 */
export class MediaShareController {
  /**
   * POST /api/media/:id/share
   * Share media with one or more users
   */
  async shareMedia(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;
      const input = req.body as ShareMediaInput;

      const shares = await mediaShareService.shareMedia(userId, assetId, input.userIds);

      const response: ApiResponse<MediaShareDTO[]> = { data: shares };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/media/:id/share/:userId
   * Revoke a share from a user
   */
  async revokeShare(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;
      const targetUserId = req.params.userId;

      await mediaShareService.revokeShare(userId, assetId, targetUserId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/media/:id/shares
   * List all shares for a media asset
   */
  async getShares(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;

      const shares = await mediaShareService.getSharesForAsset(userId, assetId);

      const response: ApiResponse<MediaShareDTO[]> = { data: shares };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
}

// Export singleton instance
export const mediaShareController = new MediaShareController();
