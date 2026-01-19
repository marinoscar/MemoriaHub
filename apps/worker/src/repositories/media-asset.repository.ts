import type { MediaAsset, MediaAssetStatus, MediaType, FileSource, ExifData, FaceData, TagData } from '@memoriahub/shared';
import { query } from '../infrastructure/database/index.js';
import { logger } from '../infrastructure/logging/index.js';

/**
 * Database row type for media assets
 */
interface MediaAssetRow {
  id: string;
  library_id: string;
  storage_key: string;
  storage_bucket: string;
  thumbnail_key: string | null;
  preview_key: string | null;
  original_filename: string;
  media_type: MediaType;
  mime_type: string;
  file_size: string; // bigint comes as string
  file_source: FileSource;
  width: number | null;
  height: number | null;
  duration_seconds: string | null; // numeric comes as string
  camera_make: string | null;
  camera_model: string | null;
  latitude: string | null; // numeric comes as string
  longitude: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  location_name: string | null;
  captured_at_utc: Date | null;
  timezone_offset: number | null;
  exif_data: ExifData;
  faces: unknown[];
  tags: unknown[];
  status: MediaAssetStatus;
  error_message: string | null;
  trace_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Convert database row to MediaAsset entity
 */
function rowToMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    libraryId: row.library_id,
    storageKey: row.storage_key,
    storageBucket: row.storage_bucket,
    thumbnailKey: row.thumbnail_key,
    previewKey: row.preview_key,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    fileSize: parseInt(row.file_size, 10),
    fileSource: row.file_source,
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds ? parseFloat(row.duration_seconds) : null,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    latitude: row.latitude ? parseFloat(row.latitude) : null,
    longitude: row.longitude ? parseFloat(row.longitude) : null,
    country: row.country,
    state: row.state,
    city: row.city,
    locationName: row.location_name,
    capturedAtUtc: row.captured_at_utc,
    timezoneOffset: row.timezone_offset,
    exifData: row.exif_data || {},
    faces: (Array.isArray(row.faces) ? row.faces : []) as FaceData[],
    tags: (Array.isArray(row.tags) ? row.tags : []) as TagData[],
    status: row.status,
    errorMessage: row.error_message,
    traceId: row.trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Update input for media assets (partial)
 */
export interface UpdateMediaAssetInput {
  thumbnailKey?: string | null;
  previewKey?: string | null;
  status?: MediaAssetStatus;
  errorMessage?: string | null;
}

/**
 * Worker-focused media asset repository
 * Contains only methods needed for job processing
 */
export class MediaAssetRepository {
  /**
   * Find media asset by ID
   */
  async findById(id: string): Promise<MediaAsset | null> {
    const result = await query<MediaAssetRow>(
      'SELECT * FROM media_assets WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToMediaAsset(result.rows[0]);
  }

  /**
   * Update thumbnail key
   */
  async updateThumbnailKey(id: string, thumbnailKey: string): Promise<MediaAsset | null> {
    const result = await query<MediaAssetRow>(
      `UPDATE media_assets SET thumbnail_key = $2 WHERE id = $1 RETURNING *`,
      [id, thumbnailKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const asset = rowToMediaAsset(result.rows[0]);

    logger.debug({
      eventType: 'media_asset.thumbnail_updated',
      assetId: asset.id,
      thumbnailKey,
      traceId: asset.traceId,
    }, 'Thumbnail key updated');

    return asset;
  }

  /**
   * Update preview key
   */
  async updatePreviewKey(id: string, previewKey: string): Promise<MediaAsset | null> {
    const result = await query<MediaAssetRow>(
      `UPDATE media_assets SET preview_key = $2 WHERE id = $1 RETURNING *`,
      [id, previewKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const asset = rowToMediaAsset(result.rows[0]);

    logger.debug({
      eventType: 'media_asset.preview_updated',
      assetId: asset.id,
      previewKey,
      traceId: asset.traceId,
    }, 'Preview key updated');

    return asset;
  }

  /**
   * Update asset status
   */
  async updateStatus(
    id: string,
    status: MediaAssetStatus,
    errorMessage?: string | null
  ): Promise<MediaAsset | null> {
    const result = await query<MediaAssetRow>(
      `UPDATE media_assets SET status = $2, error_message = $3 WHERE id = $1 RETURNING *`,
      [id, status, errorMessage ?? null]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const asset = rowToMediaAsset(result.rows[0]);

    logger.info({
      eventType: 'media_asset.status_changed',
      assetId: asset.id,
      status,
      traceId: asset.traceId,
    }, `Media asset status changed to ${status}`);

    return asset;
  }

  /**
   * Check if asset has both thumbnail and preview keys set
   */
  async hasDerivatives(id: string): Promise<boolean> {
    const result = await query<{ has_both: boolean }>(
      `SELECT (thumbnail_key IS NOT NULL AND preview_key IS NOT NULL) as has_both
       FROM media_assets WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return false;
    }

    return result.rows[0].has_both;
  }
}

// Export singleton instance
export const mediaAssetRepository = new MediaAssetRepository();
