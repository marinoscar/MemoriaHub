import type {
  Library,
  LibraryDTO,
  LibraryVisibility,
  LibraryMember,
  LibraryMemberDTO,
  LibraryMemberRole,
} from '@memoriahub/shared';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';
import { getTraceId } from '../../logging/request-context.js';

/**
 * Database row type for libraries
 */
interface LibraryRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  visibility: LibraryVisibility;
  cover_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Database row type for library members
 */
interface LibraryMemberRow {
  id: string;
  library_id: string;
  user_id: string;
  role: LibraryMemberRole;
  invited_by: string | null;
  created_at: Date;
}

/**
 * Extended library row with owner info and stats
 */
interface LibraryWithStatsRow extends LibraryRow {
  owner_email?: string;
  owner_display_name?: string;
  asset_count?: string;
}

/**
 * Extended member row with user info
 */
interface LibraryMemberWithUserRow extends LibraryMemberRow {
  user_email: string;
  user_display_name: string | null;
  user_avatar_url: string | null;
}

/**
 * Convert database row to Library entity
 */
function rowToLibrary(row: LibraryRow): Library {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    coverAssetId: row.cover_asset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to LibraryDTO
 */
function rowToLibraryDTO(row: LibraryWithStatsRow): LibraryDTO {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_display_name || undefined,
    ownerEmail: row.owner_email || undefined,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    coverAssetId: row.cover_asset_id,
    coverUrl: null, // Set by service layer
    assetCount: row.asset_count ? parseInt(row.asset_count, 10) : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Convert database row to LibraryMember entity
 */
function rowToLibraryMember(row: LibraryMemberRow): LibraryMember {
  return {
    id: row.id,
    libraryId: row.library_id,
    userId: row.user_id,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
  };
}

/**
 * Convert database row to LibraryMemberDTO
 */
function rowToLibraryMemberDTO(row: LibraryMemberWithUserRow): LibraryMemberDTO {
  return {
    id: row.id,
    libraryId: row.library_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_display_name || undefined,
    userAvatar: row.user_avatar_url,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Input for creating a library
 */
export interface CreateLibraryInput {
  ownerId: string;
  name: string;
  description?: string | null;
  visibility?: LibraryVisibility;
}

/**
 * Input for updating a library
 */
export interface UpdateLibraryInput {
  name?: string;
  description?: string | null;
  visibility?: LibraryVisibility;
  coverAssetId?: string | null;
}

/**
 * Options for listing libraries
 */
export interface ListLibrariesOptions {
  page?: number;
  limit?: number;
  visibility?: LibraryVisibility;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Library repository implementation
 */
export class LibraryRepository {
  /**
   * Find library by ID
   */
  async findById(id: string): Promise<Library | null> {
    const result = await query<LibraryRow>(
      'SELECT * FROM libraries WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLibrary(result.rows[0]);
  }

  /**
   * Find library by ID with stats and owner info
   */
  async findByIdWithStats(id: string): Promise<LibraryDTO | null> {
    const result = await query<LibraryWithStatsRow>(
      `SELECT l.*,
              u.email as owner_email,
              u.display_name as owner_display_name,
              COUNT(la.id)::text as asset_count
       FROM libraries l
       JOIN users u ON l.owner_id = u.id
       LEFT JOIN library_assets la ON la.library_id = l.id
       WHERE l.id = $1
       GROUP BY l.id, u.email, u.display_name`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLibraryDTO(result.rows[0]);
  }

  /**
   * Find libraries owned by a user
   */
  async findByOwnerId(
    ownerId: string,
    options: ListLibrariesOptions = {}
  ): Promise<{ libraries: LibraryDTO[]; total: number }> {
    const {
      page = 1,
      limit = 20,
      visibility,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;
    const offset = (page - 1) * limit;

    // Build WHERE clause
    const conditions: string[] = ['l.owner_id = $1'];
    const params: unknown[] = [ownerId];
    let paramIndex = 2;

    if (visibility) {
      conditions.push(`l.visibility = $${paramIndex++}`);
      params.push(visibility);
    }

    const whereClause = conditions.join(' AND ');

    // Map sortBy to column
    const sortColumn = sortBy === 'name' ? 'l.name' : sortBy === 'updatedAt' ? 'l.updated_at' : 'l.created_at';

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM libraries l WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get libraries
    const result = await query<LibraryWithStatsRow>(
      `SELECT l.*,
              u.email as owner_email,
              u.display_name as owner_display_name,
              COUNT(la.id)::text as asset_count
       FROM libraries l
       JOIN users u ON l.owner_id = u.id
       LEFT JOIN library_assets la ON la.library_id = l.id
       WHERE ${whereClause}
       GROUP BY l.id, u.email, u.display_name
       ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      libraries: result.rows.map(rowToLibraryDTO),
      total,
    };
  }

  /**
   * Find libraries where user is a member (including owned)
   */
  async findByMemberId(
    userId: string,
    options: ListLibrariesOptions = {}
  ): Promise<{ libraries: LibraryDTO[]; total: number }> {
    const {
      page = 1,
      limit = 20,
      visibility,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;
    const offset = (page - 1) * limit;

    // Build WHERE clause
    const conditions: string[] = ['(l.owner_id = $1 OR lm.user_id = $1)'];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    if (visibility) {
      conditions.push(`l.visibility = $${paramIndex++}`);
      params.push(visibility);
    }

    const whereClause = conditions.join(' AND ');
    const sortColumn = sortBy === 'name' ? 'l.name' : sortBy === 'updatedAt' ? 'l.updated_at' : 'l.created_at';

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(DISTINCT l.id)::text as count
       FROM libraries l
       LEFT JOIN library_members lm ON lm.library_id = l.id
       WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get libraries
    const result = await query<LibraryWithStatsRow>(
      `SELECT DISTINCT ON (l.id) l.*,
              u.email as owner_email,
              u.display_name as owner_display_name,
              (SELECT COUNT(*)::text FROM library_assets la WHERE la.library_id = l.id) as asset_count
       FROM libraries l
       JOIN users u ON l.owner_id = u.id
       LEFT JOIN library_members lm ON lm.library_id = l.id
       WHERE ${whereClause}
       ORDER BY l.id, ${sortColumn} ${sortOrder.toUpperCase()}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      libraries: result.rows.map(rowToLibraryDTO),
      total,
    };
  }

  /**
   * Create a new library
   */
  async create(input: CreateLibraryInput): Promise<Library> {
    const traceId = getTraceId();

    const result = await query<LibraryRow>(
      `INSERT INTO libraries (owner_id, name, description, visibility)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        input.ownerId,
        input.name,
        input.description ?? null,
        input.visibility ?? 'private',
      ]
    );

    const library = rowToLibrary(result.rows[0]);

    logger.info({
      eventType: 'library.created',
      libraryId: library.id,
      ownerId: library.ownerId,
      visibility: library.visibility,
      traceId,
    }, 'Library created');

    return library;
  }

  /**
   * Update a library
   */
  async update(id: string, input: UpdateLibraryInput): Promise<Library | null> {
    const traceId = getTraceId();
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(input.description);
    }
    if (input.visibility !== undefined) {
      updates.push(`visibility = $${paramIndex++}`);
      values.push(input.visibility);
    }
    if (input.coverAssetId !== undefined) {
      updates.push(`cover_asset_id = $${paramIndex++}`);
      values.push(input.coverAssetId);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    const result = await query<LibraryRow>(
      `UPDATE libraries SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    const library = rowToLibrary(result.rows[0]);

    logger.info({
      eventType: 'library.updated',
      libraryId: library.id,
      updates: Object.keys(input),
      traceId,
    }, 'Library updated');

    return library;
  }

  /**
   * Delete a library
   */
  async delete(id: string): Promise<boolean> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM libraries WHERE id = $1',
      [id]
    );

    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted) {
      logger.info({
        eventType: 'library.deleted',
        libraryId: id,
        traceId,
      }, 'Library deleted');
    }

    return deleted;
  }

  /**
   * Check if user has access to library
   */
  async hasAccess(userId: string, libraryId: string): Promise<boolean> {
    const result = await query<{ has_access: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM libraries l
        WHERE l.id = $2 AND (
          l.owner_id = $1 OR
          l.visibility = 'public' OR
          EXISTS(SELECT 1 FROM library_members lm WHERE lm.library_id = l.id AND lm.user_id = $1)
        )
      ) as has_access`,
      [userId, libraryId]
    );

    return result.rows[0].has_access;
  }

  /**
   * Check if user can upload to library
   */
  async canUpload(userId: string, libraryId: string): Promise<boolean> {
    const result = await query<{ can_upload: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM libraries l
        WHERE l.id = $2 AND (
          l.owner_id = $1 OR
          EXISTS(
            SELECT 1 FROM library_members lm
            WHERE lm.library_id = l.id AND lm.user_id = $1 AND lm.role IN ('contributor', 'admin')
          )
        )
      ) as can_upload`,
      [userId, libraryId]
    );

    return result.rows[0].can_upload;
  }

  /**
   * Check if user is library owner or admin
   */
  async isOwnerOrAdmin(userId: string, libraryId: string): Promise<boolean> {
    const result = await query<{ is_admin: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM libraries l
        WHERE l.id = $2 AND (
          l.owner_id = $1 OR
          EXISTS(
            SELECT 1 FROM library_members lm
            WHERE lm.library_id = l.id AND lm.user_id = $1 AND lm.role = 'admin'
          )
        )
      ) as is_admin`,
      [userId, libraryId]
    );

    return result.rows[0].is_admin;
  }

  // ==================== Member Management ====================

  /**
   * Get library members
   */
  async getMembers(libraryId: string): Promise<LibraryMemberDTO[]> {
    const result = await query<LibraryMemberWithUserRow>(
      `SELECT lm.*, u.email as user_email, u.display_name as user_display_name, u.avatar_url as user_avatar_url
       FROM library_members lm
       JOIN users u ON lm.user_id = u.id
       WHERE lm.library_id = $1
       ORDER BY lm.created_at ASC`,
      [libraryId]
    );

    return result.rows.map(rowToLibraryMemberDTO);
  }

  /**
   * Get a single member
   */
  async getMember(libraryId: string, userId: string): Promise<LibraryMember | null> {
    const result = await query<LibraryMemberRow>(
      'SELECT * FROM library_members WHERE library_id = $1 AND user_id = $2',
      [libraryId, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToLibraryMember(result.rows[0]);
  }

  /**
   * Add a member to a library
   */
  async addMember(
    libraryId: string,
    userId: string,
    role: LibraryMemberRole,
    invitedBy: string
  ): Promise<LibraryMember> {
    const traceId = getTraceId();

    const result = await query<LibraryMemberRow>(
      `INSERT INTO library_members (library_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [libraryId, userId, role, invitedBy]
    );

    const member = rowToLibraryMember(result.rows[0]);

    logger.info({
      eventType: 'library.member_added',
      libraryId,
      userId,
      role,
      invitedBy,
      traceId,
    }, 'Member added to library');

    return member;
  }

  /**
   * Update a member's role
   */
  async updateMemberRole(
    libraryId: string,
    userId: string,
    role: LibraryMemberRole
  ): Promise<LibraryMember | null> {
    const traceId = getTraceId();

    const result = await query<LibraryMemberRow>(
      `UPDATE library_members SET role = $3
       WHERE library_id = $1 AND user_id = $2
       RETURNING *`,
      [libraryId, userId, role]
    );

    if (result.rows.length === 0) {
      return null;
    }

    logger.info({
      eventType: 'library.member_role_changed',
      libraryId,
      userId,
      newRole: role,
      traceId,
    }, 'Member role updated');

    return rowToLibraryMember(result.rows[0]);
  }

  /**
   * Remove a member from a library
   */
  async removeMember(libraryId: string, userId: string): Promise<boolean> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM library_members WHERE library_id = $1 AND user_id = $2',
      [libraryId, userId]
    );

    const removed = (result.rowCount ?? 0) > 0;

    if (removed) {
      logger.info({
        eventType: 'library.member_removed',
        libraryId,
        userId,
        traceId,
      }, 'Member removed from library');
    }

    return removed;
  }
}

// Export singleton instance
export const libraryRepository = new LibraryRepository();
