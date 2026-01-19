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
   * This bypasses the API client since it goes directly to S3
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
   */
  async completeUpload(assetId: string): Promise<MediaAssetDTO> {
    const response = await apiClient.post<ApiResponse<MediaAssetDTO>>(
      '/media/upload/complete',
      { assetId }
    );
    return response.data.data;
  },

  /**
   * Full upload flow: initiate -> S3 upload -> complete
   */
  async uploadFile(
    libraryId: string,
    file: File,
    onProgress?: UploadProgressCallback
  ): Promise<MediaAssetDTO> {
    // 1. Initiate upload
    const { uploadUrl, assetId } = await this.initiateUpload({
      libraryId,
      filename: file.name,
      mimeType: file.type,
      fileSize: file.size,
    });

    // 2. Upload to S3
    await this.uploadToS3(uploadUrl, file, onProgress);

    // 3. Complete upload
    return this.completeUpload(assetId);
  },

  // ===========================================================================
  // Media Assets
  // ===========================================================================

  /**
   * List media assets in a library
   */
  async listMedia(libraryId: string, params: ListMediaParams = {}): Promise<PaginatedResponse<MediaAssetDTO>> {
    const response = await apiClient.get<ApiResponse<MediaAssetDTO[]>>(
      `/media/library/${libraryId}`,
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
};
