import { api, ApiError } from './api';

/**
 * Location Grouping management API client (epic #373, issue #375).
 *
 * Mirrors `apps/api/src/location-groups/*`. Every route is Admin-only and
 * reuses the existing `geo_settings:read` / `geo_settings:write` pair — no new
 * permission was introduced by the backend, so none is referenced here.
 *
 * The API's `{ data: … }` envelope is unwrapped by `ApiService.request`, so the
 * types below describe the INNER payload only.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the `LocationGroupLevel` Prisma enum exactly. */
export type LocationGroupLevel = 'country' | 'region' | 'locality';

export const LOCATION_GROUP_LEVELS: LocationGroupLevel[] = ['country', 'region', 'locality'];

/** `grouped` filter accepted by `GET /api/location-groups/values`. */
export type LocationValueGroupedFilter = 'all' | 'ungrouped' | 'grouped';

export interface LocationGroupSummary {
  id: string;
  level: LocationGroupLevel;
  canonicalName: string;
  /** ISO country scope. `''` is the deliberate UNSCOPED sentinel, never null. */
  countryCode: string;
  /** Number of alias rows (raw geocoder spellings) the group claims. */
  memberCount: number;
  /** Live count of media items currently resolving to this group. */
  itemCount: number;
  coverMediaItemId: string | null;
  coverThumbnailUrl: string | null;
  centerLat: number | null;
  centerLng: number | null;
  radiusKm: number | null;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationGroupAlias {
  id: string;
  rawValue: string;
  normalizedValue: string;
  countryCode: string;
  itemCount: number;
  createdAt: string;
}

export interface LocationGroupDetail extends LocationGroupSummary {
  normalizedName: string;
  aliases: LocationGroupAlias[];
}

export interface LocationGroupListResponse {
  items: LocationGroupSummary[];
  meta: { total: number; page: number; pageSize: number };
}

/** One distinct RAW geocoder value present in the library, app-wide. */
export interface LocationValue {
  value: string;
  countryCode: string | null;
  itemCount: number;
  /** The group that already claims this value, or null when unclaimed. */
  groupId: string | null;
  groupCanonicalName: string | null;
}

export interface LocationValueListResponse {
  items: LocationValue[];
  meta: { total: number; limit: number };
}

export interface LocationGroupSuggestionMember {
  value: string;
  itemCount: number;
}

export interface LocationGroupSuggestion {
  suggestedCanonicalName: string;
  countryCode: string | null;
  members: LocationGroupSuggestionMember[];
  totalItems: number;
}

export interface LocationGroupSuggestionListResponse {
  items: LocationGroupSuggestion[];
  meta: { total: number; limit: number };
}

export interface CreateLocationGroupBody {
  level: LocationGroupLevel;
  canonicalName: string;
  countryCode?: string;
  memberValues?: string[];
  coverMediaItemId?: string | null;
  center?: { lat: number; lng: number } | null;
  radiusKm?: number | null;
  enabled?: boolean;
  notes?: string | null;
}

export interface UpdateLocationGroupBody {
  canonicalName?: string;
  enabled?: boolean;
  coverMediaItemId?: string | null;
  center?: { lat: number; lng: number } | null;
  radiusKm?: number | null;
  notes?: string | null;
}

export interface RebuildLocationGroupsResult {
  jobId: string;
  status: string;
}

/** Enrichment job type enqueued by `POST /api/admin/location-groups/rebuild`. */
export const LOCATION_GROUP_REBUILD_JOB_TYPE = 'location_group_rebuild';

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export async function listLocationGroups(params: {
  level?: LocationGroupLevel;
  enabled?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<LocationGroupListResponse> {
  const qs = new URLSearchParams();
  if (params.level) qs.set('level', params.level);
  if (params.enabled !== undefined) qs.set('enabled', String(params.enabled));
  // `q` has a min-length of 1 server-side; never send an empty string.
  if (params.q && params.q.trim()) qs.set('q', params.q.trim());
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));

  const query = qs.toString();
  return api.get<LocationGroupListResponse>(`/location-groups${query ? `?${query}` : ''}`);
}

export async function getLocationGroup(id: string): Promise<LocationGroupDetail> {
  return api.get<LocationGroupDetail>(`/location-groups/${id}`);
}

export async function createLocationGroup(
  body: CreateLocationGroupBody,
): Promise<LocationGroupDetail> {
  return api.post<LocationGroupDetail>('/location-groups', body);
}

export async function updateLocationGroup(
  id: string,
  body: UpdateLocationGroupBody,
): Promise<LocationGroupDetail> {
  return api.patch<LocationGroupDetail>(`/location-groups/${id}`, body);
}

export async function deleteLocationGroup(id: string): Promise<void> {
  await api.delete<void>(`/location-groups/${id}`);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function addLocationGroupMembers(
  id: string,
  values: string[],
): Promise<{ added: number }> {
  return api.post<{ added: number }>(`/location-groups/${id}/members`, { values });
}

/**
 * `DELETE` with a body — the API route takes the same `{ values }` payload as
 * the `POST` counterpart, so the body rides on the RequestInit passthrough.
 */
export async function removeLocationGroupMembers(
  id: string,
  values: string[],
): Promise<{ removed: number }> {
  return api.delete<{ removed: number }>(`/location-groups/${id}/members`, {
    body: JSON.stringify({ values }),
  });
}

// ---------------------------------------------------------------------------
// Values + suggestions
// ---------------------------------------------------------------------------

export async function listLocationValues(params: {
  level: LocationGroupLevel;
  q?: string;
  grouped?: LocationValueGroupedFilter;
  limit?: number;
}): Promise<LocationValueListResponse> {
  const qs = new URLSearchParams();
  qs.set('level', params.level);
  if (params.q && params.q.trim()) qs.set('q', params.q.trim());
  if (params.grouped) qs.set('grouped', params.grouped);
  if (params.limit != null) qs.set('limit', String(params.limit));

  return api.get<LocationValueListResponse>(`/location-groups/values?${qs.toString()}`);
}

export async function listLocationGroupSuggestions(params: {
  level: LocationGroupLevel;
  limit?: number;
}): Promise<LocationGroupSuggestionListResponse> {
  const qs = new URLSearchParams();
  qs.set('level', params.level);
  if (params.limit != null) qs.set('limit', String(params.limit));

  return api.get<LocationGroupSuggestionListResponse>(
    `/location-groups/suggestions?${qs.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

export async function rebuildLocationGroups(body?: {
  circleId?: string;
  groupIds?: string[];
}): Promise<RebuildLocationGroupsResult> {
  return api.post<RebuildLocationGroupsResult>('/admin/location-groups/rebuild', body ?? {});
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export interface LocationGroupConflict {
  message: string;
  groupId: string | null;
  groupName: string | null;
}

/**
 * Unpack a `409 LOCATION_GROUP_MEMBER_CONFLICT`.
 *
 * ⚠️ The owning group is read from **`details.groupName`**, never a top-level
 * `groupName`. The API's `HttpExceptionFilter` rebuilds every error body from a
 * fixed key allowlist (`message`, `code`, `details`, …), so a top-level custom
 * field is silently dropped before the client ever sees it — reading one here
 * would always yield `undefined`. See the 409 gotcha in CLAUDE.md.
 */
export function extractLocationGroupConflict(err: unknown): LocationGroupConflict | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;

  const details = err.details as
    | { groupId?: unknown; groupName?: unknown }
    | null
    | undefined;

  return {
    message: err.message,
    groupId: typeof details?.groupId === 'string' ? details.groupId : null,
    groupName: typeof details?.groupName === 'string' ? details.groupName : null,
  };
}

/**
 * Human-readable message for any location-group failure, naming the owning
 * group when the API reported a member conflict.
 */
export function locationGroupErrorMessage(err: unknown, fallback = 'Request failed'): string {
  const conflict = extractLocationGroupConflict(err);
  if (conflict) {
    return conflict.groupName
      ? `Already in group "${conflict.groupName}" — ${conflict.message}`
      : conflict.message;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
