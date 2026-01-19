/**
 * Upload Service Tests
 *
 * Tests for the upload service including proxy upload functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaAsset, FileSource } from '@memoriahub/shared';

// Mock dependencies before importing the service
const mockCanUserUploadToLibrary = vi.fn();
const mockCanUserAccessLibrary = vi.fn();

vi.mock('../../../../src/services/library/library.service.js', () => ({
  libraryService: {
    canUserUploadToLibrary: (...args: unknown[]) => mockCanUserUploadToLibrary(...args),
    canUserAccessLibrary: (...args: unknown[]) => mockCanUserAccessLibrary(...args),
  },
}));

const mockMediaAssetCreate = vi.fn();
const mockMediaAssetFindById = vi.fn();
const mockMediaAssetUpdate = vi.fn();
const mockMediaAssetUpdateStatus = vi.fn();
const mockMediaAssetDelete = vi.fn();
const mockMediaAssetFindByLibraryId = vi.fn();

vi.mock('../../../../src/infrastructure/database/repositories/media-asset.repository.js', () => ({
  mediaAssetRepository: {
    create: (...args: unknown[]) => mockMediaAssetCreate(...args),
    findById: (...args: unknown[]) => mockMediaAssetFindById(...args),
    update: (...args: unknown[]) => mockMediaAssetUpdate(...args),
    updateStatus: (...args: unknown[]) => mockMediaAssetUpdateStatus(...args),
    delete: (...args: unknown[]) => mockMediaAssetDelete(...args),
    findByLibraryId: (...args: unknown[]) => mockMediaAssetFindByLibraryId(...args),
  },
}));

const mockIngestionEventCreate = vi.fn();
const mockIngestionEventComplete = vi.fn();
const mockIngestionEventFail = vi.fn();

vi.mock('../../../../src/infrastructure/database/repositories/ingestion-event.repository.js', () => ({
  ingestionEventRepository: {
    create: (...args: unknown[]) => mockIngestionEventCreate(...args),
    complete: (...args: unknown[]) => mockIngestionEventComplete(...args),
    fail: (...args: unknown[]) => mockIngestionEventFail(...args),
  },
}));

const mockProcessingJobCreateMany = vi.fn();
const mockProcessingJobCancelByAssetId = vi.fn();

vi.mock('../../../../src/infrastructure/database/repositories/processing-job.repository.js', () => ({
  processingJobRepository: {
    createMany: (...args: unknown[]) => mockProcessingJobCreateMany(...args),
    cancelByAssetId: (...args: unknown[]) => mockProcessingJobCancelByAssetId(...args),
  },
}));

const mockStoragePutObject = vi.fn();
const mockStorageGetPresignedUploadUrl = vi.fn();
const mockStorageGetPresignedDownloadUrl = vi.fn();
const mockStorageObjectExists = vi.fn();
const mockStorageHeadObject = vi.fn();
const mockStorageGetObject = vi.fn();
const mockStorageDeleteObject = vi.fn();

vi.mock('../../../../src/infrastructure/storage/storage.factory.js', () => ({
  getDefaultStorageProvider: () => ({
    putObject: (...args: unknown[]) => mockStoragePutObject(...args),
    getPresignedUploadUrl: (...args: unknown[]) => mockStorageGetPresignedUploadUrl(...args),
    getPresignedDownloadUrl: (...args: unknown[]) => mockStorageGetPresignedDownloadUrl(...args),
    objectExists: (...args: unknown[]) => mockStorageObjectExists(...args),
    headObject: (...args: unknown[]) => mockStorageHeadObject(...args),
    getObject: (...args: unknown[]) => mockStorageGetObject(...args),
    deleteObject: (...args: unknown[]) => mockStorageDeleteObject(...args),
  }),
}));

const mockExtractMetadata = vi.fn();

vi.mock('../../../../src/services/media/exif.service.js', () => ({
  exifService: {
    extractMetadata: (...args: unknown[]) => mockExtractMetadata(...args),
  },
}));

const mockReverseGeocode = vi.fn();

vi.mock('../../../../src/services/media/geocoding.service.js', () => ({
  geocodingService: {
    reverseGeocode: (...args: unknown[]) => mockReverseGeocode(...args),
  },
}));

vi.mock('../../../../src/config/storage.config.js', () => ({
  storageConfig: {
    bucket: 'test-bucket',
    presignedUrlExpiration: 3600,
  },
}));

vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: vi.fn().mockReturnValue('test-trace-id'),
}));

// Mock uuid to return predictable values
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('asset-789'),
}));

// Import after mocks
import { UploadService } from '../../../../src/services/upload/upload.service.js';

describe('UploadService', () => {
  let uploadService: UploadService;

  const mockUserId = 'user-123';
  const mockLibraryId = 'library-456';

  const createMockAsset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
    id: 'asset-789',
    libraryId: mockLibraryId,
    storageKey: 'libraries/library-456/originals/asset-789.jpg',
    storageBucket: 'test-bucket',
    thumbnailKey: null,
    previewKey: null,
    originalFilename: 'test-image.jpg',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    fileSource: 'web' as FileSource,
    width: null,
    height: null,
    durationSeconds: null,
    cameraMake: null,
    cameraModel: null,
    latitude: null,
    longitude: null,
    country: null,
    state: null,
    city: null,
    locationName: null,
    capturedAtUtc: null,
    timezoneOffset: null,
    exifData: {},
    faces: [],
    tags: [],
    status: 'UPLOADED',
    errorMessage: null,
    traceId: 'test-trace-id',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    uploadService = new UploadService();

    // Default mock for presigned download URL (used in assetToDTO)
    mockStorageGetPresignedDownloadUrl.mockResolvedValue('https://example.com/presigned-url');
  });

  describe('proxyUpload', () => {
    const mockFile = {
      buffer: Buffer.from('test file content'),
      originalname: 'test-image.jpg',
      mimetype: 'image/jpeg',
      size: 1024,
    };

    it('uploads file successfully through proxy', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset();
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockResolvedValue(undefined);
      mockExtractMetadata.mockResolvedValue({
        width: 1920,
        height: 1080,
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15',
        latitude: null,
        longitude: null,
        capturedAtUtc: new Date('2024-01-01T12:00:00Z'),
        timezoneOffset: 0,
        exifData: { make: 'Apple', model: 'iPhone 15' },
      });

      const updatedAsset = createMockAsset({
        status: 'METADATA_EXTRACTED',
        width: 1920,
        height: 1080,
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15',
      });
      mockMediaAssetUpdate.mockResolvedValue(updatedAsset);
      mockIngestionEventComplete.mockResolvedValue(undefined);
      mockProcessingJobCreateMany.mockResolvedValue(undefined);

      const result = await uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile);

      expect(mockCanUserUploadToLibrary).toHaveBeenCalledWith(mockUserId, mockLibraryId);
      expect(mockMediaAssetCreate).toHaveBeenCalled();
      expect(mockIngestionEventCreate).toHaveBeenCalled();
      expect(mockStoragePutObject).toHaveBeenCalledWith(
        'test-bucket',
        expect.stringContaining('libraries/library-456/originals/'),
        mockFile.buffer,
        expect.objectContaining({
          contentType: 'image/jpeg',
        })
      );
      expect(mockExtractMetadata).toHaveBeenCalledWith(mockFile.buffer, 'image/jpeg');
      expect(mockMediaAssetUpdate).toHaveBeenCalled();
      expect(mockIngestionEventComplete).toHaveBeenCalled();
      expect(mockProcessingJobCreateMany).toHaveBeenCalled();

      expect(result).toBeDefined();
      expect(result.id).toBe('asset-789');
      expect(result.originalFilename).toBe('test-image.jpg');
    });

    it('throws ForbiddenError when user lacks upload permission', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(false);

      await expect(uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile))
        .rejects.toThrow('You do not have permission to upload to this library');

      expect(mockMediaAssetCreate).not.toHaveBeenCalled();
      expect(mockStoragePutObject).not.toHaveBeenCalled();
    });

    it('throws ValidationError for unsupported file type', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const unsupportedFile = {
        buffer: Buffer.from('test'),
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
        size: 1024,
      };

      await expect(uploadService.proxyUpload(mockUserId, mockLibraryId, unsupportedFile))
        .rejects.toThrow('Unsupported file type');

      expect(mockStoragePutObject).not.toHaveBeenCalled();
    });

    it('marks asset as failed when S3 upload fails', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset();
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockRejectedValue(new Error('S3 upload failed'));

      await expect(uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile))
        .rejects.toThrow('S3 upload failed');

      expect(mockIngestionEventFail).toHaveBeenCalledWith('asset-789', 'Failed to upload to storage');
      expect(mockMediaAssetUpdateStatus).toHaveBeenCalledWith('asset-789', 'ERROR', 'Failed to upload to storage');
    });

    it('continues upload even when metadata extraction fails', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset();
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockResolvedValue(undefined);
      mockExtractMetadata.mockRejectedValue(new Error('EXIF extraction failed'));

      const updatedAsset = createMockAsset({ status: 'METADATA_EXTRACTED' });
      mockMediaAssetUpdate.mockResolvedValue(updatedAsset);
      mockIngestionEventComplete.mockResolvedValue(undefined);
      mockProcessingJobCreateMany.mockResolvedValue(undefined);

      const result = await uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile);

      expect(result).toBeDefined();
      expect(result.id).toBe('asset-789');
      expect(mockIngestionEventComplete).toHaveBeenCalled();
    });

    it('performs geocoding when GPS coordinates are present', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset();
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockResolvedValue(undefined);
      mockExtractMetadata.mockResolvedValue({
        width: 1920,
        height: 1080,
        latitude: 37.7749,
        longitude: -122.4194,
        capturedAtUtc: new Date('2024-01-01T12:00:00Z'),
        timezoneOffset: -480,
        exifData: {},
      });
      mockReverseGeocode.mockResolvedValue({
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
        locationName: 'San Francisco, CA, USA',
      });

      const updatedAsset = createMockAsset({
        status: 'METADATA_EXTRACTED',
        latitude: 37.7749,
        longitude: -122.4194,
        country: 'United States',
        state: 'California',
        city: 'San Francisco',
      });
      mockMediaAssetUpdate.mockResolvedValue(updatedAsset);
      mockIngestionEventComplete.mockResolvedValue(undefined);
      mockProcessingJobCreateMany.mockResolvedValue(undefined);

      await uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile);

      expect(mockReverseGeocode).toHaveBeenCalledWith(37.7749, -122.4194);
      expect(mockMediaAssetUpdate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          country: 'United States',
          state: 'California',
          city: 'San Francisco',
        })
      );
    });

    it('handles video files correctly', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const videoFile = {
        buffer: Buffer.from('video content'),
        originalname: 'test-video.mp4',
        mimetype: 'video/mp4',
        size: 10240,
      };

      const createdAsset = createMockAsset({
        originalFilename: 'test-video.mp4',
        mediaType: 'video',
        mimeType: 'video/mp4',
      });
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockResolvedValue(undefined);
      mockExtractMetadata.mockResolvedValue({
        width: 1920,
        height: 1080,
        durationSeconds: 30.5,
        exifData: {},
      });

      const updatedAsset = createMockAsset({
        status: 'METADATA_EXTRACTED',
        mediaType: 'video',
        width: 1920,
        height: 1080,
        durationSeconds: 30.5,
      });
      mockMediaAssetUpdate.mockResolvedValue(updatedAsset);
      mockIngestionEventComplete.mockResolvedValue(undefined);
      mockProcessingJobCreateMany.mockResolvedValue(undefined);

      const result = await uploadService.proxyUpload(mockUserId, mockLibraryId, videoFile);

      expect(mockStoragePutObject).toHaveBeenCalledWith(
        'test-bucket',
        expect.stringContaining('.mp4'),
        videoFile.buffer,
        expect.objectContaining({
          contentType: 'video/mp4',
        })
      );
      expect(result).toBeDefined();
    });

    it('queues processing jobs after successful upload', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset();
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockResolvedValue(undefined);
      mockExtractMetadata.mockResolvedValue({ exifData: {} });

      const updatedAsset = createMockAsset({ status: 'METADATA_EXTRACTED' });
      mockMediaAssetUpdate.mockResolvedValue(updatedAsset);
      mockIngestionEventComplete.mockResolvedValue(undefined);
      mockProcessingJobCreateMany.mockResolvedValue(undefined);

      await uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile);

      expect(mockProcessingJobCreateMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ jobType: 'generate_thumbnail' }),
          expect.objectContaining({ jobType: 'generate_preview' }),
        ])
      );
    });

    it('accepts custom source parameter', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset({ fileSource: 'api' as FileSource });
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStoragePutObject.mockResolvedValue(undefined);
      mockExtractMetadata.mockResolvedValue({ exifData: {} });

      const updatedAsset = createMockAsset({ status: 'METADATA_EXTRACTED' });
      mockMediaAssetUpdate.mockResolvedValue(updatedAsset);
      mockIngestionEventComplete.mockResolvedValue(undefined);
      mockProcessingJobCreateMany.mockResolvedValue(undefined);

      await uploadService.proxyUpload(mockUserId, mockLibraryId, mockFile, 'api');

      expect(mockMediaAssetCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          fileSource: 'api',
        })
      );
    });
  });

  describe('initiateUpload', () => {
    const mockInput = {
      libraryId: mockLibraryId,
      filename: 'test-image.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
    };

    it('creates asset and returns presigned URL', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(true);

      const createdAsset = createMockAsset();
      mockMediaAssetCreate.mockResolvedValue(createdAsset);
      mockIngestionEventCreate.mockResolvedValue({});
      mockStorageGetPresignedUploadUrl.mockResolvedValue('https://s3.example.com/presigned-upload-url');

      const result = await uploadService.initiateUpload(mockUserId, mockInput);

      expect(result.assetId).toBe('asset-789');
      expect(result.uploadUrl).toBe('https://s3.example.com/presigned-upload-url');
      expect(result.storageKey).toContain('libraries/library-456/originals/');
      expect(result.expiresAt).toBeDefined();
    });

    it('throws ForbiddenError when user lacks permission', async () => {
      mockCanUserUploadToLibrary.mockResolvedValue(false);

      await expect(uploadService.initiateUpload(mockUserId, mockInput))
        .rejects.toThrow('You do not have permission to upload to this library');
    });
  });

  describe('getAsset', () => {
    it('returns asset DTO with presigned URLs', async () => {
      const asset = createMockAsset({ thumbnailKey: 'thumb.jpg', previewKey: 'preview.jpg' });
      mockMediaAssetFindById.mockResolvedValue(asset);
      mockCanUserAccessLibrary.mockResolvedValue(true);

      const result = await uploadService.getAsset(mockUserId, 'asset-789');

      expect(result.id).toBe('asset-789');
      expect(result.originalUrl).toBe('https://example.com/presigned-url');
    });

    it('throws NotFoundError when asset does not exist', async () => {
      mockMediaAssetFindById.mockResolvedValue(null);

      await expect(uploadService.getAsset(mockUserId, 'nonexistent'))
        .rejects.toThrow('Asset not found');
    });

    it('throws NotFoundError when user lacks access', async () => {
      const asset = createMockAsset();
      mockMediaAssetFindById.mockResolvedValue(asset);
      mockCanUserAccessLibrary.mockResolvedValue(false);

      await expect(uploadService.getAsset(mockUserId, 'asset-789'))
        .rejects.toThrow('Asset not found');
    });
  });

  describe('deleteAsset', () => {
    it('deletes asset from storage and database', async () => {
      const asset = createMockAsset({ thumbnailKey: 'thumb.jpg', previewKey: 'preview.jpg' });
      mockMediaAssetFindById.mockResolvedValue(asset);
      mockCanUserUploadToLibrary.mockResolvedValue(true);
      mockStorageDeleteObject.mockResolvedValue(undefined);
      mockProcessingJobCancelByAssetId.mockResolvedValue(undefined);
      mockMediaAssetDelete.mockResolvedValue(undefined);

      await uploadService.deleteAsset(mockUserId, 'asset-789');

      expect(mockStorageDeleteObject).toHaveBeenCalledTimes(3); // original, thumbnail, preview
      expect(mockProcessingJobCancelByAssetId).toHaveBeenCalledWith('asset-789');
      expect(mockMediaAssetDelete).toHaveBeenCalledWith('asset-789');
    });

    it('throws NotFoundError when asset does not exist', async () => {
      mockMediaAssetFindById.mockResolvedValue(null);

      await expect(uploadService.deleteAsset(mockUserId, 'nonexistent'))
        .rejects.toThrow('Asset not found');
    });

    it('throws ForbiddenError when user lacks permission', async () => {
      const asset = createMockAsset();
      mockMediaAssetFindById.mockResolvedValue(asset);
      mockCanUserUploadToLibrary.mockResolvedValue(false);

      await expect(uploadService.deleteAsset(mockUserId, 'asset-789'))
        .rejects.toThrow('You do not have permission to delete this asset');
    });
  });
});
