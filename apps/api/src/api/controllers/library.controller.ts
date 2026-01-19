/**
 * Library Controller
 *
 * Handles HTTP requests for library management.
 * All endpoints require authentication.
 * Authorization is checked at the service layer.
 */

import type { Request, Response, NextFunction } from 'express';
import type {
  ApiResponse,
  LibraryDTO,
  LibraryMemberDTO,
  CreateLibraryInput,
  UpdateLibraryInput,
  AddLibraryMemberInput,
  UpdateLibraryMemberInput,
} from '@memoriahub/shared';
import { libraryService } from '../../services/library/library.service.js';

/**
 * Library controller
 */
export class LibraryController {
  // ===========================================================================
  // Library CRUD
  // ===========================================================================

  /**
   * GET /api/libraries
   * List libraries accessible to the current user
   */
  async listLibraries(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const {
        page,
        limit,
        visibility,
        includeShared,
        sortBy,
        sortOrder,
      } = req.query;

      const result = await libraryService.listLibraries(userId, {
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        visibility: visibility as 'private' | 'shared' | 'public' | undefined,
        includeShared: includeShared === 'false' ? false : true,
        sortBy: sortBy as 'name' | 'createdAt' | 'updatedAt' | undefined,
        sortOrder: sortOrder as 'asc' | 'desc' | undefined,
      });

      const response: ApiResponse<LibraryDTO[]> = {
        data: result.libraries,
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
   * POST /api/libraries
   * Create a new library
   */
  async createLibrary(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const input = req.body as CreateLibraryInput;

      const library = await libraryService.createLibrary(userId, input);

      const response: ApiResponse<LibraryDTO> = { data: library };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/libraries/:id
   * Get a library by ID
   */
  async getLibrary(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;

      const library = await libraryService.getLibrary(userId, libraryId);

      const response: ApiResponse<LibraryDTO> = { data: library };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/libraries/:id
   * Update a library
   */
  async updateLibrary(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const input = req.body as UpdateLibraryInput;

      const library = await libraryService.updateLibrary(userId, libraryId, input);

      const response: ApiResponse<LibraryDTO> = { data: library };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/libraries/:id
   * Delete a library (owner only)
   */
  async deleteLibrary(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;

      await libraryService.deleteLibrary(userId, libraryId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  // ===========================================================================
  // Library Members
  // ===========================================================================

  /**
   * GET /api/libraries/:id/members
   * Get all members of a library
   */
  async getMembers(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;

      const members = await libraryService.getMembers(userId, libraryId);

      const response: ApiResponse<LibraryMemberDTO[]> = { data: members };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/libraries/:id/members
   * Add a member to a library
   */
  async addMember(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const input = req.body as AddLibraryMemberInput;

      const member = await libraryService.addMember(
        userId,
        libraryId,
        input.userId,
        input.role
      );

      const response: ApiResponse<LibraryMemberDTO> = { data: member };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/libraries/:id/members/:userId
   * Update a member's role
   */
  async updateMember(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const targetUserId = req.params.userId;
      const input = req.body as UpdateLibraryMemberInput;

      const member = await libraryService.updateMemberRole(
        userId,
        libraryId,
        targetUserId,
        input.role
      );

      const response: ApiResponse<LibraryMemberDTO> = { data: member };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/libraries/:id/members/:userId
   * Remove a member from a library
   */
  async removeMember(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user!.id;
      const libraryId = req.params.id;
      const targetUserId = req.params.userId;

      await libraryService.removeMember(userId, libraryId, targetUserId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}

// Export singleton instance
export const libraryController = new LibraryController();
