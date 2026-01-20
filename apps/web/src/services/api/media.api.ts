/**
 * Media API Service
 *
 * API calls for media upload and management.
 */

import type {
  ApiResponse,
  MediaAssetDTO,
  PresignedUploadResponse,
  InitiateUploadInput,
  BulkUpdateMetadataInput,
  BulkUpdateMetadataResult,
  BulkDeleteInput,
  BulkDeleteResult,
} from '@memoriahub/shared';
import axios from 'axios';
import { apiClient } from './client';

/**
 * List media query parameters
 */
export interface ListMediaParams {
  page?: number;
  limit?: number;
  status?: string;
  mediaType?: 'image' | 'video';
  country?: string;
  state?: string;
  city?: string;
  cameraMake?: string;
  cameraModel?: string;
  startDate?: string;
  endDate?: string;
  sortBy?: 'capturedAt' | 'createdAt' | 'filename' | 'fileSize';
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
 * Upload progress callback
 */
export type UploadProgressCallback = (progress: number) => void;

/**
 * Media API methods
 */
export const mediaApi = {
  // ===========================================================================
  // Upload
  // ===========================================================================

  /**
   * Initiate an upload and get a presigned URL
   * @deprecated Use uploadFile which now uses proxy upload
   */
  async initiateUpload(input: InitiateUploadInput): Promise<PresignedUploadResponse> {
    const response = await apiClient.post<ApiResponse<PresignedUploadResponse>>(
      '/media/upload/initiate',
      input
    );
    return response.data.data;
  },

  /**
   * Upload a file to S3 using the presigned URL
   * @deprecated Use uploadFile which now uses proxy upload
   */
  async uploadToS3(
    uploadUrl: string,
    file: File,
    onProgress?: UploadProgressCallback
  ): Promise<void> {
    await axios.put(uploadUrl, file, {
      headers: {
        'Content-Type': file.type,
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(progress);
        }
      },
    });
  },

  /**
   * Complete an upload after file has been uploaded to S3
   * @deprecated Use uploadFile which now uses proxy upload
   */
  async completeUpload(assetId: string): Promise<MediaAssetDTO> {
    const response = await apiClient.post<ApiResponse<MediaAssetDTO>>(
      '/media/upload/complete',
      { assetId }
    );
    return response.data.data;
  },

  /**
   * Upload a file through the API proxy (avoids S3 CORS issues)
   * File is uploaded to the API server, which then forwards it to S3
   */
  async uploadFile(
    libraryId: string | undefined,
    file: File,
    onProgress?: UploadProgressCallback
  ): Promise<MediaAssetDTO> {
    const formData = new FormData();
    formData.append('file', file);
    if (libraryId) {
      formData.append('libraryId', libraryId);
    }

    const response = await apiClient.post<ApiResponse<MediaAssetDTO>>(
      '/media/upload/proxy',
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          if (onProgress && progressEvent.total) {
            const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            onProgress(progress);
          }
        },
      }
    );

    return response.data.data;
  },

  // ===========================================================================
  // Media Assets
  // ===========================================================================

  /**
   * List media assets
   * If libraryId is provided, lists media in that library.
   * If libraryId is undefined, lists all accessible media.
   */
  async listMedia(libraryId: string | undefined, params: ListMediaParams = {}): Promise<PaginatedResponse<MediaAssetDTO>> {
    const url = libraryId ? `/media/library/${libraryId}` : '/media';
    const response = await apiClient.get<ApiResponse<MediaAssetDTO[]>>(
      url,
      { params }
    );
    return {
      data: response.data.data,
      meta: response.data.meta!,
    };
  },

  /**
   * Get a single media asset
   */
  async getMedia(id: string): Promise<MediaAssetDTO> {
    const response = await apiClient.get<ApiResponse<MediaAssetDTO>>(`/media/${id}`);
    return response.data.data;
  },

  /**
   * Delete a media asset
   */
  async deleteMedia(id: string): Promise<void> {
    await apiClient.delete(`/media/${id}`);
  },

  // ===========================================================================
  // Bulk Operations
  // ===========================================================================

  /**
   * Bulk update metadata for multiple assets
   */
  async bulkUpdateMetadata(
    input: BulkUpdateMetadataInput
  ): Promise<BulkUpdateMetadataResult> {
    const response = await apiClient.patch<ApiResponse<BulkUpdateMetadataResult>>(
      '/media/bulk',
      input
    );
    return response.data.data;
  },

  /**
   * Bulk delete multiple assets
   */
  async bulkDelete(input: BulkDeleteInput): Promise<BulkDeleteResult> {
    const response = await apiClient.delete<ApiResponse<BulkDeleteResult>>(
      '/media/bulk',
      { data: input }
    );
    return response.data.data;
  },
};
