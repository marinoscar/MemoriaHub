/**
 * Library Asset Controller
 *
 * Handles HTTP requests for managing assets in libraries (many-to-many).
 * All endpoints require authentication.
 * Authorization is checked at the service layer.
 */

import type { Request, Response, NextFunction } from 'express';
import type {
  ApiResponse,
  LibraryAssetDTO,
  AddAssetToLibraryInput,
  AddAssetsToLibraryInput,
} from '@memoriahub/shared';
import { libraryAssetService } from '../../services/library-asset/library-asset.service.js';

/**
 * Library asset controller
 */
export class LibraryAssetController {
  /**
   * POST /api/libraries/:id/assets
   * Add an asset to a library
   */
  async addAsset(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const input = req.body as AddAssetToLibraryInput;

      const libraryAsset = await libraryAssetService.addAssetToLibrary(
        userId,
        libraryId,
        input.assetId
      );

      const response: ApiResponse<LibraryAssetDTO> = { data: libraryAsset };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/libraries/:id/assets/bulk
   * Add multiple assets to a library at once
   */
  async addAssets(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const input = req.body as AddAssetsToLibraryInput;

      const result = await libraryAssetService.addAssetsToLibrary(
        userId,
        libraryId,
        input.assetIds
      );

      const response: ApiResponse<{
        added: LibraryAssetDTO[];
        skipped: string[];
        errors: string[];
      }> = { data: result };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/libraries/:id/assets/:assetId
   * Remove an asset from a library
   */
  async removeAsset(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const assetId = req.params.assetId;

      await libraryAssetService.removeAssetFromLibrary(userId, libraryId, assetId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/media/:id/libraries
   * Get all libraries containing an asset (that the user can access)
   */
  async getLibrariesForAsset(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const assetId = req.params.id;

      const libraryIds = await libraryAssetService.getLibrariesForAsset(userId, assetId);

      const response: ApiResponse<string[]> = { data: libraryIds };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
}

// Export singleton instance
export const libraryAssetController = new LibraryAssetController();
