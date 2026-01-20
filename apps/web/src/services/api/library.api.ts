/**
 * Library API Service
 *
 * API calls for library management.
 */

import type {
  ApiResponse,
  LibraryDTO,
  LibraryMemberDTO,
  CreateLibraryInput,
  UpdateLibraryInput,
  LibraryMemberRole,
  LibraryAssetDTO,
  AddAssetsToLibraryInput,
} from '@memoriahub/shared';
import { apiClient } from './client';

/**
 * List libraries query parameters
 */
export interface ListLibrariesParams {
  page?: number;
  limit?: number;
  visibility?: 'private' | 'shared' | 'public';
  includeShared?: boolean;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated response with metadata
 */
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

/**
 * Library API methods
 */
export const libraryApi = {
  // ===========================================================================
  // Library CRUD
  // ===========================================================================

  /**
   * List libraries accessible to the current user
   */
  async listLibraries(params: ListLibrariesParams = {}): Promise<PaginatedResponse<LibraryDTO>> {
    const response = await apiClient.get<ApiResponse<LibraryDTO[]>>('/libraries', { params });
    return {
      data: response.data.data,
      meta: response.data.meta!,
    };
  },

  /**
   * Create a new library
   */
  async createLibrary(input: CreateLibraryInput): Promise<LibraryDTO> {
    const response = await apiClient.post<ApiResponse<LibraryDTO>>('/libraries', input);
    return response.data.data;
  },

  /**
   * Get a library by ID
   */
  async getLibrary(id: string): Promise<LibraryDTO> {
    const response = await apiClient.get<ApiResponse<LibraryDTO>>(`/libraries/${id}`);
    return response.data.data;
  },

  /**
   * Update a library
   */
  async updateLibrary(id: string, input: UpdateLibraryInput): Promise<LibraryDTO> {
    const response = await apiClient.patch<ApiResponse<LibraryDTO>>(`/libraries/${id}`, input);
    return response.data.data;
  },

  /**
   * Delete a library (owner only)
   */
  async deleteLibrary(id: string): Promise<void> {
    await apiClient.delete(`/libraries/${id}`);
  },

  // ===========================================================================
  // Library Members
  // ===========================================================================

  /**
   * Get all members of a library
   */
  async getMembers(libraryId: string): Promise<LibraryMemberDTO[]> {
    const response = await apiClient.get<ApiResponse<LibraryMemberDTO[]>>(
      `/libraries/${libraryId}/members`
    );
    return response.data.data;
  },

  /**
   * Add a member to a library
   */
  async addMember(
    libraryId: string,
    userId: string,
    role: LibraryMemberRole = 'viewer'
  ): Promise<LibraryMemberDTO> {
    const response = await apiClient.post<ApiResponse<LibraryMemberDTO>>(
      `/libraries/${libraryId}/members`,
      { userId, role }
    );
    return response.data.data;
  },

  /**
   * Update a member's role
   */
  async updateMember(
    libraryId: string,
    userId: string,
    role: LibraryMemberRole
  ): Promise<LibraryMemberDTO> {
    const response = await apiClient.patch<ApiResponse<LibraryMemberDTO>>(
      `/libraries/${libraryId}/members/${userId}`,
      { role }
    );
    return response.data.data;
  },

  /**
   * Remove a member from a library
   */
  async removeMember(libraryId: string, userId: string): Promise<void> {
    await apiClient.delete(`/libraries/${libraryId}/members/${userId}`);
  },

  // ===========================================================================
  // Library Assets
  // ===========================================================================

  /**
   * Add multiple assets to a library
   */
  async addAssets(libraryId: string, assetIds: string[]): Promise<LibraryAssetDTO[]> {
    const input: AddAssetsToLibraryInput = { assetIds };
    const response = await apiClient.post<ApiResponse<LibraryAssetDTO[]>>(
      `/libraries/${libraryId}/assets/bulk`,
      input
    );
    return response.data.data;
  },
};
