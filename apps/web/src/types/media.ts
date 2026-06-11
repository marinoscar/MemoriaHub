// ---------------------------------------------------------------------------
// MediaItem types (mirrors the Prisma model + thumbnail enrichment)
// ---------------------------------------------------------------------------

export type MediaType = 'photo' | 'video';
export type MediaSource = 'web' | 'cli' | 'android' | 'import' | 'sync';
export type MediaClassification = 'memory' | 'low_value' | 'unreviewed';
export type MediaSortBy = 'capturedAt' | 'importedAt' | 'createdAt';
export type SortOrder = 'asc' | 'desc';

export interface MediaItem {
  id: string;
  storageObjectId: string;
  ownerId: string;
  type: MediaType;
  capturedAt: string | null;
  capturedAtOffset: number | null;
  importedAt: string | null;
  source: MediaSource;
  contentHash: string | null;
  classification: MediaClassification;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  orientation: number | null;
  takenLat: number | null;
  takenLng: number | null;
  takenAltitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  originalFilename: string;
  title: string | null;
  caption: string | null;
  description: string | null;
  favorite: boolean;
  geoCountry: string | null;
  geoCountryCode: string | null;
  geoAdmin1: string | null;
  geoAdmin2: string | null;
  geoLocality: string | null;
  geoPlaceName: string | null;
  geoSource: string | null;
  geocodedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  metadata: Record<string, unknown> | null;
  // Enriched fields from thumbnail processing
  thumbnailUrl: string | null;
  // Only on GET /api/media/:id
  downloadUrl?: string | null;
}

export interface MediaListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

// Album list uses the same meta shape
export type AlbumListMeta = MediaListMeta;

export interface MediaListResponse {
  items: MediaItem[];
  meta: MediaListMeta;
}

// ---------------------------------------------------------------------------
// Query parameter types
// ---------------------------------------------------------------------------

export interface MediaQueryParams {
  page?: number;
  pageSize?: number;
  type?: MediaType;
  capturedAtFrom?: string;
  capturedAtTo?: string;
  classification?: MediaClassification;
  albumId?: string;
  favorite?: boolean;
  tag?: string;
  country?: string;
  region?: string;
  locality?: string;
  place?: string;
  location?: string;
  sortBy?: MediaSortBy;
  sortOrder?: SortOrder;
}

// ---------------------------------------------------------------------------
// Patch (update) DTO
// ---------------------------------------------------------------------------

export interface PatchMediaDto {
  capturedAt?: string | null;
  classification?: MediaClassification;
  title?: string | null;
  caption?: string | null;
  description?: string | null;
  favorite?: boolean;
}

// ---------------------------------------------------------------------------
// Create (register) DTO
// ---------------------------------------------------------------------------

export interface RegisterMediaDto {
  storageObjectId: string;
  type: MediaType;
  source: MediaSource;
  originalFilename: string;
  capturedAt?: string;
  capturedAtOffset?: number;
  classification?: MediaClassification;
  title?: string;
  caption?: string;
  description?: string;
  favorite?: boolean;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagItem {
  id: string;
  name: string;
  count: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Upload types
// ---------------------------------------------------------------------------

export interface InitUploadDto {
  name: string;
  size: number;
  mimeType: string;
}

export interface PresignedUrlPart {
  partNumber: number;
  url: string;
}

export interface InitUploadResponse {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: PresignedUrlPart[];
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}

export interface CompleteUploadDto {
  parts: UploadPart[];
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

export interface Album {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlbumListResponse {
  items: Album[];
  meta: MediaListMeta;
}

export interface AlbumDetail extends Album {
  items: MediaItem[];
}

export interface CreateAlbumDto {
  name: string;
  description?: string;
}

export interface AlbumQueryParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: SortOrder;
}
