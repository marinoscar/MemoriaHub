/**
 * Media Asset Types
 * Types for photos and videos uploaded to MemoriaHub
 */

/**
 * Media asset status lifecycle
 * UPLOADED → METADATA_EXTRACTED → DERIVATIVES_READY → ENRICHED → INDEXED → READY
 */
export type MediaAssetStatus =
  | 'UPLOADED'
  | 'METADATA_EXTRACTED'
  | 'DERIVATIVES_READY'
  | 'ENRICHED'
  | 'INDEXED'
  | 'READY'
  | 'ERROR';

/**
 * Media type (image or video)
 */
export type MediaType = 'image' | 'video';

/**
 * File source - where the upload came from
 */
export type FileSource = 'web' | 'webdav' | 'api';

/**
 * Processing job types
 */
export type ProcessingJobType =
  | 'extract_metadata'
  | 'generate_thumbnail'
  | 'generate_preview'
  | 'reverse_geocode'
  | 'detect_faces'
  | 'detect_objects'
  | 'index_search';

/**
 * Processing job status
 */
export type ProcessingJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Ingestion event status
 */
export type IngestionStatus = 'pending' | 'completed' | 'failed';

/**
 * EXIF metadata structure
 * Contains camera settings and capture information
 */
export interface ExifData {
  // Camera information
  make?: string;
  model?: string;
  software?: string;
  lensModel?: string;

  // Capture time
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
  offsetTimeOriginal?: string;

  // Exposure settings
  exposureTime?: string;
  fNumber?: number;
  iso?: number;
  exposureProgram?: string;
  exposureMode?: string;
  exposureBias?: number;

  // Lens settings
  focalLength?: number;
  focalLengthIn35mm?: number;
  aperture?: number;

  // Flash
  flash?: string;
  flashMode?: string;

  // Image settings
  whiteBalance?: string;
  meteringMode?: string;
  colorSpace?: string;
  orientation?: number;

  // GPS data
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsAltitude?: number;
  gpsSpeed?: number;
  gpsDirection?: number;
  gpsTimestamp?: string;

  // Additional fields (extensible)
  [key: string]: unknown;
}

/**
 * Media asset entity (internal representation)
 * Note: Media is owned by a user (ownerId), not a library.
 * Libraries are linked via the library_assets junction table.
 */
export interface MediaAsset {
  id: string;
  ownerId: string; // User who owns this media

  // Storage
  storageKey: string;
  storageBucket: string;
  thumbnailKey: string | null;
  previewKey: string | null;

  // File info
  originalFilename: string;
  mediaType: MediaType;
  mimeType: string;
  fileSize: number;
  fileSource: FileSource;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;

  // Camera (searchable)
  cameraMake: string | null;
  cameraModel: string | null;

  // Location (searchable)
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locationName: string | null;

  // Time (searchable)
  capturedAtUtc: Date | null;
  timezoneOffset: number | null;

  // Full EXIF
  exifData: ExifData;

  // AI enrichment
  faces: FaceData[];
  tags: TagData[];

  // Status
  status: MediaAssetStatus;
  errorMessage: string | null;
  traceId: string | null;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Media asset DTO for API responses
 */
export interface MediaAssetDTO {
  id: string;
  ownerId: string;
  ownerName?: string;
  ownerEmail?: string;
  originalFilename: string;
  mediaType: MediaType;
  mimeType: string;
  fileSize: number;
  fileSource: FileSource;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;

  // Camera
  cameraMake: string | null;
  cameraModel: string | null;

  // Location
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locationName: string | null;

  // Time
  capturedAtUtc: string | null;
  timezoneOffset: number | null;

  // URLs (presigned)
  thumbnailUrl: string | null;
  previewUrl: string | null;
  originalUrl: string;

  // EXIF (optional, included on detail view)
  exifData?: ExifData;

  // Status
  status: MediaAssetStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Face detection data (for future AI features)
 */
export interface FaceData {
  id?: string;
  personId?: string;
  personName?: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
  embedding?: number[];
}

/**
 * Tag/label data (for future AI features)
 */
export interface TagData {
  label: string;
  confidence: number;
  source: 'ai' | 'manual';
}

/**
 * Input for initiating an upload
 * Note: libraryId is optional - if provided, the asset will be added to the library after upload
 */
export interface InitiateUploadInput {
  filename: string;
  mimeType: string;
  fileSize: number;
  libraryId?: string; // Optional - add to library after upload
}

/**
 * Response from initiating an upload
 */
export interface PresignedUploadResponse {
  assetId: string;
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
}

/**
 * Input for completing an upload
 */
export interface CompleteUploadInput {
  assetId: string;
}

/**
 * Input for listing media assets
 * Note: libraryId is optional - if not provided, returns all accessible media
 */
export interface ListMediaInput {
  libraryId?: string; // Optional - filter by library
  ownerId?: string; // Optional - filter by owner
  page?: number;
  limit?: number;
  status?: MediaAssetStatus;
  mediaType?: MediaType;
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
 * Ingestion event entity
 */
export interface IngestionEvent {
  id: string;
  assetId: string;
  source: FileSource;
  clientInfo: Record<string, unknown>;
  traceId: string;
  startedAt: Date;
  completedAt: Date | null;
  status: IngestionStatus;
  errorMessage: string | null;
}

/**
 * Processing job queue types
 */
export type ProcessingJobQueue = 'default' | 'large_files' | 'priority' | 'ai';

/**
 * Processing job result (stored after completion)
 */
export interface ProcessingJobResult {
  outputKey?: string;
  outputSize?: number;
  durationMs?: number;
  [key: string]: unknown;
}

/**
 * Processing job entity
 */
export interface ProcessingJob {
  id: string;
  assetId: string;
  jobType: ProcessingJobType;
  queue: ProcessingJobQueue;
  priority: number;
  payload: Record<string, unknown>;
  status: ProcessingJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  workerId: string | null;
  result: ProcessingJobResult | null;
  traceId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  nextRetryAt: Date | null;
}

/**
 * Extracted metadata from EXIF
 */
export interface ExtractedMetadata {
  // Camera
  cameraMake: string | null;
  cameraModel: string | null;

  // Location
  latitude: number | null;
  longitude: number | null;

  // Time
  capturedAtUtc: Date | null;
  timezoneOffset: number | null;

  // Dimensions
  width: number | null;
  height: number | null;
  orientation: number | null;

  // Video duration
  durationSeconds: number | null;

  // Full EXIF
  exifData: ExifData;
}

/**
 * Geocoding result
 */
export interface GeocodingResult {
  country: string | null;
  state: string | null;
  city: string | null;
  locationName: string | null;
}

/**
 * Allowed MIME types for uploads
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
] as const;

export const ALLOWED_MEDIA_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
] as const;

/**
 * Default max upload size (100MB)
 */
export const DEFAULT_MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

/**
 * Default presigned URL expiration (1 hour)
 */
export const DEFAULT_PRESIGNED_URL_EXPIRATION = 3600;

// =============================================================================
// Media Sharing Types
// =============================================================================

/**
 * Media share entity (internal representation)
 * Represents direct user-to-user sharing of a media asset
 */
export interface MediaShare {
  id: string;
  assetId: string;
  sharedWithUserId: string;
  sharedByUserId: string;
  createdAt: Date;
}

/**
 * Media share DTO for API responses
 */
export interface MediaShareDTO {
  id: string;
  assetId: string;
  sharedWithUserId: string;
  sharedWithUserEmail: string;
  sharedWithUserName?: string;
  sharedByUserId: string;
  sharedByUserEmail?: string;
  sharedByUserName?: string;
  createdAt: string;
}

/**
 * Input for sharing media with users
 */
export interface ShareMediaInput {
  userIds: string[]; // Users to share with
}

/**
 * Input for revoking a share
 */
export interface RevokeShareInput {
  userId: string;
}

// =============================================================================
// Library-Asset Junction Types
// =============================================================================

/**
 * Library asset entity (internal representation)
 * Represents the many-to-many relationship between libraries and assets
 */
export interface LibraryAsset {
  id: string;
  libraryId: string;
  assetId: string;
  addedByUserId: string;
  createdAt: Date;
}

/**
 * Library asset DTO for API responses
 */
export interface LibraryAssetDTO {
  id: string;
  libraryId: string;
  assetId: string;
  addedByUserId: string;
  addedByUserEmail?: string;
  addedByUserName?: string;
  createdAt: string;
}

/**
 * Input for adding an asset to a library
 */
export interface AddAssetToLibraryInput {
  assetId: string;
}

/**
 * Input for adding multiple assets to a library
 */
export interface AddAssetsToLibraryInput {
  assetIds: string[];
}

/**
 * Input for removing an asset from a library
 */
export interface RemoveAssetFromLibraryInput {
  assetId: string;
}

// =============================================================================
// Bulk Operations Types
// =============================================================================

/**
 * Input for bulk updating metadata
 */
export interface BulkUpdateMetadataInput {
  updates: Array<{
    assetId: string;
    capturedAtUtc?: string;
    latitude?: number | null;
    longitude?: number | null;
    country?: string | null;
    state?: string | null;
    city?: string | null;
    locationName?: string | null;
  }>;
}

/**
 * Result from bulk metadata update
 */
export interface BulkUpdateMetadataResult {
  updated: string[];
  failed: Array<{ assetId: string; error: string }>;
}

/**
 * Input for bulk delete
 */
export interface BulkDeleteInput {
  assetIds: string[];
}

/**
 * Result from bulk delete
 */
export interface BulkDeleteResult {
  deleted: string[];
  failed: Array<{ assetId: string; error: string }>;
}

// =============================================================================
// Access Control Types
// =============================================================================

/**
 * How the user has access to a media asset
 */
export type MediaAccessType = 'owner' | 'shared' | 'library_member' | 'public';

/**
 * Media asset with access information
 */
export interface MediaAssetWithAccess extends MediaAsset {
  accessType: MediaAccessType;
  libraryIds?: string[]; // Libraries this asset belongs to that the user can access
}
