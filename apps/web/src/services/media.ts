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

// ---------------------------------------------------------------------------
// Metadata export
// ---------------------------------------------------------------------------

export interface ExportFilters {
  type?: 'photo' | 'video';
  from?: string; // ISO 8601
  to?: string;   // ISO 8601
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
