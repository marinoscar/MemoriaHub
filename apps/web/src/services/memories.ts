import { api } from './api';
import type {
  MemoryDetail,
  MemoryFeedResponse,
  MemoryListParams,
  MemoryListResponse,
  SaveMemoryAlbumResult,
} from '../types/memories';

// ---------------------------------------------------------------------------
// Memories API client (epic #300, API in issue #307)
//
// Follows `services/media.ts`: one exported function per endpoint, query
// strings assembled with URLSearchParams, and keyset pagination expressed as an
// opaque `cursor` the caller carries forward from `meta.nextCursor`.
//
// Every mutation below is a 204 on the wire; `api.request` already returns
// `undefined` for 204, so these resolve to `void` and callers only have to
// handle the throw path.
// ---------------------------------------------------------------------------

/**
 * `GET /api/memories` — keyset page of a circle's memories, newest first.
 *
 * Returns an EMPTY page rather than an error when `features.memories` is off,
 * so a caller never has to special-case the disabled state (it should still not
 * fire the request at all — see `useMemories`' `enabled` flag).
 */
export async function listMemories(
  params: MemoryListParams,
): Promise<MemoryListResponse> {
  const search = new URLSearchParams();
  search.set('circleId', params.circleId);
  if (params.type) search.set('type', params.type);
  if (params.year !== undefined) search.set('year', String(params.year));
  // Only ever sent when narrowing to favorites: the server treats any value
  // other than the literal 'true' as "no filter", so sending `false` would be
  // an indistinguishable no-op that only makes the URL noisier.
  if (params.favorite) search.set('favorite', 'true');
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.pageSize) search.set('pageSize', String(params.pageSize));

  return api.get<MemoryListResponse>(`/memories?${search.toString()}`);
}

/**
 * `GET /api/memories/feed` — the Home carousel payload (max 10 cards).
 *
 * Ordered by the server: today's On This Day memories first (closest year
 * first), then newest unseen, then newest seen. Each card carries up to four
 * item thumbnails for the fan effect.
 */
export async function getMemoriesFeed(
  circleId: string,
): Promise<MemoryFeedResponse> {
  return api.get<MemoryFeedResponse>(
    `/memories/feed?circleId=${encodeURIComponent(circleId)}`,
  );
}

/** `GET /api/memories/:id` — full detail with the ordered item list. */
export async function getMemory(id: string): Promise<MemoryDetail> {
  return api.get<MemoryDetail>(`/memories/${id}`);
}

/**
 * `POST /api/memories/:id/seen` — idempotent; `seenAt` is preserved once set,
 * so it always names the FIRST view.
 */
export async function markMemorySeen(id: string): Promise<void> {
  await api.post<void>(`/memories/${id}/seen`);
}

/** `POST /api/memories/:id/hide` — personal and reversible. Not a delete. */
export async function hideMemory(id: string): Promise<void> {
  await api.post<void>(`/memories/${id}/hide`);
}

/** `DELETE /api/memories/:id/hide` — un-hide for the current user. */
export async function unhideMemory(id: string): Promise<void> {
  await api.delete<void>(`/memories/${id}/hide`);
}

/** `POST /api/memories/:id/favorite` */
export async function favoriteMemory(id: string): Promise<void> {
  await api.post<void>(`/memories/${id}/favorite`);
}

/** `DELETE /api/memories/:id/favorite` */
export async function unfavoriteMemory(id: string): Promise<void> {
  await api.delete<void>(`/memories/${id}/favorite`);
}

/**
 * `DELETE /api/memories/:id` — circle-level TOMBSTONE.
 *
 * The memory disappears for every member of the circle and can never be
 * regenerated: the natural-key unique index spans tombstoned rows, so curation
 * recognises and skips it forever. This is not reversible — per-user
 * {@link hideMemory} is the soft alternative, and the confirm dialog must say
 * so. Requires `media:write` + the collaborator circle role.
 */
export async function deleteMemory(id: string): Promise<void> {
  await api.delete<void>(`/memories/${id}`);
}

/**
 * `POST /api/memories/:id/save-album` — copy the memory's live items into a new
 * album. Deliberately NOT idempotent server-side: saving twice yields two
 * albums. The full save-as-album UI belongs to issue #313.
 */
export async function saveMemoryAsAlbum(
  id: string,
  name?: string,
): Promise<SaveMemoryAlbumResult> {
  return api.post<SaveMemoryAlbumResult>(
    `/memories/${id}/save-album`,
    name ? { name } : {},
  );
}
