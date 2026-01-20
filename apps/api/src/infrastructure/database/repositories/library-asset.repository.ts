import type { LibraryAsset, MediaAssetStatus, MediaType } from '@memoriahub/shared';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';
import { getTraceId } from '../../logging/request-context.js';

/**
 * Database row type for library assets
 */
interface LibraryAssetRow {
  id: string;
  library_id: string;
  asset_id: string;
  added_by_user_id: string;
  created_at: Date;
}

/**
 * Extended row with user information
 */
interface LibraryAssetWithUserRow extends LibraryAssetRow {
  added_by_email: string | null;
  added_by_name: string | null;
}

/**
 * Convert database row to LibraryAsset entity
 */
function rowToLibraryAsset(row: LibraryAssetRow): LibraryAsset {
  return {
    id: row.id,
    libraryId: row.library_id,
    assetId: row.asset_id,
    addedByUserId: row.added_by_user_id,
    createdAt: row.created_at,
  };
}

/**
 * LibraryAsset with user details for API responses
 */
export interface LibraryAssetWithUser extends LibraryAsset {
  addedByEmail: string | null;
  addedByName: string | null;
}

/**
 * Convert row with user info to LibraryAssetWithUser
 */
function rowToLibraryAssetWithUser(row: LibraryAssetWithUserRow): LibraryAssetWithUser {
  return {
    ...rowToLibraryAsset(row),
    addedByEmail: row.added_by_email,
    addedByName: row.added_by_name,
  };
}

/**
 * Input for adding an asset to a library
 */
export interface AddLibraryAssetInput {
  libraryId: string;
  assetId: string;
  addedByUserId: string;
}

/**
 * Options for listing library assets
 */
export interface ListLibraryAssetsOptions {
  libraryId: string;
  page?: number;
  limit?: number;
  status?: MediaAssetStatus;
  mediaType?: MediaType;
  sortBy?: 'addedAt' | 'capturedAt' | 'filename';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Library asset repository implementation
 */
export class LibraryAssetRepository {
  /**
   * Add an asset to a library
   */
  async add(input: AddLibraryAssetInput): Promise<LibraryAsset> {
    const traceId = getTraceId();

    const result = await query<LibraryAssetRow>(
      `INSERT INTO library_assets (library_id, asset_id, added_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.libraryId, input.assetId, input.addedByUserId]
    );

    const libraryAsset = rowToLibraryAsset(result.rows[0]);

    logger.info({
      eventType: 'library_asset.added',
      libraryId: libraryAsset.libraryId,
      assetId: libraryAsset.assetId,
      addedByUserId: libraryAsset.addedByUserId,
      traceId,
    }, 'Asset added to library');

    return libraryAsset;
  }

  /**
   * Add multiple assets to a library at once
   */
  async addMany(inputs: AddLibraryAssetInput[]): Promise<LibraryAsset[]> {
    if (inputs.length === 0) return [];

    const traceId = getTraceId();

    // Build bulk insert query
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const input of inputs) {
      placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      values.push(input.libraryId, input.assetId, input.addedByUserId);
    }

    const result = await query<LibraryAssetRow>(
      `INSERT INTO library_assets (library_id, asset_id, added_by_user_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (library_id, asset_id) DO NOTHING
       RETURNING *`,
      values
    );

    const libraryAssets = result.rows.map(rowToLibraryAsset);

    logger.info({
      eventType: 'library_asset.bulk_added',
      libraryId: inputs[0].libraryId,
      count: libraryAssets.length,
      traceId,
    }, `Added ${libraryAssets.length} assets to library`);

    return libraryAssets;
  }

  /**
   * Find a library asset record
   */
  async findById(id: string): Promise<LibraryAsset | null> {
    const result = await query<LibraryAssetRow>(
      'SELECT * FROM library_assets WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLibraryAsset(result.rows[0]);
  }

  /**
   * Find a library asset by library and asset IDs
   */
  async findByLibraryAndAsset(libraryId: string, assetId: string): Promise<LibraryAsset | null> {
    const result = await query<LibraryAssetRow>(
      'SELECT * FROM library_assets WHERE library_id = $1 AND asset_id = $2',
      [libraryId, assetId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLibraryAsset(result.rows[0]);
  }

  /**
   * Check if an asset exists in a library
   */
  async exists(libraryId: string, assetId: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM library_assets
        WHERE library_id = $1 AND asset_id = $2
      ) as exists`,
      [libraryId, assetId]
    );

    return result.rows[0].exists;
  }

  /**
   * Find all library asset records for a library
   */
  async findByLibraryId(libraryId: string): Promise<LibraryAssetWithUser[]> {
    const result = await query<LibraryAssetWithUserRow>(
      `SELECT
        la.*,
        u.email as added_by_email,
        u.display_name as added_by_name
       FROM library_assets la
       LEFT JOIN users u ON la.added_by_user_id = u.id
       WHERE la.library_id = $1
       ORDER BY la.created_at DESC`,
      [libraryId]
    );

    return result.rows.map(rowToLibraryAssetWithUser);
  }

  /**
   * Find all libraries containing an asset
   */
  async findLibrariesForAsset(assetId: string): Promise<LibraryAsset[]> {
    const result = await query<LibraryAssetRow>(
      `SELECT * FROM library_assets WHERE asset_id = $1 ORDER BY created_at DESC`,
      [assetId]
    );

    return result.rows.map(rowToLibraryAsset);
  }

  /**
   * Get library IDs containing an asset
   */
  async getLibraryIdsForAsset(assetId: string): Promise<string[]> {
    const result = await query<{ library_id: string }>(
      'SELECT library_id FROM library_assets WHERE asset_id = $1',
      [assetId]
    );

    return result.rows.map(row => row.library_id);
  }

  /**
   * Get asset IDs in a library
   */
  async getAssetIdsInLibrary(libraryId: string): Promise<string[]> {
    const result = await query<{ asset_id: string }>(
      'SELECT asset_id FROM library_assets WHERE library_id = $1',
      [libraryId]
    );

    return result.rows.map(row => row.asset_id);
  }

  /**
   * Remove an asset from a library
   */
  async remove(libraryId: string, assetId: string): Promise<boolean> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM library_assets WHERE library_id = $1 AND asset_id = $2',
      [libraryId, assetId]
    );

    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted) {
      logger.info({
        eventType: 'library_asset.removed',
        libraryId,
        assetId,
        traceId,
      }, 'Asset removed from library');
    }

    return deleted;
  }

  /**
   * Remove multiple assets from a library
   */
  async removeMany(libraryId: string, assetIds: string[]): Promise<number> {
    if (assetIds.length === 0) return 0;

    const traceId = getTraceId();

    const result = await query(
      `DELETE FROM library_assets WHERE library_id = $1 AND asset_id = ANY($2)`,
      [libraryId, assetIds]
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.info({
        eventType: 'library_asset.bulk_removed',
        libraryId,
        count,
        traceId,
      }, `Removed ${count} assets from library`);
    }

    return count;
  }

  /**
   * Remove all assets from a library
   */
  async removeAllFromLibrary(libraryId: string): Promise<number> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM library_assets WHERE library_id = $1',
      [libraryId]
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.info({
        eventType: 'library_asset.all_removed',
        libraryId,
        count,
        traceId,
      }, `Removed all ${count} assets from library`);
    }

    return count;
  }

  /**
   * Remove an asset from all libraries
   */
  async removeFromAllLibraries(assetId: string): Promise<number> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM library_assets WHERE asset_id = $1',
      [assetId]
    );

    const count = result.rowCount ?? 0;

    if (count > 0) {
      logger.info({
        eventType: 'library_asset.removed_from_all',
        assetId,
        count,
        traceId,
      }, `Removed asset from ${count} libraries`);
    }

    return count;
  }

  /**
   * Count assets in a library
   */
  async countByLibraryId(libraryId: string): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM library_assets WHERE library_id = $1',
      [libraryId]
    );

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Count libraries containing an asset
   */
  async countLibrariesForAsset(assetId: string): Promise<number> {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::text as count FROM library_assets WHERE asset_id = $1',
      [assetId]
    );

    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get asset counts per library for multiple libraries
   */
  async getAssetCountsForLibraries(libraryIds: string[]): Promise<Map<string, number>> {
    if (libraryIds.length === 0) return new Map();

    const result = await query<{ library_id: string; count: string }>(
      `SELECT library_id, COUNT(*)::text as count
       FROM library_assets
       WHERE library_id = ANY($1)
       GROUP BY library_id`,
      [libraryIds]
    );

    const counts = new Map<string, number>();
    for (const row of result.rows) {
      counts.set(row.library_id, parseInt(row.count, 10));
    }

    // Ensure all requested libraries have a count (default 0)
    for (const id of libraryIds) {
      if (!counts.has(id)) {
        counts.set(id, 0);
      }
    }

    return counts;
  }

  /**
   * Check if user has any accessible library containing the asset
   * (used for access control)
   */
  async userHasLibraryAccessToAsset(userId: string, assetId: string): Promise<boolean> {
    const result = await query<{ has_access: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM library_assets la
        JOIN libraries l ON la.library_id = l.id
        LEFT JOIN library_members lm ON lm.library_id = l.id AND lm.user_id = $1
        WHERE la.asset_id = $2
        AND (
          l.owner_id = $1
          OR lm.user_id IS NOT NULL
          OR l.visibility = 'public'
        )
      ) as has_access`,
      [userId, assetId]
    );

    return result.rows[0].has_access;
  }

  /**
   * Get all library IDs a user can access that contain the asset
   */
  async getAccessibleLibraryIdsForAsset(userId: string, assetId: string): Promise<string[]> {
    const result = await query<{ library_id: string }>(
      `SELECT DISTINCT la.library_id
       FROM library_assets la
       JOIN libraries l ON la.library_id = l.id
       LEFT JOIN library_members lm ON lm.library_id = l.id AND lm.user_id = $1
       WHERE la.asset_id = $2
       AND (
         l.owner_id = $1
         OR lm.user_id IS NOT NULL
         OR l.visibility = 'public'
       )`,
      [userId, assetId]
    );

    return result.rows.map(row => row.library_id);
  }
}

// Export singleton instance
export const libraryAssetRepository = new LibraryAssetRepository();
