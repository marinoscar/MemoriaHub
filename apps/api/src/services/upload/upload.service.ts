import { v4 as uuidv4 } from 'uuid';
import type {
  MediaAsset,
  MediaAssetDTO,
  FileSource,
  PresignedUploadResponse,
  InitiateUploadInput,
  ExtractedMetadata,
  GeocodingResult,
} from '@memoriahub/shared';
import { getMediaTypeFromMimeType } from '@memoriahub/shared';
import { getDefaultStorageProvider } from '../../infrastructure/storage/storage.factory.js';
import { storageConfig } from '../../config/storage.config.js';
import {
  mediaAssetRepository,
  type CreateMediaAssetInput,
} from '../../infrastructure/database/repositories/media-asset.repository.js';
import { ingestionEventRepository } from '../../infrastructure/database/repositories/ingestion-event.repository.js';
import { processingJobRepository } from '../../infrastructure/database/repositories/processing-job.repository.js';
import { libraryAssetRepository } from '../../infrastructure/database/repositories/library-asset.repository.js';
import { libraryService } from '../library/library.service.js';
import { exifService } from '../media/exif.service.js';
import { geocodingService } from '../media/geocoding.service.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { getTraceId } from '../../infrastructure/logging/request-context.js';

/**
 * Upload service
 * Centralized upload logic for web, WebDAV, and API uploads
 */
export class UploadService {
  private storage = getDefaultStorageProvider();

  /**
   * Initiate an upload - creates asset record and returns presigned URL
   * Media is owned by the user. Optionally adds to a library.
   * @param userId User initiating the upload (becomes owner)
   * @param input Upload parameters (libraryId is optional)
   * @param source Upload source (web, webdav, api)
   * @returns Presigned URL and asset info
   */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
    source: FileSource = 'web'
  ): Promise<PresignedUploadResponse> {
    const traceId = getTraceId();
    const startTime = Date.now();

    // If libraryId provided, verify user has upload permission to library
    if (input.libraryId) {
      const canUpload = await libraryService.canUserUploadToLibrary(userId, input.libraryId);
      if (!canUpload) {
        throw new ForbiddenError('You do not have permission to upload to this library');
      }
    }

    // Determine media type
    const mediaType = getMediaTypeFromMimeType(input.mimeType);
    if (!mediaType) {
      throw new ValidationError('Unsupported file type');
    }

    // Generate asset ID and storage key (user-based path)
    const assetId = uuidv4();
    const extension = this.getFileExtension(input.filename);
    const storageKey = this.generateStorageKey(userId, assetId, extension);

    // Create asset record (owned by user)
    const assetInput: CreateMediaAssetInput = {
      id: assetId,
      ownerId: userId,
      storageKey,
      storageBucket: storageConfig.bucket,
      originalFilename: input.filename,
      mediaType,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      fileSource: source,
      traceId,
    };

    const asset = await mediaAssetRepository.create(assetInput);

    // If libraryId provided, add asset to library
    if (input.libraryId) {
      await libraryAssetRepository.add({
        libraryId: input.libraryId,
        assetId: asset.id,
        addedByUserId: userId,
      });
    }

    // Create ingestion event
    await ingestionEventRepository.create({
      assetId: asset.id,
      source,
      traceId: traceId || undefined,
      clientInfo: {
        userId,
        filename: input.filename,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        libraryId: input.libraryId,
      },
    });

    // Generate presigned upload URL
    const expiresIn = storageConfig.presignedUrlExpiration;
    const uploadUrl = await this.storage.getPresignedUploadUrl(
      storageConfig.bucket,
      storageKey,
      {
        contentType: input.mimeType,
        expiresIn,
      }
    );

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    logger.info({
      eventType: 'upload.initiated',
      assetId: asset.id,
      ownerId: userId,
      libraryId: input.libraryId || null,
      filename: input.filename,
      mediaType,
      fileSize: input.fileSize,
      source,
      userId,
      durationMs: Date.now() - startTime,
      traceId,
    }, 'Upload initiated');

    return {
      assetId: asset.id,
      uploadUrl,
      storageKey,
      expiresAt,
    };
  }

  /**
   * Proxy upload - receives file directly and uploads to S3
   * This avoids CORS issues with presigned URLs by proxying through the API
   * Media is owned by the user. Optionally adds to a library.
   * @param userId User initiating the upload (becomes owner)
   * @param libraryId Target library (optional)
   * @param file File buffer and metadata
   * @param source Upload source (web, webdav, api)
   * @returns Completed asset
   */
  async proxyUpload(
    userId: string,
    libraryId: string | null,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    source: FileSource = 'web'
  ): Promise<MediaAssetDTO> {
    const traceId = getTraceId();
    const startTime = Date.now();

    // If libraryId provided, verify user has upload permission to library
    if (libraryId) {
      const canUpload = await libraryService.canUserUploadToLibrary(userId, libraryId);
      if (!canUpload) {
        throw new ForbiddenError('You do not have permission to upload to this library');
      }
    }

    // Determine media type
    const mediaType = getMediaTypeFromMimeType(file.mimetype);
    if (!mediaType) {
      throw new ValidationError('Unsupported file type');
    }

    // Generate asset ID and storage key (user-based path)
    const assetId = uuidv4();
    const extension = this.getFileExtension(file.originalname);
    const storageKey = this.generateStorageKey(userId, assetId, extension);

    // Create asset record (owned by user)
    const assetInput: CreateMediaAssetInput = {
      id: assetId,
      ownerId: userId,
      storageKey,
      storageBucket: storageConfig.bucket,
      originalFilename: file.originalname,
      mediaType,
      mimeType: file.mimetype,
      fileSize: file.size,
      fileSource: source,
      traceId,
    };

    const asset = await mediaAssetRepository.create(assetInput);

    // If libraryId provided, add asset to library
    if (libraryId) {
      await libraryAssetRepository.add({
        libraryId,
        assetId: asset.id,
        addedByUserId: userId,
      });
    }

    // Create ingestion event
    await ingestionEventRepository.create({
      assetId: asset.id,
      source,
      traceId: traceId || undefined,
      clientInfo: {
        userId,
        filename: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        libraryId,
      },
    });

    logger.info({
      eventType: 'upload.proxy.started',
      assetId: asset.id,
      ownerId: userId,
      libraryId: libraryId || null,
      filename: file.originalname,
      mediaType,
      fileSize: file.size,
      source,
      userId,
      traceId,
    }, 'Proxy upload started');

    // Upload to S3
    try {
      await this.storage.putObject(
        storageConfig.bucket,
        storageKey,
        file.buffer,
        {
          contentType: file.mimetype,
          metadata: {
            originalFilename: file.originalname,
            uploadedBy: userId,
          },
        }
      );
    } catch (error) {
      // Mark as failed
      await ingestionEventRepository.fail(assetId, 'Failed to upload to storage');
      await mediaAssetRepository.updateStatus(assetId, 'ERROR', 'Failed to upload to storage');
      throw error;
    }

    // Extract metadata and complete upload
    let extractedMetadata: ExtractedMetadata | null = null;
    let geocodingResult: GeocodingResult | null = null;

    try {
      // Extract EXIF from the buffer we already have
      extractedMetadata = await exifService.extractMetadata(file.buffer, file.mimetype);

      // Reverse geocode if we have GPS coordinates
      if (extractedMetadata.latitude && extractedMetadata.longitude) {
        geocodingResult = await geocodingService.reverseGeocode(
          extractedMetadata.latitude,
          extractedMetadata.longitude
        );
      }
    } catch (error) {
      logger.warn({
        eventType: 'upload.proxy.metadata_extraction_failed',
        assetId,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to extract metadata from file');
      // Continue anyway - metadata extraction is best-effort
    }

    // Update asset with extracted metadata
    const updateData: Parameters<typeof mediaAssetRepository.update>[1] = {
      status: 'METADATA_EXTRACTED',
    };

    if (extractedMetadata) {
      if (extractedMetadata.width) updateData.width = extractedMetadata.width;
      if (extractedMetadata.height) updateData.height = extractedMetadata.height;
      if (extractedMetadata.durationSeconds) updateData.durationSeconds = extractedMetadata.durationSeconds;
      if (extractedMetadata.cameraMake) updateData.cameraMake = extractedMetadata.cameraMake;
      if (extractedMetadata.cameraModel) updateData.cameraModel = extractedMetadata.cameraModel;
      if (extractedMetadata.latitude) updateData.latitude = extractedMetadata.latitude;
      if (extractedMetadata.longitude) updateData.longitude = extractedMetadata.longitude;
      if (extractedMetadata.capturedAtUtc) updateData.capturedAtUtc = extractedMetadata.capturedAtUtc;
      if (extractedMetadata.timezoneOffset !== null) updateData.timezoneOffset = extractedMetadata.timezoneOffset;
      if (extractedMetadata.exifData) updateData.exifData = extractedMetadata.exifData;
    }

    if (geocodingResult) {
      if (geocodingResult.country) updateData.country = geocodingResult.country;
      if (geocodingResult.state) updateData.state = geocodingResult.state;
      if (geocodingResult.city) updateData.city = geocodingResult.city;
      if (geocodingResult.locationName) updateData.locationName = geocodingResult.locationName;
    }

    const updatedAsset = await mediaAssetRepository.update(assetId, updateData);

    // Mark ingestion as completed
    await ingestionEventRepository.complete(assetId);

    // Queue processing jobs
    await this.queueProcessingJobs(assetId, traceId ?? null);

    logger.info({
      eventType: 'upload.proxy.completed',
      assetId,
      ownerId: userId,
      libraryId: libraryId || null,
      filename: file.originalname,
      hasExif: !!extractedMetadata,
      hasGps: !!extractedMetadata?.latitude,
      hasGeocoding: !!geocodingResult?.country,
      userId,
      durationMs: Date.now() - startTime,
      traceId,
    }, 'Proxy upload completed');

    return this.assetToDTO(updatedAsset!);
  }

  /**
   * Complete an upload - verify file exists, extract metadata, queue processing
   * @param userId User completing the upload
   * @param assetId Asset ID from initiate step
   * @returns Updated asset
   */
  async completeUpload(userId: string, assetId: string): Promise<MediaAssetDTO> {
    const traceId = getTraceId();
    const startTime = Date.now();

    // Get asset
    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }

    // Verify user owns the asset
    if (asset.ownerId !== userId) {
      throw new ForbiddenError('You do not have permission to this asset');
    }

    // Verify asset is in UPLOADED status
    if (asset.status !== 'UPLOADED') {
      throw new ValidationError(`Asset is already ${asset.status.toLowerCase()}`);
    }

    // Verify file exists in S3
    const exists = await this.storage.objectExists(asset.storageBucket, asset.storageKey);
    if (!exists) {
      // Mark ingestion as failed
      await ingestionEventRepository.fail(assetId, 'File not found in storage');
      await mediaAssetRepository.updateStatus(assetId, 'ERROR', 'File not found in storage');
      throw new ValidationError('File not found in storage - upload may have failed');
    }

    // Get actual file size from S3
    const objectMeta = await this.storage.headObject(asset.storageBucket, asset.storageKey);

    // Update file size if different
    if (objectMeta.size !== asset.fileSize) {
      await mediaAssetRepository.update(assetId, { fileSize: objectMeta.size });
    }

    // Extract EXIF metadata
    let extractedMetadata: ExtractedMetadata | null = null;
    let geocodingResult: GeocodingResult | null = null;

    try {
      // Download file for EXIF extraction
      const { body } = await this.storage.getObject(asset.storageBucket, asset.storageKey);
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) {
        chunks.push(chunk as Uint8Array);
      }
      const buffer = Buffer.concat(chunks);

      // Extract EXIF
      extractedMetadata = await exifService.extractMetadata(buffer, asset.mimeType);

      // Reverse geocode if we have GPS coordinates
      if (extractedMetadata.latitude && extractedMetadata.longitude) {
        geocodingResult = await geocodingService.reverseGeocode(
          extractedMetadata.latitude,
          extractedMetadata.longitude
        );
      }
    } catch (error) {
      logger.warn({
        eventType: 'upload.metadata_extraction_failed',
        assetId,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to extract metadata from file');
      // Continue anyway - metadata extraction is best-effort
    }

    // Update asset with extracted metadata
    const updateData: Parameters<typeof mediaAssetRepository.update>[1] = {
      status: 'METADATA_EXTRACTED',
    };

    if (extractedMetadata) {
      if (extractedMetadata.width) updateData.width = extractedMetadata.width;
      if (extractedMetadata.height) updateData.height = extractedMetadata.height;
      if (extractedMetadata.durationSeconds) updateData.durationSeconds = extractedMetadata.durationSeconds;
      if (extractedMetadata.cameraMake) updateData.cameraMake = extractedMetadata.cameraMake;
      if (extractedMetadata.cameraModel) updateData.cameraModel = extractedMetadata.cameraModel;
      if (extractedMetadata.latitude) updateData.latitude = extractedMetadata.latitude;
      if (extractedMetadata.longitude) updateData.longitude = extractedMetadata.longitude;
      if (extractedMetadata.capturedAtUtc) updateData.capturedAtUtc = extractedMetadata.capturedAtUtc;
      if (extractedMetadata.timezoneOffset !== null) updateData.timezoneOffset = extractedMetadata.timezoneOffset;
      if (extractedMetadata.exifData) updateData.exifData = extractedMetadata.exifData;
    }

    if (geocodingResult) {
      if (geocodingResult.country) updateData.country = geocodingResult.country;
      if (geocodingResult.state) updateData.state = geocodingResult.state;
      if (geocodingResult.city) updateData.city = geocodingResult.city;
      if (geocodingResult.locationName) updateData.locationName = geocodingResult.locationName;
    }

    const updatedAsset = await mediaAssetRepository.update(assetId, updateData);

    // Mark ingestion as completed
    await ingestionEventRepository.complete(assetId);

    // Queue processing jobs
    await this.queueProcessingJobs(assetId, traceId ?? null);

    logger.info({
      eventType: 'upload.completed',
      assetId,
      ownerId: asset.ownerId,
      filename: asset.originalFilename,
      hasExif: !!extractedMetadata,
      hasGps: !!extractedMetadata?.latitude,
      hasGeocoding: !!geocodingResult?.country,
      userId,
      durationMs: Date.now() - startTime,
      traceId,
    }, 'Upload completed');

    return this.assetToDTO(updatedAsset!);
  }

  /**
   * Get a media asset
   * User must own, have direct share, or have library access
   */
  async getAsset(userId: string, assetId: string): Promise<MediaAssetDTO> {
    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }

    // Verify access (owns, shared, or library member)
    const hasAccess = await mediaAssetRepository.canAccess(assetId, userId);
    if (!hasAccess) {
      throw new NotFoundError('Asset not found');
    }

    return this.assetToDTO(asset);
  }

  /**
   * List assets in a library (via junction table)
   */
  async listAssetsInLibrary(
    userId: string,
    libraryId: string,
    options: {
      page?: number;
      limit?: number;
      status?: string;
      mediaType?: string;
      country?: string;
      state?: string;
      city?: string;
      cameraMake?: string;
      cameraModel?: string;
      startDate?: string;
      endDate?: string;
      sortBy?: 'capturedAt' | 'createdAt' | 'filename' | 'fileSize';
      sortOrder?: 'asc' | 'desc';
    } = {}
  ): Promise<{ assets: MediaAssetDTO[]; total: number; page: number; limit: number }> {
    // Verify access to library
    const hasAccess = await libraryService.canUserAccessLibrary(userId, libraryId);
    if (!hasAccess) {
      throw new NotFoundError('Library not found');
    }

    const result = await mediaAssetRepository.findByLibraryId(libraryId, {
      page: options.page,
      limit: options.limit,
      status: options.status as 'UPLOADED' | 'METADATA_EXTRACTED' | 'DERIVATIVES_READY' | 'ENRICHED' | 'INDEXED' | 'READY' | 'ERROR' | undefined,
      mediaType: options.mediaType as 'image' | 'video' | undefined,
      country: options.country,
      state: options.state,
      city: options.city,
      cameraMake: options.cameraMake,
      cameraModel: options.cameraModel,
      startDate: options.startDate ? new Date(options.startDate) : undefined,
      endDate: options.endDate ? new Date(options.endDate) : undefined,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
    });

    return {
      assets: await Promise.all(result.assets.map((a) => this.assetToDTO(a))),
      total: result.total,
      page: options.page || 1,
      limit: options.limit || 50,
    };
  }

  /**
   * List all accessible media for a user (owned + shared + via libraries)
   */
  async listAllAccessibleAssets(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      status?: string;
      mediaType?: string;
      country?: string;
      state?: string;
      city?: string;
      cameraMake?: string;
      cameraModel?: string;
      startDate?: string;
      endDate?: string;
      sortBy?: 'capturedAt' | 'createdAt' | 'filename' | 'fileSize';
      sortOrder?: 'asc' | 'desc';
    } = {}
  ): Promise<{ assets: MediaAssetDTO[]; total: number; page: number; limit: number }> {
    const result = await mediaAssetRepository.findAllAccessible({
      userId,
      page: options.page,
      limit: options.limit,
      status: options.status as Parameters<typeof mediaAssetRepository.findAllAccessible>[0]['status'],
      mediaType: options.mediaType as Parameters<typeof mediaAssetRepository.findAllAccessible>[0]['mediaType'],
      country: options.country,
      state: options.state,
      city: options.city,
      cameraMake: options.cameraMake,
      cameraModel: options.cameraModel,
      startDate: options.startDate ? new Date(options.startDate) : undefined,
      endDate: options.endDate ? new Date(options.endDate) : undefined,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
    });

    return {
      assets: await Promise.all(result.assets.map((a) => this.assetToDTO(a))),
      total: result.total,
      page: options.page || 1,
      limit: options.limit || 50,
    };
  }

  /**
   * Delete a media asset
   * Only the owner can delete their media
   */
  async deleteAsset(userId: string, assetId: string): Promise<void> {
    const traceId = getTraceId();

    const asset = await mediaAssetRepository.findById(assetId);
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }

    // Only the owner can delete their media
    if (asset.ownerId !== userId) {
      throw new ForbiddenError('Only the owner can delete this asset');
    }

    // Delete from S3
    try {
      await this.storage.deleteObject(asset.storageBucket, asset.storageKey);
      if (asset.thumbnailKey) {
        await this.storage.deleteObject(asset.storageBucket, asset.thumbnailKey);
      }
      if (asset.previewKey) {
        await this.storage.deleteObject(asset.storageBucket, asset.previewKey);
      }
    } catch (error) {
      logger.warn({
        eventType: 'upload.storage_delete_failed',
        assetId,
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId,
      }, 'Failed to delete files from storage');
    }

    // Cancel any pending processing jobs
    await processingJobRepository.cancelByAssetId(assetId);

    // Delete from database (cascades to ingestion events, processing jobs, library_assets, media_shares)
    await mediaAssetRepository.delete(assetId);

    logger.info({
      eventType: 'upload.asset_deleted',
      assetId,
      ownerId: userId,
      traceId,
    }, 'Asset deleted');
  }

  // ==================== Helpers ====================

  /**
   * Generate storage key for an asset
   * Uses user-based path since media is owned by users, not libraries
   */
  private generateStorageKey(ownerId: string, assetId: string, extension: string): string {
    // Format: users/{ownerId}/originals/{assetId}.{ext}
    return `users/${ownerId}/originals/${assetId}${extension ? `.${extension}` : ''}`;
  }

  /**
   * Get file extension from filename
   */
  private getFileExtension(filename: string): string {
    const parts = filename.split('.');
    if (parts.length > 1) {
      return parts[parts.length - 1].toLowerCase();
    }
    return '';
  }

  /**
   * Queue processing jobs for a new asset
   */
  private async queueProcessingJobs(assetId: string, traceId: string | null): Promise<void> {
    // Queue jobs in order of priority
    await processingJobRepository.createMany([
      {
        assetId,
        jobType: 'generate_thumbnail',
        priority: 10,
        traceId,
      },
      {
        assetId,
        jobType: 'generate_preview',
        priority: 5,
        traceId,
      },
    ]);

    logger.debug({
      eventType: 'upload.jobs_queued',
      assetId,
      jobCount: 2,
      traceId,
    }, 'Processing jobs queued');
  }

  /**
   * Convert MediaAsset to DTO with presigned URLs
   */
  private async assetToDTO(asset: MediaAsset): Promise<MediaAssetDTO> {
    // Generate presigned download URLs
    const [thumbnailUrl, previewUrl, originalUrl] = await Promise.all([
      asset.thumbnailKey
        ? this.storage.getPresignedDownloadUrl(asset.storageBucket, asset.thumbnailKey)
        : null,
      asset.previewKey
        ? this.storage.getPresignedDownloadUrl(asset.storageBucket, asset.previewKey)
        : null,
      this.storage.getPresignedDownloadUrl(asset.storageBucket, asset.storageKey),
    ]);

    return {
      id: asset.id,
      ownerId: asset.ownerId,
      originalFilename: asset.originalFilename,
      mediaType: asset.mediaType,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
      fileSource: asset.fileSource,
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds,
      cameraMake: asset.cameraMake,
      cameraModel: asset.cameraModel,
      latitude: asset.latitude,
      longitude: asset.longitude,
      country: asset.country,
      state: asset.state,
      city: asset.city,
      locationName: asset.locationName,
      capturedAtUtc: asset.capturedAtUtc?.toISOString() || null,
      timezoneOffset: asset.timezoneOffset,
      thumbnailUrl,
      previewUrl,
      originalUrl,
      exifData: asset.exifData,
      status: asset.status,
      createdAt: asset.createdAt.toISOString(),
      updatedAt: asset.updatedAt.toISOString(),
    };
  }
}

// Export singleton instance
export const uploadService = new UploadService();
