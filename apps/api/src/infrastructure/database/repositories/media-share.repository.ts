import type { MediaShare } from '@memoriahub/shared';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';
import { getTraceId } from '../../logging/request-context.js';

/**
 * Database row type for media shares
 */
interface MediaShareRow {
  id: string;
  asset_id: string;
  shared_with_user_id: string;
  shared_by_user_id: string;
  created_at: Date;
}

/**
 * Extended row with user information
 */
interface MediaShareWithUserRow extends MediaShareRow {
  shared_with_email: string;
  shared_with_name: string | null;
  shared_by_email: string | null;
  shared_by_name: string | null;
}

/**
 * Convert database row to MediaShare entity
 */
function rowToMediaShare(row: MediaShareRow): MediaShare {
  return {
    id: row.id,
    assetId: row.asset_id,
    sharedWithUserId: row.shared_with_user_id,
    sharedByUserId: row.shared_by_user_id,
    createdAt: row.created_at,
  };
}

/**
 * MediaShare with user details for API responses
 */
export interface MediaShareWithUsers extends MediaShare {
  sharedWithEmail: string;
  sharedWithName: string | null;
  sharedByEmail: string | null;
  sharedByName: string | null;
}

/**
 * Convert row with user info to MediaShareWithUsers
 */
function rowToMediaShareWithUsers(row: MediaShareWithUserRow): MediaShareWithUsers {
  return {
    ...rowToMediaShare(row),
    sharedWithEmail: row.shared_with_email,
    sharedWithName: row.shared_with_name,
    sharedByEmail: row.shared_by_email,
    sharedByName: row.shared_by_name,
  };
}

/**
 * Input for creating a media share
 */
export interface CreateMediaShareInput {
  assetId: string;
  sharedWithUserId: string;
  sharedByUserId: string;
}

/**
 * Media share repository implementation
 */
export class MediaShareRepository {
  /**
   * Create a new media share
   */
  async create(input: CreateMediaShareInput): Promise<MediaShare> {
    const traceId = getTraceId();

    const result = await query<MediaShareRow>(
      `INSERT INTO media_shares (asset_id, shared_with_user_id, shared_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.assetId, input.sharedWithUserId, input.sharedByUserId]
    );

    const share = rowToMediaShare(result.rows[0]);

    logger.info({
      eventType: 'media_share.created',
      assetId: share.assetId,
      sharedWithUserId: share.sharedWithUserId,
      sharedByUserId: share.sharedByUserId,
      traceId,
    }, 'Media share created');

    return share;
  }

  /**
   * Create multiple shares at once
   */
  async createMany(inputs: CreateMediaShareInput[]): Promise<MediaShare[]> {
    if (inputs.length === 0) return [];

    const traceId = getTraceId();

    // Build bulk insert query
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const input of inputs) {
      placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      values.push(input.assetId, input.sharedWithUserId, input.sharedByUserId);
    }

    const result = await query<MediaShareRow>(
      `INSERT INTO media_shares (asset_id, shared_with_user_id, shared_by_user_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (asset_id, shared_with_user_id) DO NOTHING
       RETURNING *`,
      values
    );

    const shares = result.rows.map(rowToMediaShare);

    logger.info({
      eventType: 'media_share.bulk_created',
      count: shares.length,
      traceId,
    }, `Created ${shares.length} media shares`);

    return shares;
  }

  /**
   * Find a specific share
   */
  async findById(id: string): Promise<MediaShare | null> {
    const result = await query<MediaShareRow>(
      'SELECT * FROM media_shares WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToMediaShare(result.rows[0]);
  }

  /**
   * Find a share by asset and user
   */
  async findByAssetAndUser(assetId: string, userId: string): Promise<MediaShare | null> {
    const result = await query<MediaShareRow>(
      'SELECT * FROM media_shares WHERE asset_id = $1 AND shared_with_user_id = $2',
      [assetId, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToMediaShare(result.rows[0]);
  }

  /**
   * Find all shares for an asset (with user details)
   */
  async findByAssetId(assetId: string): Promise<MediaShareWithUsers[]> {
    const result = await query<MediaShareWithUserRow>(
      `SELECT
        ms.*,
        sw.email as shared_with_email,
        sw.display_name as shared_with_name,
        sb.email as shared_by_email,
        sb.display_name as shared_by_name
       FROM media_shares ms
       JOIN users sw ON ms.shared_with_user_id = sw.id
       LEFT JOIN users sb ON ms.shared_by_user_id = sb.id
       WHERE ms.asset_id = $1
       ORDER BY ms.created_at DESC`,
      [assetId]
    );

    return result.rows.map(rowToMediaShareWithUsers);
  }

  /**
   * Find all shares where user is the recipient (media shared with them)
   */
  async findBySharedWithUserId(userId: string): Promise<MediaShare[]> {
    const result = await query<MediaShareRow>(
      `SELECT * FROM media_shares WHERE shared_with_user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    return result.rows.map(rowToMediaShare);
  }

  /**
   * Find all shares created by a user (media they shared)
   */
  async findBySharedByUserId(userId: string): Promise<MediaShare[]> {
    const result = await query<MediaShareRow>(
      `SELECT * FROM media_shares WHERE shared_by_user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    return result.rows.map(rowToMediaShare);
  }

  /**
   * Check if a share exists
   */
  async exists(assetId: string, userId: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM media_shares
        WHERE asset_id = $1 AND shared_with_user_id = $2
      ) as exists`,
      [assetId, userId]
    );

    return result.rows[0].exists;
  }

  /**
   * Delete a share by asset and user
   */
  async delete(assetId: string, userId: string): Promise<boolean> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM media_shares WHERE asset_id = $1 AND shared_with_user_id = $2',
      [assetId, userId]
    );

    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted) {
      logger.info({
        eventType: 'media_share.deleted',
        assetId,
        sharedWithUserId: userId,
        traceId,
      }, 'Media share deleted');
    }

    return deleted;
  }

  /**
   * Delete all shares for an asset
   */
  async deleteAllForAsset(assetId: string): Promise<number> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM media_shares WHERE asset_id = $1',
      [assetId]
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.info({
        eventType: 'media_share.bulk_deleted',
        assetId,
        count,
        traceId,
      }, `Deleted ${count} shares for asset`);
    }

    return count;
  }

  /**
   * Count shares for an asset
   */
  async countByAssetId(assetId: string): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM media_shares WHERE asset_id = $1',
      [assetId]
    );

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Count shares for a user (media shared with them)
   */
  async countBySharedWithUserId(userId: string): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM media_shares WHERE shared_with_user_id = $1',
      [userId]
    );

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get all asset IDs shared with a user
   */
  async getSharedAssetIds(userId: string): Promise<string[]> {
    const result = await query<{ asset_id: string }>(
      'SELECT asset_id FROM media_shares WHERE shared_with_user_id = $1',
      [userId]
    );

    return result.rows.map(row => row.asset_id);
  }

  /**
   * Get all user IDs an asset is shared with
   */
  async getSharedUserIds(assetId: string): Promise<string[]> {
    const result = await query<{ shared_with_user_id: string }>(
      'SELECT shared_with_user_id FROM media_shares WHERE asset_id = $1',
      [assetId]
    );

    return result.rows.map(row => row.shared_with_user_id);
  }
}

// Export singleton instance
export const mediaShareRepository = new MediaShareRepository();
