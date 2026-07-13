import { api } from './api';
import type {
  MediaItem,
  MediaListResponse,
  MediaQueryParams,
  MediaLocation,
  MapCluster,
  LocationExtent,
  PatchMediaDto,
  RegisterMediaDto,
  RegisterMediaResponse,
  TagItem,
  InitUploadDto,
  InitUploadResponse,
  UploadPart,
  Album,
  AlbumListResponse,
  AlbumDetail,
  CreateAlbumDto,
  AlbumQueryParams,
  UpdateAlbumDto,
  AddAlbumItemsByFilterDto,
  BulkUpdateDto,
  BulkTagsDto,
  BulkDeleteDto,
  BulkArchiveDto,
  ListArchivedParams,
  ListTrashParams,
  RestoreFromTrashDto,
  RestoreFromTrashResponse,
  DeleteForeverDto,
  EmptyTrashDto,
  GeoSearchResult,
  GeoReverseResult,
  DashboardResponse,
} from '../types/media';

// ---------------------------------------------------------------------------
// MediaItem CRUD
// ---------------------------------------------------------------------------

export async function listMedia(params?: MediaQueryParams): Promise<MediaListResponse> {
  const searchParams = new URLSearchParams();

  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.type) searchParams.set('type', params.type);
  if (params?.capturedAtFrom) searchParams.set('capturedAtFrom', params.capturedAtFrom);
  if (params?.capturedAtTo) searchParams.set('capturedAtTo', params.capturedAtTo);
  if (params?.albumId) searchParams.set('albumId', params.albumId);
  if (params?.favorite !== undefined) searchParams.set('favorite', String(params.favorite));
  if (params?.tag) searchParams.set('tag', params.tag);
  if (params?.country) searchParams.set('country', params.country);
  if (params?.region) searchParams.set('region', params.region);
  if (params?.locality) searchParams.set('locality', params.locality);
  if (params?.place) searchParams.set('place', params.place);
  if (params?.location) searchParams.set('location', params.location);
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);
  if (params?.contentHash) searchParams.set('contentHash', params.contentHash);
  if (params?.circleId) searchParams.set('circleId', params.circleId);
  if (params?.cameraMake) searchParams.set('cameraMake', params.cameraMake);
  if (params?.cameraModel) searchParams.set('cameraModel', params.cameraModel);
  if (params?.sourceDeviceId) searchParams.set('sourceDeviceId', params.sourceDeviceId);
  if (params?.sourceDeviceName) searchParams.set('sourceDeviceName', params.sourceDeviceName);
  if (params?.missingGeo !== undefined) searchParams.set('missingGeo', params.missingGeo ? '1' : '0');
  if (params?.personId) searchParams.set('personId', params.personId);
  if (params?.personIds && params.personIds.length > 0) {
    searchParams.set('personIds', params.personIds.join(','));
  }
  if (params?.peopleMatch) searchParams.set('peopleMatch', params.peopleMatch);
  if (params?.noFaces !== undefined) searchParams.set('noFaces', params.noFaces ? '1' : '0');

  const qs = searchParams.toString();
  return api.get<MediaListResponse>(`/media${qs ? `?${qs}` : ''}`);
}

export async function getMedia(id: string): Promise<MediaItem> {
  return api.get<MediaItem>(`/media/${id}`);
}

// ---------------------------------------------------------------------------
// Geo locations index (for map view)
// ---------------------------------------------------------------------------

export interface MediaLocationFilters {
  type?: 'photo' | 'video';
  country?: string;
  region?: string;
  locality?: string;
  place?: string;
  location?: string;
  capturedAtFrom?: string;
  capturedAtTo?: string;
  circleId?: string;
  /** Scope the location index to a single album. */
  albumId?: string;
  /** Viewport bounding box: `minLng,minLat,maxLng,maxLat`. */
  bbox?: string;
}

export async function listMediaLocations(
  filters?: MediaLocationFilters,
): Promise<MediaLocation[]> {
  const searchParams = new URLSearchParams();
  if (filters?.type) searchParams.set('type', filters.type);
  if (filters?.country) searchParams.set('country', filters.country);
  if (filters?.region) searchParams.set('region', filters.region);
  if (filters?.locality) searchParams.set('locality', filters.locality);
  if (filters?.place) searchParams.set('place', filters.place);
  if (filters?.location) searchParams.set('location', filters.location);
  if (filters?.capturedAtFrom) searchParams.set('capturedAtFrom', filters.capturedAtFrom);
  if (filters?.capturedAtTo) searchParams.set('capturedAtTo', filters.capturedAtTo);
  if (filters?.circleId) searchParams.set('circleId', filters.circleId);
  if (filters?.albumId) searchParams.set('albumId', filters.albumId);
  if (filters?.bbox) searchParams.set('bbox', filters.bbox);
  const qs = searchParams.toString();
  return api.get<MediaLocation[]>(`/media/locations${qs ? `?${qs}` : ''}`);
}

// ---------------------------------------------------------------------------
// Viewport-driven server-side grid clustering (map hot path — no thumbnails)
// ---------------------------------------------------------------------------

export interface MapAggregateFilters {
  circleId?: string;
  /** Grid precision (0–5); coarser at low zoom, finer at high zoom. */
  precision?: number;
  /** Viewport bounding box: `minLng,minLat,maxLng,maxLat`. */
  bbox?: string;
  type?: 'photo' | 'video';
  capturedAtFrom?: string;
  capturedAtTo?: string;
}

export async function aggregateLocations(
  filters?: MapAggregateFilters,
): Promise<MapCluster[]> {
  const searchParams = new URLSearchParams();
  if (filters?.circleId) searchParams.set('circleId', filters.circleId);
  if (filters?.precision !== undefined) searchParams.set('precision', String(filters.precision));
  if (filters?.bbox) searchParams.set('bbox', filters.bbox);
  if (filters?.type) searchParams.set('type', filters.type);
  if (filters?.capturedAtFrom) searchParams.set('capturedAtFrom', filters.capturedAtFrom);
  if (filters?.capturedAtTo) searchParams.set('capturedAtTo', filters.capturedAtTo);
  const qs = searchParams.toString();
  return api.get<MapCluster[]>(`/media/locations/aggregate${qs ? `?${qs}` : ''}`);
}

// ---------------------------------------------------------------------------
// True bounding-box extent across all a circle's geotagged items (initial
// map framing — decoupled from the viewport-driven aggregate fetch above)
// ---------------------------------------------------------------------------

export interface LocationExtentFilters {
  circleId?: string;
  type?: 'photo' | 'video';
  capturedAtFrom?: string;
  capturedAtTo?: string;
}

export async function getLocationExtent(
  filters?: LocationExtentFilters,
): Promise<LocationExtent | null> {
  const searchParams = new URLSearchParams();
  if (filters?.circleId) searchParams.set('circleId', filters.circleId);
  if (filters?.type) searchParams.set('type', filters.type);
  if (filters?.capturedAtFrom) searchParams.set('capturedAtFrom', filters.capturedAtFrom);
  if (filters?.capturedAtTo) searchParams.set('capturedAtTo', filters.capturedAtTo);
  const qs = searchParams.toString();
  return api.get<LocationExtent | null>(`/media/locations/extent${qs ? `?${qs}` : ''}`);
}

// ---------------------------------------------------------------------------
// Batched lazy thumbnail signing (for cluster drawers)
// ---------------------------------------------------------------------------

export interface ThumbnailRef {
  id: string;
  thumbnailUrl: string | null;
}

export async function getThumbnails(
  circleId: string,
  ids: string[],
): Promise<ThumbnailRef[]> {
  if (ids.length === 0) return [];
  const searchParams = new URLSearchParams();
  searchParams.set('circleId', circleId);
  searchParams.set('ids', ids.join(','));
  return api.get<ThumbnailRef[]>(`/media/thumbnails?${searchParams.toString()}`);
}

/**
 * List geotagged media locations scoped to a single album.
 * Thin wrapper over listMediaLocations that mirrors the MediaMapPage flow.
 */
export async function listAlbumLocations(
  albumId: string,
  circleId: string,
): Promise<MediaLocation[]> {
  return listMediaLocations({ albumId, circleId });
}

export async function patchMedia(id: string, dto: PatchMediaDto): Promise<MediaItem> {
  return api.patch<MediaItem>(`/media/${id}`, dto);
}

export async function deleteMedia(id: string): Promise<void> {
  await api.delete<void>(`/media/${id}`);
}

// ---------------------------------------------------------------------------
// Orientation editing (destructive rotate / flip of a photo's original bytes)
// ---------------------------------------------------------------------------

export type OrientationOp =
  | 'rotate_left'
  | 'rotate_right'
  | 'flip_horizontal'
  | 'flip_vertical';

export async function editOrientation(
  id: string,
  op: OrientationOp,
): Promise<{ status: string; width: number; height: number }> {
  return api.post<{ status: string; width: number; height: number }>(
    `/media/${id}/edit/orientation`,
    { op },
  );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function listTags(circleId?: string): Promise<TagItem[]> {
  // GET /api/media/tags returns an array of { id, name, count, createdAt }
  const qs = circleId ? `?circleId=${encodeURIComponent(circleId)}` : '';
  return api.get<TagItem[]>(`/media/tags${qs}`);
}

// ---------------------------------------------------------------------------
// Resumable upload — init / upload part / complete
// ---------------------------------------------------------------------------

export async function initUpload(dto: InitUploadDto): Promise<InitUploadResponse> {
  return api.post<InitUploadResponse>('/storage/objects/upload/init', {
    name: dto.name,
    size: dto.size,
    mimeType: dto.mimeType,
  });
}

/**
 * Upload a single part directly to the presigned S3 URL.
 * Must NOT use the `api` singleton (no auth headers, no credential cookies).
 * Returns the ETag from the response header — required for CompleteMultipartUpload.
 *
 * Throws on HTTP error so callers can implement retry logic.
 */
export async function uploadPart(presignedUrl: string, chunk: Blob): Promise<string> {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: chunk,
    // No Authorization header, no credentials — presigned URL is self-authorizing
  });

  if (!response.ok) {
    throw new Error(`Part upload failed: ${response.status} ${response.statusText}`);
  }

  // S3 returns ETag in the response header (without quotes stripped)
  const etag = response.headers.get('ETag') ?? response.headers.get('etag');
  if (!etag) {
    throw new Error('S3 did not return an ETag for the uploaded part');
  }

  return etag;
}

export async function completeUpload(
  objectId: string,
  parts: UploadPart[],
): Promise<void> {
  await api.post<void>(`/storage/objects/${objectId}/upload/complete`, { parts });
}

// ---------------------------------------------------------------------------
// Register media after upload
// ---------------------------------------------------------------------------

export async function registerMedia(dto: RegisterMediaDto): Promise<RegisterMediaResponse> {
  return api.post<RegisterMediaResponse>('/media', dto);
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

export async function listAlbums(params?: AlbumQueryParams): Promise<AlbumListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);
  if (params?.circleId) searchParams.set('circleId', params.circleId);

  const qs = searchParams.toString();
  return api.get<AlbumListResponse>(`/media/albums${qs ? `?${qs}` : ''}`);
}

export async function createAlbum(dto: CreateAlbumDto): Promise<Album> {
  return api.post<Album>('/media/albums', dto);
}

export async function getAlbum(id: string): Promise<AlbumDetail> {
  return api.get<AlbumDetail>(`/media/albums/${id}`);
}

export async function updateAlbum(id: string, dto: UpdateAlbumDto): Promise<Album> {
  return api.patch<Album>('/media/albums/' + id, dto);
}

export async function deleteAlbum(id: string): Promise<void> {
  await api.delete<void>('/media/albums/' + id);
}

export async function addAlbumItems(id: string, mediaItemIds: string[]): Promise<unknown> {
  return api.post<unknown>('/media/albums/' + id + '/items', { mediaItemIds });
}

export async function removeAlbumItem(id: string, itemId: string): Promise<void> {
  await api.delete<void>('/media/albums/' + id + '/items/' + itemId);
}

export async function addAlbumItemsByFilter(
  id: string,
  filters: AddAlbumItemsByFilterDto,
): Promise<{ added: number }> {
  return api.post<{ added: number }>('/media/albums/' + id + '/items/by-filter', filters);
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export async function bulkUpdateMedia(dto: BulkUpdateDto): Promise<{ updated: number }> {
  return api.patch<{ updated: number }>('/media/bulk', dto);
}

export async function bulkTags(dto: BulkTagsDto): Promise<{ added: number; removed: number }> {
  return api.post<{ added: number; removed: number }>('/media/bulk/tags', dto);
}

export async function bulkDelete(dto: BulkDeleteDto): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/media/bulk/delete', dto);
}

export async function bulkArchive(dto: BulkArchiveDto): Promise<{ archived: number }> {
  return api.patch<{ archived: number }>('/media/bulk/archive', dto);
}

// ---------------------------------------------------------------------------
// Bulk enrichment reruns (thumbnails / faces / AI tagging)
// ---------------------------------------------------------------------------

export interface BulkRerunDto {
  circleId: string;
  ids: string[];
}

export async function bulkRerunTags(dto: BulkRerunDto): Promise<{ queued: number }> {
  return api.post<{ queued: number }>('/media/bulk/tags/rerun', dto);
}

export async function bulkRerunFaces(dto: BulkRerunDto): Promise<{ queued: number }> {
  return api.post<{ queued: number }>('/media/bulk/faces/rerun', dto);
}

export async function bulkRerunThumbnails(dto: BulkRerunDto): Promise<{ queued: number }> {
  return api.post<{ queued: number }>('/media/bulk/thumbnail/rerun', dto);
}

export async function bulkUnarchive(dto: BulkArchiveDto): Promise<{ unarchived: number }> {
  return api.patch<{ unarchived: number }>('/media/bulk/unarchive', dto);
}

export async function listArchived(params: ListArchivedParams): Promise<MediaListResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('circleId', params.circleId);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  return api.get<MediaListResponse>(`/media/archived?${searchParams.toString()}`);
}

export async function listTrash(params: ListTrashParams): Promise<MediaListResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('circleId', params.circleId);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  return api.get<MediaListResponse>(`/media/trash?${searchParams.toString()}`);
}

export async function restoreFromTrash(dto: RestoreFromTrashDto): Promise<RestoreFromTrashResponse> {
  return api.post<RestoreFromTrashResponse>('/media/trash/restore', dto);
}

export async function deleteForever(dto: DeleteForeverDto): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/media/trash/delete-forever', dto);
}

export async function emptyTrash(dto: EmptyTrashDto): Promise<{ deleted: number }> {
  return api.post<{ deleted: number }>('/media/trash/empty', dto);
}

// ---------------------------------------------------------------------------
// Geo search / reverse geocode
// ---------------------------------------------------------------------------

export async function reverseGeocode(lat: number, lng: number): Promise<GeoReverseResult | null> {
  return api.get<GeoReverseResult | null>(`/media/geo/reverse?lat=${lat}&lng=${lng}`);
}

export async function searchPlaces(q: string, limit?: number): Promise<GeoSearchResult[]> {
  const qs = new URLSearchParams({ q });
  if (limit) qs.set('limit', String(limit));
  return api.get<GeoSearchResult[]>(`/media/geo/search?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDashboard(circleId: string): Promise<DashboardResponse> {
  return api.get<DashboardResponse>(`/media/dashboard?circleId=${encodeURIComponent(circleId)}`);
}

// ---------------------------------------------------------------------------
// Metadata export
// ---------------------------------------------------------------------------

export interface ExportFilters {
  type?: 'photo' | 'video';
  from?: string; // ISO 8601
  to?: string;   // ISO 8601
  circleId?: string;
}

/**
 * Trigger a browser download of the user's media metadata export.
 *
 * Uses a raw fetch (not the JSON-unwrapping `api.get`) because the response
 * is a streaming binary attachment, not a JSON envelope. The bearer token is
 * attached manually via `Authorization` header.
 *
 * Filename is derived from the `Content-Disposition` response header when
 * present; otherwise falls back to `memoriahub-export-<date>.<ext>`.
 */
export async function exportMedia(
  format: 'json' | 'csv',
  filters?: ExportFilters,
): Promise<void> {
  const searchParams = new URLSearchParams();
  searchParams.set('format', format);
  if (filters?.type) searchParams.set('type', filters.type);
  if (filters?.from) searchParams.set('from', filters.from);
  if (filters?.to) searchParams.set('to', filters.to);
  if (filters?.circleId) searchParams.set('circleId', filters.circleId);

  const token = api.getAccessToken();
  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`/api/media/export?${searchParams.toString()}`, {
    method: 'GET',
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    // Try to read an error body (JSON or plain text)
    const bodyText = await response.text().catch(() => '');
    let message = `Export failed: ${response.status} ${response.statusText}`;
    try {
      const bodyJson = JSON.parse(bodyText) as { message?: string };
      if (bodyJson.message) message = bodyJson.message;
    } catch {
      if (bodyText) message = bodyText;
    }
    const err = new Error(message) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  // Derive filename from Content-Disposition or fall back to a timestamped default
  const disposition = response.headers.get('Content-Disposition') ?? '';
  let filename: string;

  const filenameMatch = /filename="?([^";\r\n]+)"?/.exec(disposition);
  if (filenameMatch?.[1]) {
    filename = filenameMatch[1];
  } else {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const ext = format === 'csv' ? 'csv' : 'json';
    filename = `memoriahub-export-${dateStr}.${ext}`;
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  // Trigger browser download via a temporary anchor element
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoke after a short delay to ensure the browser has started the download
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

// ---------------------------------------------------------------------------
// Explore — places and tags (for Search/Explore page)
// ---------------------------------------------------------------------------

export interface ExploreItem {
  name: string;
  count: number;
  coverThumbnailUrl: string | null;
}

export async function getExplorePlaces(circleId: string): Promise<ExploreItem[]> {
  return api.get<ExploreItem[]>(`/media/explore/places?circleId=${encodeURIComponent(circleId)}`);
}

export async function getExploreTags(circleId: string): Promise<ExploreItem[]> {
  return api.get<ExploreItem[]>(`/media/explore/tags?circleId=${encodeURIComponent(circleId)}`);
}

// ---------------------------------------------------------------------------
// Explore — tiered locations (Countries / Regions / Cities)
// ---------------------------------------------------------------------------

export interface ExploreLocationItem {
  name: string;
  countryCode?: string | null;
  count: number;
  coverThumbnailUrl: string | null;
}

export interface ExploreLocations {
  countries: ExploreLocationItem[];
  regions: ExploreLocationItem[];
  cities: ExploreLocationItem[];
}

export async function getExploreLocations(circleId: string): Promise<ExploreLocations> {
  return api.get<ExploreLocations>(
    `/media/explore/locations?circleId=${encodeURIComponent(circleId)}`,
  );
}

export async function getExploreLocationLevel(
  circleId: string,
  level: 'countries' | 'regions' | 'cities',
): Promise<ExploreLocationItem[]> {
  return api.get<ExploreLocationItem[]>(
    `/media/explore/locations/${level}?circleId=${encodeURIComponent(circleId)}`,
  );
}

// ---------------------------------------------------------------------------
// Location facets (for SearchPanel cascading pick-lists)
// ---------------------------------------------------------------------------

export interface LocationLocality {
  name: string;
  count: number;
}

export interface LocationRegion {
  name: string;
  count: number;
  localities: LocationLocality[];
}

export interface LocationCountry {
  country: string;
  countryCode: string | null;
  count: number;
  regions: LocationRegion[];
}

export async function getLocationFacets(circleId: string): Promise<LocationCountry[]> {
  return api.get<LocationCountry[]>(`/media/facets/locations?circleId=${encodeURIComponent(circleId)}`);
}
