// ---------------------------------------------------------------------------
// MediaLocation — lightweight shape returned by GET /api/media/locations
// ---------------------------------------------------------------------------

/**
 * Media Location.
 *
 * @stability experimental
 */
export interface MediaLocation {
  id: string;
  takenLat: number;
  takenLng: number;
  capturedAt: string | null;
  geoLocality: string | null;
  /**
   * Signed thumbnail URL. Optional because the lightweight
   * GET /api/media/locations endpoint no longer returns it — thumbnails are
   * fetched lazily in a second batch via GET /api/media/thumbnails.
   */
  thumbnailUrl?: string | null;
}

// ---------------------------------------------------------------------------
// MapCluster — server-side grid-clustered aggregate returned by
// GET /api/media/locations/aggregate (hot path; no thumbnails)
// ---------------------------------------------------------------------------

/**
 * Map Cluster.
 *
 * @stability experimental
 */
export interface MapCluster {
  lat: number;
  lng: number;
  count: number;
  /** A representative media item id for the cell (used for count === 1). */
  sampleId: string;
  /**
   * True bounding box of the cell's MEMBER POINTS — not the grid cell's
   * geometric bounds, and not derived from `lat`/`lng` (which are the centroid
   * of those points). A grid cell spans `90 / 2^zoom` degrees (~620 km at zoom
   * 4), so the centroid alone cannot locate the cell's photos; these four
   * numbers are what the "Photos here" drawer turns into the `bbox` it refetches
   * the cell's actual photos with. For a single-point cell min === max.
   */
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

// ---------------------------------------------------------------------------
// LocationExtent — true bounding box across all a circle's geotagged items,
// returned by GET /api/media/locations/extent (used for initial map framing)
// ---------------------------------------------------------------------------

/**
 * Location Extent.
 *
 * @stability experimental
 */
export interface LocationExtent {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  count: number;
}

// ---------------------------------------------------------------------------
// MediaItem types (mirrors the Prisma model + thumbnail enrichment)
// ---------------------------------------------------------------------------

/**
 * Media Type.
 *
 * @stability experimental
 */
export type MediaType = 'photo' | 'video';
/**
 * Media Source.
 *
 * @stability experimental
 */
export type MediaSource = 'web' | 'cli' | 'android' | 'import' | 'sync';
/**
 * Media Sort By.
 *
 * @stability experimental
 */
export type MediaSortBy = 'capturedAt' | 'importedAt' | 'createdAt';
/**
 * Sort Order.
 *
 * @stability experimental
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Media Item.
 *
 * @stability experimental
 */
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
  /**
   * Location Grouping (epic #373) — the admin-curated canonical name each raw
   * geocoder value collapses into. Derived columns maintained by the rebuild
   * job; equal to the raw value when no group claims it. Optional here because
   * not every list endpoint selects them.
   */
  geoCanonicalCountry?: string | null;
  geoCanonicalAdmin1?: string | null;
  geoCanonicalLocality?: string | null;
  geocodedAt: string | null;
  coordSource: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  burstGroupId: string | null;
  duplicateGroupId: string | null;
  metadata: Record<string, unknown> | null;
  // Enriched fields from thumbnail processing
  thumbnailUrl: string | null;
  // Only on GET /api/media/:id
  downloadUrl?: string | null;
  // Tag names associated with this item
  tags?: string[];
}

/**
 * Offset (legacy) pagination meta — still returned by endpoints that send a
 * `page` query param (Album lists, Search, Trash, Archive).
 *
 * @stability experimental
 */
export interface MediaListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * Keyset (cursor) pagination meta — returned by `GET /api/media` when the
 * request OMITS `page`. The gallery feed uses this mode.
 *
 * @stability experimental
 */
export interface MediaKeysetMeta {
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

// Album list uses the same offset meta shape
/**
 * Album List Meta.
 *
 * @stability experimental
 */
export type AlbumListMeta = MediaListMeta;

/**
 * Offset-paginated list response (Album/Search/Trash/Archive).
 *
 * @stability experimental
 */
export interface MediaListResponse {
  items: MediaItem[];
  meta: MediaListMeta;
}

/**
 * Keyset-paginated list response (gallery feed via `GET /api/media`).
 *
 * @stability experimental
 */
export interface MediaKeysetResponse {
  items: MediaItem[];
  meta: MediaKeysetMeta;
}

// ---------------------------------------------------------------------------
// Query parameter types
// ---------------------------------------------------------------------------

/**
 * Media Query Params.
 *
 * @stability experimental
 */
export interface MediaQueryParams {
  page?: number;
  pageSize?: number;
  /**
   * Keyset pagination cursor for `GET /api/media`. When provided (and `page`
   * is omitted) the backend returns the next page after this cursor. `null` /
   * omitted requests the first page.
   */
  cursor?: string | null;
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
  /** Exclude archived items from results (archived are included by default). */
  excludeArchived?: boolean;
}

// ---------------------------------------------------------------------------
// Patch (update) DTO
// ---------------------------------------------------------------------------

/**
 * Patch Media Dto.
 *
 * @stability experimental
 */
export interface PatchMediaDto {
  capturedAt?: string | null;
  description?: string | null;
  favorite?: boolean;
}

// ---------------------------------------------------------------------------
// Create (register) DTO
// ---------------------------------------------------------------------------

/**
 * Register Media Dto.
 *
 * @stability experimental
 */
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
 *
 * @stability experimental
 */
export interface RegisterMediaResponse extends MediaItem {
  deduplicated?: boolean;
  /**
   * Id of the created (or existing deduplicated) MediaItem. Always present so
   * the client can attach an instant local upload preview to the right item.
   */
  mediaItemId: string;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Tag Item.
 *
 * @stability experimental
 */
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

/**
 * Init Upload Dto.
 *
 * @stability experimental
 */
export interface InitUploadDto {
  name: string;
  size: number;
  mimeType: string;
}

/**
 * Presigned Url Part.
 *
 * @stability experimental
 */
export interface PresignedUrlPart {
  partNumber: number;
  url: string;
}

/**
 * Init Upload Response.
 *
 * @stability experimental
 */
export interface InitUploadResponse {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: PresignedUrlPart[];
  /**
   * How to authenticate the PUT of each URL (issue #506). `'none'`: a
   * presigned S3/R2 URL, sent with no Authorization header. `'bearer'`: the
   * API's own part route (local storage provider), sent with the caller's
   * bearer token. Absent from older servers, which only ever presigned.
   */
  partUploadAuth?: PartUploadAuth;
}

/**
 * Part Upload Auth.
 *
 * @stability experimental
 */
export type PartUploadAuth = 'none' | 'bearer';

/**
 * Upload Part.
 *
 * @stability experimental
 */
export interface UploadPart {
  partNumber: number;
  eTag: string;
}

/**
 * Complete Upload Dto.
 *
 * @stability experimental
 */
export interface CompleteUploadDto {
  parts: UploadPart[];
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

/**
 * Album.
 *
 * @stability experimental
 */
export interface Album {
  id: string;
  name: string;
  description: string | null;
  addedById: string;
  circleId: string;
  createdAt: string;
  updatedAt: string;
  /** Media item chosen as the album cover; null when unset. */
  coverMediaItemId?: string | null;
  /** Signed thumbnail URL of the cover item (or fallback); null when none. */
  coverThumbnailUrl?: string | null;
  /** Number of media items in the album. */
  itemCount?: number;
  /** Earliest / latest capturedAt across the album's items; null when empty. */
  dateRange?: { min: string; max: string } | null;
}

/**
 * Album List Response.
 *
 * @stability experimental
 */
export interface AlbumListResponse {
  items: Album[];
  meta: MediaListMeta;
}

/**
 * Album Detail.
 *
 * @stability experimental
 */
export interface AlbumDetail extends Album {
  items: MediaItem[];
}

/**
 * Create Album Dto.
 *
 * @stability experimental
 */
export interface CreateAlbumDto {
  name: string;
  description?: string;
  circleId: string;
}

/**
 * Album Query Params.
 *
 * @stability experimental
 */
export interface AlbumQueryParams {
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: SortOrder;
  circleId?: string;
}

/**
 * Update Album Dto.
 *
 * @stability experimental
 */
export interface UpdateAlbumDto {
  name?: string;
  description?: string | null;
  /** UUID sets the album cover; null clears it. */
  coverMediaItemId?: string | null;
}

/**
 * Add Album Items By Filter Dto.
 *
 * @stability experimental
 */
export type AddAlbumItemsByFilterDto = Omit<
  MediaQueryParams,
  'page' | 'pageSize' | 'sortBy' | 'sortOrder'
>;

// ---------------------------------------------------------------------------
// Bulk operation DTOs
// ---------------------------------------------------------------------------

/**
 * Bulk Update Dto.
 *
 * @stability experimental
 */
export interface BulkUpdateDto {
  circleId: string;
  ids: string[];
  set: {
    location?: { lat: number; lng: number; altitude?: number } | null;
    favorite?: boolean;
    capturedAt?: string | null;
  };
}

/**
 * Bulk Tags Dto.
 *
 * @stability experimental
 */
export interface BulkTagsDto {
  circleId: string;
  ids: string[];
  add?: string[];
  remove?: string[];
}

/**
 * Bulk Delete Dto.
 *
 * @stability experimental
 */
export interface BulkDeleteDto {
  circleId: string;
  ids: string[];
}

/**
 * Bulk Archive Dto.
 *
 * @stability experimental
 */
export interface BulkArchiveDto {
  circleId: string;
  ids: string[];
}

/**
 * List Archived Params.
 *
 * @stability experimental
 */
export interface ListArchivedParams {
  circleId: string;
  page?: number;
  pageSize?: number;
}

/**
 * List Trash Params.
 *
 * @stability experimental
 */
export interface ListTrashParams {
  circleId: string;
  page?: number;
  pageSize?: number;
}

/**
 * Restore From Trash Dto.
 *
 * @stability experimental
 */
export interface RestoreFromTrashDto {
  circleId: string;
  ids: string[];
}

/**
 * Restore From Trash Response.
 *
 * @stability experimental
 */
export interface RestoreFromTrashResponse {
  restored: number;
  conflicts: string[];
}

/**
 * Delete Forever Dto.
 *
 * @stability experimental
 */
export interface DeleteForeverDto {
  circleId: string;
  ids: string[];
}

/**
 * Empty Trash Dto.
 *
 * @stability experimental
 */
export interface EmptyTrashDto {
  circleId: string;
}

// ---------------------------------------------------------------------------
// Geo search / reverse geocode
// ---------------------------------------------------------------------------

/**
 * Geo Search Result.
 *
 * @stability experimental
 */
export interface GeoSearchResult {
  lat: number;
  lng: number;
  label: string;
}

/**
 * Geo Reverse Result.
 *
 * @stability experimental
 */
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

/**
 * Dashboard Response.
 *
 * @stability experimental
 */
export interface DashboardResponse {
  onThisDay: MediaItem[];
  recent: MediaItem[];
  favorites: MediaItem[];
  counts: {
    total: number;
    missingGeo: number;
    pendingBurstGroups?: number;
    pendingDuplicateGroups?: number;
    pendingLocationSuggestions?: number;
    /** Enhancements awaiting a keep-both / replace / discard decision. */
    pendingEnhancements?: number;
  };
}

// ---------------------------------------------------------------------------
// Review counts
// ---------------------------------------------------------------------------

/**
 * Response of `GET /api/media/review-counts` — the four review-queue counts
 * the dashboard nests under `counts`, without the On This Day / recent /
 * favorites payload or any thumbnail signing.
 *
 * Unlike `DashboardResponse['counts']`, every field here is a required number:
 * the endpoint exists to serve these specific counts and always computes all
 * four.
 *
 * @stability experimental
 */
export interface ReviewCountsResponse {
  pendingBurstGroups: number;
  pendingDuplicateGroups: number;
  pendingLocationSuggestions: number;
  /** Enhancements awaiting a keep-both / replace / discard decision. */
  pendingEnhancements: number;
}
