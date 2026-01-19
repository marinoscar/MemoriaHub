import type {
  MediaAsset,
  MediaAssetStatus,
  MediaType,
  FileSource,
  ExifData,
  FaceData,
  TagData,
} from '@memoriahub/shared';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';
import { getTraceId } from '../../logging/request-context.js';

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
 * Input for creating a media asset
 */
export interface CreateMediaAssetInput {
  id?: string;
  libraryId: string;
  storageKey: string;
  storageBucket: string;
  originalFilename: string;
  mediaType: MediaType;
  mimeType: string;
  fileSize: number;
  fileSource: FileSource;
  traceId?: string | null;
}

/**
 * Input for updating a media asset
 */
export interface UpdateMediaAssetInput {
  thumbnailKey?: string | null;
  previewKey?: string | null;
  fileSize?: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  locationName?: string | null;
  capturedAtUtc?: Date | null;
  timezoneOffset?: number | null;
  exifData?: ExifData;
  faces?: unknown[];
  tags?: unknown[];
  status?: MediaAssetStatus;
  errorMessage?: string | null;
}

/**
 * Options for listing media assets
 */
export interface ListMediaAssetsOptions {
  libraryId: string;
  page?: number;
  limit?: number;
  status?: MediaAssetStatus;
  mediaType?: MediaType;
  country?: string;
  state?: string;
  city?: string;
  cameraMake?: string;
  cameraModel?: string;
  startDate?: Date;
  endDate?: Date;
  sortBy?: 'capturedAt' | 'createdAt' | 'filename' | 'fileSize';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Media asset repository implementation
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
   * Find media assets by library ID with filtering and pagination
   */
  async findByLibraryId(
    options: ListMediaAssetsOptions
  ): Promise<{ assets: MediaAsset[]; total: number }> {
    const {
      libraryId,
      page = 1,
      limit = 50,
      status,
      mediaType,
      country,
      state,
      city,
      cameraMake,
      cameraModel,
      startDate,
      endDate,
      sortBy = 'capturedAt',
      sortOrder = 'desc',
    } = options;
    const offset = (page - 1) * limit;

    // Build WHERE clause
    const conditions: string[] = ['library_id = $1'];
    const params: unknown[] = [libraryId];
    let paramIndex = 2;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (mediaType) {
      conditions.push(`media_type = $${paramIndex++}`);
      params.push(mediaType);
    }
    if (country) {
      conditions.push(`country = $${paramIndex++}`);
      params.push(country);
    }
    if (state) {
      conditions.push(`state = $${paramIndex++}`);
      params.push(state);
    }
    if (city) {
      conditions.push(`city = $${paramIndex++}`);
      params.push(city);
    }
    if (cameraMake) {
      conditions.push(`camera_make = $${paramIndex++}`);
      params.push(cameraMake);
    }
    if (cameraModel) {
      conditions.push(`camera_model = $${paramIndex++}`);
      params.push(cameraModel);
    }
    if (startDate) {
      conditions.push(`captured_at_utc >= $${paramIndex++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`captured_at_utc <= $${paramIndex++}`);
      params.push(endDate);
    }

    const whereClause = conditions.join(' AND ');

    // Map sortBy to column
    const sortColumnMap: Record<string, string> = {
      capturedAt: 'COALESCE(captured_at_utc, created_at)',
      createdAt: 'created_at',
      filename: 'original_filename',
      fileSize: 'file_size',
    };
    const sortColumn = sortColumnMap[sortBy] || 'COALESCE(captured_at_utc, created_at)';

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM media_assets WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get assets
    const result = await query<MediaAssetRow>(
      `SELECT * FROM media_assets
       WHERE ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      assets: result.rows.map(rowToMediaAsset),
      total,
    };
  }

  /**
   * Create a new media asset
   */
  async create(input: CreateMediaAssetInput): Promise<MediaAsset> {
    const traceId = input.traceId || getTraceId();

    const result = await query<MediaAssetRow>(
      `INSERT INTO media_assets (
        id, library_id, storage_key, storage_bucket,
        original_filename, media_type, mime_type, file_size, file_source,
        status, trace_id
      )
       VALUES (
        COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, 'UPLOADED', $10
       )
       RETURNING *`,
      [
        input.id || null,
        input.libraryId,
        input.storageKey,
        input.storageBucket,
        input.originalFilename,
        input.mediaType,
        input.mimeType,
        input.fileSize,
        input.fileSource,
        traceId,
      ]
    );

    const asset = rowToMediaAsset(result.rows[0]);

    logger.info({
      eventType: 'media_asset.created',
      assetId: asset.id,
      libraryId: asset.libraryId,
      filename: asset.originalFilename,
      mediaType: asset.mediaType,
      traceId,
    }, 'Media asset created');

    return asset;
  }

  /**
   * Update a media asset
   */
  async update(id: string, input: UpdateMediaAssetInput): Promise<MediaAsset | null> {
    const traceId = getTraceId();
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    // Build update clauses
    if (input.thumbnailKey !== undefined) {
      updates.push(`thumbnail_key = $${paramIndex++}`);
      values.push(input.thumbnailKey);
    }
    if (input.previewKey !== undefined) {
      updates.push(`preview_key = $${paramIndex++}`);
      values.push(input.previewKey);
    }
    if (input.fileSize !== undefined) {
      updates.push(`file_size = $${paramIndex++}`);
      values.push(input.fileSize);
    }
    if (input.width !== undefined) {
      updates.push(`width = $${paramIndex++}`);
      values.push(input.width);
    }
    if (input.height !== undefined) {
      updates.push(`height = $${paramIndex++}`);
      values.push(input.height);
    }
    if (input.durationSeconds !== undefined) {
      updates.push(`duration_seconds = $${paramIndex++}`);
      values.push(input.durationSeconds);
    }
    if (input.cameraMake !== undefined) {
      updates.push(`camera_make = $${paramIndex++}`);
      values.push(input.cameraMake);
    }
    if (input.cameraModel !== undefined) {
      updates.push(`camera_model = $${paramIndex++}`);
      values.push(input.cameraModel);
    }
    if (input.latitude !== undefined) {
      updates.push(`latitude = $${paramIndex++}`);
      values.push(input.latitude);
    }
    if (input.longitude !== undefined) {
      updates.push(`longitude = $${paramIndex++}`);
      values.push(input.longitude);
    }
    if (input.country !== undefined) {
      updates.push(`country = $${paramIndex++}`);
      values.push(input.country);
    }
    if (input.state !== undefined) {
      updates.push(`state = $${paramIndex++}`);
      values.push(input.state);
    }
    if (input.city !== undefined) {
      updates.push(`city = $${paramIndex++}`);
      values.push(input.city);
    }
    if (input.locationName !== undefined) {
      updates.push(`location_name = $${paramIndex++}`);
      values.push(input.locationName);
    }
    if (input.capturedAtUtc !== undefined) {
      updates.push(`captured_at_utc = $${paramIndex++}`);
      values.push(input.capturedAtUtc);
    }
    if (input.timezoneOffset !== undefined) {
      updates.push(`timezone_offset = $${paramIndex++}`);
      values.push(input.timezoneOffset);
    }
    if (input.exifData !== undefined) {
      updates.push(`exif_data = $${paramIndex++}`);
      values.push(JSON.stringify(input.exifData));
    }
    if (input.faces !== undefined) {
      updates.push(`faces = $${paramIndex++}`);
      values.push(JSON.stringify(input.faces));
    }
    if (input.tags !== undefined) {
      updates.push(`tags = $${paramIndex++}`);
      values.push(JSON.stringify(input.tags));
    }
    if (input.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.errorMessage !== undefined) {
      updates.push(`error_message = $${paramIndex++}`);
      values.push(input.errorMessage);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    const result = await query<MediaAssetRow>(
      `UPDATE media_assets SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    const asset = rowToMediaAsset(result.rows[0]);

    logger.debug({
      eventType: 'media_asset.updated',
      assetId: asset.id,
      updates: Object.keys(input),
      traceId,
    }, 'Media asset updated');

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
    const traceId = getTraceId();

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
      traceId,
    }, `Media asset status changed to ${status}`);

    return asset;
  }

  /**
   * Delete a media asset
   */
  async delete(id: string): Promise<boolean> {
    const traceId = getTraceId();

    const result = await query(
      'DELETE FROM media_assets WHERE id = $1',
      [id]
    );

    const deleted = (result.rowCount ?? 0) > 0;

    if (deleted) {
      logger.info({
        eventType: 'media_asset.deleted',
        assetId: id,
        traceId,
      }, 'Media asset deleted');
    }

    return deleted;
  }

  /**
   * Delete multiple assets
   */
  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const traceId = getTraceId();

    const result = await query(
      `DELETE FROM media_assets WHERE id = ANY($1)`,
      [ids]
    );

    const count = result.rowCount ?? 0;

    logger.info({
      eventType: 'media_asset.bulk_deleted',
      count,
      traceId,
    }, `Deleted ${count} media assets`);

    return count;
  }

  /**
   * Get assets pending processing by job type
   */
  async findPendingProcessing(
    jobType: string,
    limit: number = 10
  ): Promise<MediaAsset[]> {
    // Find assets that need this job type but don't have a pending/processing job for it
    const result = await query<MediaAssetRow>(
      `SELECT ma.* FROM media_assets ma
       WHERE ma.status != 'ERROR'
       AND NOT EXISTS (
         SELECT 1 FROM processing_jobs pj
         WHERE pj.asset_id = ma.id
         AND pj.job_type = $1
         AND pj.status IN ('pending', 'processing')
       )
       ORDER BY ma.created_at ASC
       LIMIT $2`,
      [jobType, limit]
    );

    return result.rows.map(rowToMediaAsset);
  }

  /**
   * Count assets by status in a library
   */
  async countByStatus(libraryId: string): Promise<Record<MediaAssetStatus, number>> {
    const result = await query<{ status: MediaAssetStatus; count: string }>(
      `SELECT status, COUNT(*)::text as count
       FROM media_assets
       WHERE library_id = $1
       GROUP BY status`,
      [libraryId]
    );

    const counts: Record<MediaAssetStatus, number> = {
      UPLOADED: 0,
      METADATA_EXTRACTED: 0,
      DERIVATIVES_READY: 0,
      ENRICHED: 0,
      INDEXED: 0,
      READY: 0,
      ERROR: 0,
    };

    for (const row of result.rows) {
      counts[row.status] = parseInt(row.count, 10);
    }

    return counts;
  }
}

// Export singleton instance
export const mediaAssetRepository = new MediaAssetRepository();
