// ---------------------------------------------------------------------------
// MediaLocation — lightweight shape returned by GET /api/media/locations
// ---------------------------------------------------------------------------

export interface MediaLocation {
  id: string;
  takenLat: number;
  takenLng: number;
  capturedAt: string | null;
  geoLocality: string | null;
  thumbnailUrl: string | null;
}

// ---------------------------------------------------------------------------
// MediaItem types (mirrors the Prisma model + thumbnail enrichment)
// ---------------------------------------------------------------------------

export type MediaType = 'photo' | 'video';
export type MediaSource = 'web' | 'cli' | 'android' | 'import' | 'sync';
export type MediaSortBy = 'capturedAt' | 'importedAt' | 'createdAt';
export type SortOrder = 'asc' | 'desc';

export interface MediaItem {
  id: string;
  storageObjectId: string;
  addedById: string;
  circleId: string;
  type: MediaType;
  capturedAt: string | null;
  capturedAtOffset: number | null;
  importedAt: string | null;
  source: MediaSource;
  contentHash: string | null;
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
  // Tag names associated with this item
  tags?: string[];
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
  /** Filter by exact SHA-256 hex digest (64 lower-case hex chars). */
  contentHash?: string;
  circleId?: string;
  cameraMake?: string;
  cameraModel?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  missingGeo?: boolean;
  /** Filter media items by person ID (returns items containing faces assigned to this person). */
  personId?: string;
  /** Filter by multiple person IDs. Backend accepts comma-separated param. */
  personIds?: string[];
  /** Match mode for multi-person filter. Default: 'any' (OR). */
  peopleMatch?: 'any' | 'all';
  /** Filter to items with no detected faces (no_faces detection status). */
  noFaces?: boolean;
}

// ---------------------------------------------------------------------------
// Patch (update) DTO
// ---------------------------------------------------------------------------

export interface PatchMediaDto {
  capturedAt?: string | null;
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
  circleId: string;
  capturedAt?: string;
  capturedAtOffset?: number;
  description?: string;
  favorite?: boolean;
  /** SHA-256 hex digest (64 lower-case hex chars) of the file bytes. */
  contentHash?: string;
}

/**
 * Response from POST /api/media.
 * Extends MediaItem with a server-side deduplication flag:
 *   - `true`  → server matched an existing item by contentHash (HTTP 200)
 *   - `false` → fresh creation (HTTP 201)
 *   - absent  → server does not support the field (treat as fresh)
 */
export interface RegisterMediaResponse extends MediaItem {
  deduplicated?: boolean;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagItem {
  id: string;
  name: string;
  count: number;
  createdAt: string;
  circleId: string;
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
  eTag: string;
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
  addedById: string;
  circleId: string;
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
  circleId: string;
}

export interface AlbumQueryParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: SortOrder;
  circleId?: string;
}

export interface UpdateAlbumDto {
  name?: string;
  description?: string | null;
}

export type AddAlbumItemsByFilterDto = Omit<
  MediaQueryParams,
  'page' | 'pageSize' | 'sortBy' | 'sortOrder'
>;

// ---------------------------------------------------------------------------
// Bulk operation DTOs
// ---------------------------------------------------------------------------

export interface BulkUpdateDto {
  circleId: string;
  ids: string[];
  set: {
    location?: { lat: number; lng: number; altitude?: number } | null;
    favorite?: boolean;
  };
}

export interface BulkTagsDto {
  circleId: string;
  ids: string[];
  add?: string[];
  remove?: string[];
}

export interface BulkDeleteDto {
  circleId: string;
  ids: string[];
}

// ---------------------------------------------------------------------------
// Geo search / reverse geocode
// ---------------------------------------------------------------------------

export interface GeoSearchResult {
  lat: number;
  lng: number;
  label: string;
}

export interface GeoReverseResult {
  country: string | null;
  countryCode: string | null;
  admin1: string | null;
  admin2: string | null;
  locality: string | null;
  placeName: string | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardResponse {
  onThisDay: MediaItem[];
  recent: MediaItem[];
  favorites: MediaItem[];
  counts: {
    total: number;
    missingGeo: number;
    pendingBurstGroups?: number;
    pendingSimilarityGroups?: number;
  };
}
