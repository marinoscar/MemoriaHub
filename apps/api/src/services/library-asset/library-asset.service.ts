import type { LibraryAsset, LibraryAssetDTO, MediaAsset } from '@memoriahub/shared';
import { libraryAssetRepository, LibraryAssetWithUser } from '../../infrastructure/database/repositories/library-asset.repository.js';
import { libraryRepository } from '../../infrastructure/database/repositories/library.repository.js';
import { mediaAssetRepository } from '../../infrastructure/database/repositories/media-asset.repository.js';
import { mediaShareRepository } from '../../infrastructure/database/repositories/media-share.repository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * Library asset service
 * Business logic for managing media assets in libraries (many-to-many)
 */
export class LibraryAssetService {
  /**
   * Add an asset to a library
   * User must have access to both the asset and have upload permission to the library
   */
  async addAssetToLibrary(
    userId: string,
    libraryId: string,
    assetId: string
  ): Promise<LibraryAssetDTO> {
    const traceId = getTraceId();

    // Check if library exists and user can upload to it
    const canUpload = await libraryRepository.canUpload(userId, libraryId);
    if (!canUpload) {
      throw new ForbiddenError('You do not have permission to add assets to this library');
    }

    // Check if asset exists
    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Media asset not found');
    }

    // Check if user has access to the asset
    const hasAccess = await this.userCanAccessAsset(userId, asset);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this media asset');
    }

    // Check if already in library
    const exists = await libraryAssetRepository.exists(libraryId, assetId);
    if (exists) {
      throw new ValidationError('Asset is already in this library');
    }

    // Add to library
    const libraryAsset = await libraryAssetRepository.add({
      libraryId,
      assetId,
      addedByUserId: userId,
    });

    logger.info({
      eventType: 'library_asset.service.added',
      libraryId,
      assetId,
      addedByUserId: userId,
      traceId,
    }, 'Asset added to library');

    return this.libraryAssetToDTO(libraryAsset);
  }

  /**
   * Add multiple assets to a library at once
   */
  async addAssetsToLibrary(
    userId: string,
    libraryId: string,
    assetIds: string[]
  ): Promise<{ added: LibraryAssetDTO[]; skipped: string[]; errors: string[] }> {
    const traceId = getTraceId();

    if (assetIds.length === 0) {
      return { added: [], skipped: [], errors: [] };
    }

    // Check if library exists and user can upload to it
    const canUpload = await libraryRepository.canUpload(userId, libraryId);
    if (!canUpload) {
      throw new ForbiddenError('You do not have permission to add assets to this library');
    }

    const added: LibraryAsset[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const assetId of assetIds) {
      try {
        // Check if asset exists
        const asset = await mediaAssetRepository.findById(assetId);
        if (!asset) {
          errors.push(`${assetId}: Asset not found`);
          continue;
        }

        // Check if user has access to the asset
        const hasAccess = await this.userCanAccessAsset(userId, asset);
        if (!hasAccess) {
          errors.push(`${assetId}: No access to asset`);
          continue;
        }

        // Check if already in library
        const exists = await libraryAssetRepository.exists(libraryId, assetId);
        if (exists) {
          skipped.push(assetId);
          continue;
        }

        // Add to library
        const libraryAsset = await libraryAssetRepository.add({
          libraryId,
          assetId,
          addedByUserId: userId,
        });

        added.push(libraryAsset);
      } catch (error) {
        errors.push(`${assetId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    logger.info({
      eventType: 'library_asset.service.bulk_added',
      libraryId,
      addedCount: added.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
      addedByUserId: userId,
      traceId,
    }, `Added ${added.length} assets to library`);

    return {
      added: added.map(this.libraryAssetToDTO),
      skipped,
      errors,
    };
  }

  /**
   * Remove an asset from a library
   * User must have upload permission to the library
   */
  async removeAssetFromLibrary(
    userId: string,
    libraryId: string,
    assetId: string
  ): Promise<void> {
    const traceId = getTraceId();

    // Check if user can upload to library (implies can manage assets)
    const canUpload = await libraryRepository.canUpload(userId, libraryId);
    if (!canUpload) {
      throw new ForbiddenError('You do not have permission to remove assets from this library');
    }

    // Check if the relationship exists
    const exists = await libraryAssetRepository.exists(libraryId, assetId);
    if (!exists) {
      throw new NotFoundError('Asset is not in this library');
    }

    // Remove from library
    await libraryAssetRepository.remove(libraryId, assetId);

    logger.info({
      eventType: 'library_asset.service.removed',
      libraryId,
      assetId,
      removedByUserId: userId,
      traceId,
    }, 'Asset removed from library');
  }

  /**
   * Remove multiple assets from a library
   */
  async removeAssetsFromLibrary(
    userId: string,
    libraryId: string,
    assetIds: string[]
  ): Promise<number> {
    const traceId = getTraceId();

    if (assetIds.length === 0) {
      return 0;
    }

    // Check if user can upload to library
    const canUpload = await libraryRepository.canUpload(userId, libraryId);
    if (!canUpload) {
      throw new ForbiddenError('You do not have permission to remove assets from this library');
    }

    const count = await libraryAssetRepository.removeMany(libraryId, assetIds);

    logger.info({
      eventType: 'library_asset.service.bulk_removed',
      libraryId,
      removedCount: count,
      removedByUserId: userId,
      traceId,
    }, `Removed ${count} assets from library`);

    return count;
  }

  /**
   * Get all library asset records for a library
   */
  async getLibraryAssets(userId: string, libraryId: string): Promise<LibraryAssetWithUser[]> {
    // Check if user has access to library
    const hasAccess = await libraryRepository.hasAccess(userId, libraryId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this library');
    }

    return libraryAssetRepository.findByLibraryId(libraryId);
  }

  /**
   * Get all libraries containing an asset
   */
  async getLibrariesForAsset(userId: string, assetId: string): Promise<string[]> {
    // Check if user has access to the asset
    const canAccess = await mediaAssetRepository.canAccess(assetId, userId);
    if (!canAccess) {
      throw new ForbiddenError('You do not have access to this media asset');
    }

    // Return only libraries the user can access
    return libraryAssetRepository.getAccessibleLibraryIdsForAsset(userId, assetId);
  }

  /**
   * Check if an asset is in a library
   */
  async isAssetInLibrary(libraryId: string, assetId: string): Promise<boolean> {
    return libraryAssetRepository.exists(libraryId, assetId);
  }

  /**
   * Get count of assets in a library
   */
  async getAssetCount(libraryId: string): Promise<number> {
    return libraryAssetRepository.countByLibraryId(libraryId);
  }

  /**
   * Get asset counts for multiple libraries
   */
  async getAssetCountsForLibraries(libraryIds: string[]): Promise<Map<string, number>> {
    return libraryAssetRepository.getAssetCountsForLibraries(libraryIds);
  }

  // ==================== Helpers ====================

  /**
   * Check if user can access an asset
   * User can access if they:
   * - Own the asset
   * - Have a direct share
   * - Are member of a library containing the asset
   */
  private async userCanAccessAsset(userId: string, asset: MediaAsset): Promise<boolean> {
    // Owner always has access
    if (asset.ownerId === userId) {
      return true;
    }

    // Check for direct share
    const hasShare = await mediaShareRepository.exists(asset.id, userId);
    if (hasShare) {
      return true;
    }

    // Check for library access
    const hasLibraryAccess = await libraryAssetRepository.userHasLibraryAccessToAsset(userId, asset.id);
    return hasLibraryAccess;
  }

  /**
   * Convert LibraryAsset to DTO
   */
  private libraryAssetToDTO(libraryAsset: LibraryAsset): LibraryAssetDTO {
    return {
      id: libraryAsset.id,
      libraryId: libraryAsset.libraryId,
      assetId: libraryAsset.assetId,
      addedByUserId: libraryAsset.addedByUserId,
      createdAt: libraryAsset.createdAt.toISOString(),
    };
  }
}

// Export singleton instance
export const libraryAssetService = new LibraryAssetService();
