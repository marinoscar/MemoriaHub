import type { MediaShare, MediaShareDTO } from '@memoriahub/shared';
import { mediaShareRepository, MediaShareWithUsers } from '../../infrastructure/database/repositories/media-share.repository.js';
import { mediaAssetRepository } from '../../infrastructure/database/repositories/media-asset.repository.js';
import { userRepository } from '../../infrastructure/database/repositories/user.repository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * Media share service
 * Business logic for direct user-to-user media sharing
 */
export class MediaShareService {
  /**
   * Share media with one or more users
   * Only the owner or someone with access can share media
   */
  async shareMedia(
    userId: string,
    assetId: string,
    targetUserIds: string[]
  ): Promise<MediaShareDTO[]> {
    const traceId = getTraceId();

    if (targetUserIds.length === 0) {
      throw new ValidationError('At least one user ID is required');
    }

    // Check if asset exists
    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Media asset not found');
    }

    // Only the owner can share their media
    if (asset.ownerId !== userId) {
      throw new ForbiddenError('Only the owner can share this media');
    }

    // Can't share with yourself
    const filteredUserIds = targetUserIds.filter(id => id !== userId);
    if (filteredUserIds.length === 0) {
      throw new ValidationError('Cannot share media with yourself');
    }

    // Verify all target users exist
    const existingUsers = await Promise.all(
      filteredUserIds.map(id => userRepository.findById(id))
    );
    const nonExistentUsers = filteredUserIds.filter((_, index) => !existingUsers[index]);
    if (nonExistentUsers.length > 0) {
      throw new ValidationError(`Users not found: ${nonExistentUsers.join(', ')}`);
    }

    // Create shares
    const inputs = filteredUserIds.map(targetUserId => ({
      assetId,
      sharedWithUserId: targetUserId,
      sharedByUserId: userId,
    }));

    const shares = await mediaShareRepository.createMany(inputs);

    logger.info({
      eventType: 'media_share.service.shared',
      assetId,
      ownerId: userId,
      sharedWithCount: shares.length,
      traceId,
    }, `Media shared with ${shares.length} users`);

    // Get full share details with user info
    const sharesWithUsers = await mediaShareRepository.findByAssetId(assetId);
    return sharesWithUsers
      .filter(s => filteredUserIds.includes(s.sharedWithUserId))
      .map(this.shareToDTO);
  }

  /**
   * Revoke a share from a user
   */
  async revokeShare(userId: string, assetId: string, targetUserId: string): Promise<void> {
    const traceId = getTraceId();

    // Check if asset exists
    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Media asset not found');
    }

    // Only the owner can revoke shares
    if (asset.ownerId !== userId) {
      throw new ForbiddenError('Only the owner can revoke shares');
    }

    // Delete the share
    const deleted = await mediaShareRepository.delete(assetId, targetUserId);
    if (!deleted) {
      throw new NotFoundError('Share not found');
    }

    logger.info({
      eventType: 'media_share.service.revoked',
      assetId,
      ownerId: userId,
      revokedUserId: targetUserId,
      traceId,
    }, 'Media share revoked');
  }

  /**
   * Get all shares for a media asset
   * Only the owner can see who the asset is shared with
   */
  async getSharesForAsset(userId: string, assetId: string): Promise<MediaShareDTO[]> {
    // Check if asset exists and user has access
    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Media asset not found');
    }

    // Only the owner can see all shares
    if (asset.ownerId !== userId) {
      throw new ForbiddenError('Only the owner can view shares');
    }

    const shares = await mediaShareRepository.findByAssetId(assetId);
    return shares.map(this.shareToDTO);
  }

  /**
   * Get all media shared with a user
   */
  async getMediaSharedWithUser(userId: string): Promise<MediaShare[]> {
    return mediaShareRepository.findBySharedWithUserId(userId);
  }

  /**
   * Get all media shared by a user
   */
  async getMediaSharedByUser(userId: string): Promise<MediaShare[]> {
    return mediaShareRepository.findBySharedByUserId(userId);
  }

  /**
   * Check if user has a direct share to an asset
   */
  async hasDirectShare(userId: string, assetId: string): Promise<boolean> {
    return mediaShareRepository.exists(assetId, userId);
  }

  /**
   * Get count of shares for an asset
   */
  async getShareCount(assetId: string): Promise<number> {
    return mediaShareRepository.countByAssetId(assetId);
  }

  /**
   * Revoke all shares for an asset (used when deleting asset)
   */
  async revokeAllSharesForAsset(assetId: string): Promise<number> {
    return mediaShareRepository.deleteAllForAsset(assetId);
  }

  // ==================== Helpers ====================

  /**
   * Convert MediaShareWithUsers to DTO
   */
  private shareToDTO(share: MediaShareWithUsers): MediaShareDTO {
    return {
      id: share.id,
      assetId: share.assetId,
      sharedWithUserId: share.sharedWithUserId,
      sharedWithUserEmail: share.sharedWithEmail,
      sharedWithUserName: share.sharedWithName ?? undefined,
      sharedByUserId: share.sharedByUserId,
      sharedByUserEmail: share.sharedByEmail ?? undefined,
      sharedByUserName: share.sharedByName ?? undefined,
      createdAt: share.createdAt.toISOString(),
    };
  }
}

// Export singleton instance
export const mediaShareService = new MediaShareService();
