import { api } from './api';
import type {
  MediaItem,
  MediaListResponse,
  MediaQueryParams,
  PatchMediaDto,
  RegisterMediaDto,
  TagItem,
  InitUploadDto,
  InitUploadResponse,
  UploadPart,
  Album,
  AlbumListResponse,
  AlbumDetail,
  CreateAlbumDto,
  AlbumQueryParams,
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
  if (params?.classification) searchParams.set('classification', params.classification);
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

  const qs = searchParams.toString();
  return api.get<MediaListResponse>(`/media${qs ? `?${qs}` : ''}`);
}

export async function getMedia(id: string): Promise<MediaItem> {
  return api.get<MediaItem>(`/media/${id}`);
}

export async function patchMedia(id: string, dto: PatchMediaDto): Promise<MediaItem> {
  return api.patch<MediaItem>(`/media/${id}`, dto);
}

export async function deleteMedia(id: string): Promise<void> {
  await api.delete<void>(`/media/${id}`);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function listTags(): Promise<TagItem[]> {
  // GET /api/media/tags returns an array of { id, name, count, createdAt }
  return api.get<TagItem[]>('/media/tags');
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

export async function registerMedia(dto: RegisterMediaDto): Promise<MediaItem> {
  return api.post<MediaItem>('/media', dto);
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

  const qs = searchParams.toString();
  return api.get<AlbumListResponse>(`/media/albums${qs ? `?${qs}` : ''}`);
}

export async function createAlbum(dto: CreateAlbumDto): Promise<Album> {
  return api.post<Album>('/media/albums', dto);
}

export async function getAlbum(id: string): Promise<AlbumDetail> {
  return api.get<AlbumDetail>(`/media/albums/${id}`);
}
