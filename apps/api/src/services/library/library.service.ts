import type {
  Library,
  LibraryDTO,
  LibraryMemberDTO,
  LibraryMemberRole,
  LibraryVisibility,
} from '@memoriahub/shared';
import { libraryRepository } from '../../infrastructure/database/repositories/library.repository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * Library service
 * Business logic for library management
 */
export class LibraryService {
  /**
   * Create a new library
   */
  async createLibrary(
    userId: string,
    input: { name: string; description?: string | null; visibility?: LibraryVisibility }
  ): Promise<LibraryDTO> {
    const traceId = getTraceId();

    // Create the library
    const library = await libraryRepository.create({
      ownerId: userId,
      name: input.name,
      description: input.description,
      visibility: input.visibility,
    });

    logger.info({
      eventType: 'library.service.created',
      libraryId: library.id,
      userId,
      traceId,
    }, 'Library created');

    return this.libraryToDTO(library);
  }

  /**
   * Get a library by ID
   */
  async getLibrary(userId: string, libraryId: string): Promise<LibraryDTO> {
    // Check access
    const hasAccess = await libraryRepository.hasAccess(userId, libraryId);
    if (!hasAccess) {
      throw new NotFoundError('Library not found');
    }

    const library = await libraryRepository.findByIdWithStats(libraryId);
    if (!library) {
      throw new NotFoundError('Library not found');
    }

    // Add cover URL if cover asset exists
    if (library.coverAssetId) {
      library.coverUrl = this.getCoverUrl(library.coverAssetId);
    }

    return library;
  }

  /**
   * List libraries for a user (owned + shared with them)
   */
  async listLibraries(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      visibility?: LibraryVisibility;
      includeShared?: boolean;
      sortBy?: 'name' | 'createdAt' | 'updatedAt';
      sortOrder?: 'asc' | 'desc';
    } = {}
  ): Promise<{ libraries: LibraryDTO[]; total: number; page: number; limit: number }> {
    const { includeShared = true, ...listOptions } = options;

    let result;
    if (includeShared) {
      result = await libraryRepository.findByMemberId(userId, listOptions);
    } else {
      result = await libraryRepository.findByOwnerId(userId, listOptions);
    }

    // Add cover URLs
    for (const library of result.libraries) {
      if (library.coverAssetId) {
        library.coverUrl = this.getCoverUrl(library.coverAssetId);
      }
    }

    return {
      libraries: result.libraries,
      total: result.total,
      page: options.page || 1,
      limit: options.limit || 20,
    };
  }

  /**
   * Update a library
   */
  async updateLibrary(
    userId: string,
    libraryId: string,
    input: { name?: string; description?: string | null; visibility?: LibraryVisibility; coverAssetId?: string | null }
  ): Promise<LibraryDTO> {
    // Check ownership/admin
    const isAdmin = await libraryRepository.isOwnerOrAdmin(userId, libraryId);
    if (!isAdmin) {
      throw new ForbiddenError('You do not have permission to update this library');
    }

    const library = await libraryRepository.update(libraryId, input);
    if (!library) {
      throw new NotFoundError('Library not found');
    }

    return this.libraryToDTO(library);
  }

  /**
   * Delete a library
   */
  async deleteLibrary(userId: string, libraryId: string): Promise<void> {
    const traceId = getTraceId();

    // Get library first to check ownership (only owner can delete)
    const library = await libraryRepository.findById(libraryId);
    if (!library) {
      throw new NotFoundError('Library not found');
    }

    if (library.ownerId !== userId) {
      throw new ForbiddenError('Only the library owner can delete it');
    }

    // Delete library (cascades to library_assets and library_members - media assets are NOT deleted)
    await libraryRepository.delete(libraryId);

    logger.info({
      eventType: 'library.service.deleted',
      libraryId,
      userId,
      traceId,
    }, 'Library deleted');
  }

  // ==================== Member Management ====================

  /**
   * Get library members
   */
  async getMembers(userId: string, libraryId: string): Promise<LibraryMemberDTO[]> {
    // Check access
    const hasAccess = await libraryRepository.hasAccess(userId, libraryId);
    if (!hasAccess) {
      throw new NotFoundError('Library not found');
    }

    return libraryRepository.getMembers(libraryId);
  }

  /**
   * Add a member to a library
   */
  async addMember(
    userId: string,
    libraryId: string,
    targetUserId: string,
    role: LibraryMemberRole = 'viewer'
  ): Promise<LibraryMemberDTO> {
    const traceId = getTraceId();

    // Check if user is owner/admin
    const isAdmin = await libraryRepository.isOwnerOrAdmin(userId, libraryId);
    if (!isAdmin) {
      throw new ForbiddenError('You do not have permission to add members');
    }

    // Check if library exists
    const library = await libraryRepository.findById(libraryId);
    if (!library) {
      throw new NotFoundError('Library not found');
    }

    // Can't add owner as member
    if (library.ownerId === targetUserId) {
      throw new ValidationError('Cannot add owner as a member');
    }

    // Check if already a member
    const existingMember = await libraryRepository.getMember(libraryId, targetUserId);
    if (existingMember) {
      throw new ValidationError('User is already a member of this library');
    }

    await libraryRepository.addMember(libraryId, targetUserId, role, userId);

    logger.info({
      eventType: 'library.service.member_added',
      libraryId,
      targetUserId,
      role,
      addedBy: userId,
      traceId,
    }, 'Member added to library');

    // Return with user info
    const members = await libraryRepository.getMembers(libraryId);
    const memberDTO = members.find((m) => m.userId === targetUserId);
    return memberDTO!;
  }

  /**
   * Update a member's role
   */
  async updateMemberRole(
    userId: string,
    libraryId: string,
    targetUserId: string,
    role: LibraryMemberRole
  ): Promise<LibraryMemberDTO> {
    // Check if user is owner/admin
    const isAdmin = await libraryRepository.isOwnerOrAdmin(userId, libraryId);
    if (!isAdmin) {
      throw new ForbiddenError('You do not have permission to update member roles');
    }

    const member = await libraryRepository.updateMemberRole(libraryId, targetUserId, role);
    if (!member) {
      throw new NotFoundError('Member not found');
    }

    // Return with user info
    const members = await libraryRepository.getMembers(libraryId);
    return members.find((m) => m.userId === targetUserId)!;
  }

  /**
   * Remove a member from a library
   */
  async removeMember(userId: string, libraryId: string, targetUserId: string): Promise<void> {
    const traceId = getTraceId();

    // Users can remove themselves, or admin can remove anyone
    if (userId !== targetUserId) {
      const isAdmin = await libraryRepository.isOwnerOrAdmin(userId, libraryId);
      if (!isAdmin) {
        throw new ForbiddenError('You do not have permission to remove members');
      }
    }

    const removed = await libraryRepository.removeMember(libraryId, targetUserId);
    if (!removed) {
      throw new NotFoundError('Member not found');
    }

    logger.info({
      eventType: 'library.service.member_removed',
      libraryId,
      targetUserId,
      removedBy: userId,
      traceId,
    }, 'Member removed from library');
  }

  // ==================== Permission Checks ====================

  /**
   * Check if user can upload to a library
   */
  async canUserUploadToLibrary(userId: string, libraryId: string): Promise<boolean> {
    return libraryRepository.canUpload(userId, libraryId);
  }

  /**
   * Check if user has access to a library
   */
  async canUserAccessLibrary(userId: string, libraryId: string): Promise<boolean> {
    return libraryRepository.hasAccess(userId, libraryId);
  }

  // ==================== Helpers ====================

  /**
   * Convert Library entity to DTO
   */
  private libraryToDTO(library: Library): LibraryDTO {
    return {
      id: library.id,
      ownerId: library.ownerId,
      name: library.name,
      description: library.description,
      visibility: library.visibility,
      coverAssetId: library.coverAssetId,
      coverUrl: null,
      createdAt: library.createdAt.toISOString(),
      updatedAt: library.updatedAt.toISOString(),
    };
  }

  /**
   * Get presigned URL for cover image
   */
  private getCoverUrl(_assetId: string): string | null {
    // Get thumbnail key from media asset
    // For now, return null - would need media asset repository
    return null;
  }
}

// Export singleton instance
export const libraryService = new LibraryService();
