import { useState, useCallback } from 'react';
import type { MediaAssetDTO } from '@memoriahub/shared';
import { mediaApi } from '../services/api';

/**
 * Status for a single file upload
 */
export interface UploadFileStatus {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'error';
  asset?: MediaAssetDTO;
  error?: string;
}

/**
 * State for the upload hook
 */
interface UseUploadState {
  files: UploadFileStatus[];
  isUploading: boolean;
  completedCount: number;
  errorCount: number;
}

/**
 * Supported file types for upload
 */
const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/bmp',
];

const SUPPORTED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
];

export const SUPPORTED_FILE_TYPES = [...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_VIDEO_TYPES];

/**
 * Maximum file size (100MB)
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Check if a file is a supported type
 */
export function isSupportedFileType(file: File): boolean {
  return SUPPORTED_FILE_TYPES.includes(file.type);
}

/**
 * Check if a file is within size limits
 */
export function isWithinSizeLimit(file: File): boolean {
  return file.size <= MAX_FILE_SIZE;
}

/**
 * Hook for managing file uploads
 */
export function useUpload(libraryId: string) {
  const [state, setState] = useState<UseUploadState>({
    files: [],
    isUploading: false,
    completedCount: 0,
    errorCount: 0,
  });

  /**
   * Add files to the upload queue
   */
  const addFiles = useCallback((newFiles: File[]): string[] => {
    const errors: string[] = [];
    const validFiles: UploadFileStatus[] = [];

    for (const file of newFiles) {
      if (!isSupportedFileType(file)) {
        errors.push(`${file.name}: Unsupported file type`);
        continue;
      }

      if (!isWithinSizeLimit(file)) {
        errors.push(`${file.name}: File exceeds maximum size of 100MB`);
        continue;
      }

      validFiles.push({
        file,
        progress: 0,
        status: 'pending',
      });
    }

    setState((prev) => ({
      ...prev,
      files: [...prev.files, ...validFiles],
    }));

    return errors;
  }, []);

  /**
   * Remove a file from the queue
   */
  const removeFile = useCallback((file: File) => {
    setState((prev) => ({
      ...prev,
      files: prev.files.filter((f) => f.file !== file),
    }));
  }, []);

  /**
   * Clear all files
   */
  const clearFiles = useCallback(() => {
    setState({
      files: [],
      isUploading: false,
      completedCount: 0,
      errorCount: 0,
    });
  }, []);

  /**
   * Clear completed uploads
   */
  const clearCompleted = useCallback(() => {
    setState((prev) => ({
      ...prev,
      files: prev.files.filter((f) => f.status !== 'completed'),
      completedCount: 0,
    }));
  }, []);

  /**
   * Upload a single file
   */
  const uploadFile = useCallback(async (fileStatus: UploadFileStatus): Promise<void> => {
    const { file } = fileStatus;

    // Update status to uploading
    setState((prev) => ({
      ...prev,
      files: prev.files.map((f) =>
        f.file === file ? { ...f, status: 'uploading' as const, progress: 0 } : f
      ),
    }));

    try {
      // Use the mediaApi uploadFile method which handles the full flow
      const asset = await mediaApi.uploadFile(libraryId, file, (progress) => {
        setState((prev) => ({
          ...prev,
          files: prev.files.map((f) =>
            f.file === file ? { ...f, progress } : f
          ),
        }));
      });

      // Update status to processing (EXIF extraction)
      setState((prev) => ({
        ...prev,
        files: prev.files.map((f) =>
          f.file === file ? { ...f, status: 'processing' as const, progress: 100 } : f
        ),
      }));

      // Mark as completed
      setState((prev) => ({
        ...prev,
        files: prev.files.map((f) =>
          f.file === file
            ? { ...f, status: 'completed' as const, asset }
            : f
        ),
        completedCount: prev.completedCount + 1,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        files: prev.files.map((f) =>
          f.file === file
            ? {
                ...f,
                status: 'error' as const,
                error: error instanceof Error ? error.message : 'Upload failed',
              }
            : f
        ),
        errorCount: prev.errorCount + 1,
      }));
    }
  }, [libraryId]);

  /**
   * Start uploading all pending files
   */
  const startUpload = useCallback(async () => {
    const pendingFiles = state.files.filter((f) => f.status === 'pending');

    if (pendingFiles.length === 0) return;

    setState((prev) => ({ ...prev, isUploading: true }));

    // Upload files sequentially to avoid overwhelming the server
    for (const fileStatus of pendingFiles) {
      await uploadFile(fileStatus);
    }

    setState((prev) => ({ ...prev, isUploading: false }));
  }, [state.files, uploadFile]);

  /**
   * Retry failed uploads
   */
  const retryFailed = useCallback(() => {
    // Reset failed uploads to pending
    setState((prev) => ({
      ...prev,
      files: prev.files.map((f) =>
        f.status === 'error' ? { ...f, status: 'pending' as const, error: undefined } : f
      ),
      errorCount: 0,
    }));

    // Start upload will pick up the reset files
    void startUpload();
  }, [startUpload]);

  return {
    ...state,
    addFiles,
    removeFile,
    clearFiles,
    clearCompleted,
    startUpload,
    retryFailed,
    pendingCount: state.files.filter((f) => f.status === 'pending').length,
    uploadingCount: state.files.filter((f) => f.status === 'uploading' || f.status === 'processing').length,
    totalProgress: state.files.length > 0
      ? Math.round(state.files.reduce((sum, f) => sum + f.progress, 0) / state.files.length)
      : 0,
  };
}
