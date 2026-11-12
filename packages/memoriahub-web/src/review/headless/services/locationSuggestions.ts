import type { LocationSuggestionQuery } from '@marinoscar/memoriahub-contract/location';
import { api } from '../../../core/headless/index.js';
import type { SortOrder } from '../../../media/headless/index.js';

/**
 * The status of a location suggestion (pending, accepted, rejected, auto-applied or reverted).
 *
 * @stability experimental
 */
export type LocationSuggestionStatus = LocationSuggestionQuery['status'];
/**
 * How a suggestion was inferred: interpolated between two anchors or taken from the nearest one.
 *
 * @stability experimental
 */
export type LocationSuggestionMethod = 'interpolated' | 'nearest';

/**
 * Sortable columns accepted by `GET /media/location-suggestions`
 * (server default: `createdAt`).
 *
 * @stability experimental
 */
export type LocationSuggestionSortBy = LocationSuggestionQuery['sortBy'];

/**
 * One location suggestion: the guessed coordinates, confidence, method, anchors and thumbnail.
 *
 * @stability experimental
 */
export interface LocationSuggestionSummary {
  id: string;
  mediaItemId: string;
  status: LocationSuggestionStatus;
  lat: number;
  lng: number;
  confidence: number;
  method: LocationSuggestionMethod;
  anchorBeforeId: string | null;
  anchorAfterId: string | null;
  gapBeforeSeconds: number | null;
  gapAfterSeconds: number | null;
  anchorDistanceKm: number | null;
  impliedSpeedKmh: number | null;
  capturedAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  thumbnailUrl: string | null;
}

/**
 * The pagination envelope of a suggestion listing.
 *
 * @stability experimental
 */
export interface LocationSuggestionListMeta {
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One page of location suggestions.
 *
 * @stability experimental
 */
export interface LocationSuggestionListResponse {
  items: LocationSuggestionSummary[];
  meta: LocationSuggestionListMeta;
}

/**
 * The outcome of accepting a suggestion.
 *
 * @stability experimental
 */
export interface AcceptLocationSuggestionResult {
  id: string;
  status: string;
  lat: number;
  lng: number;
  coordSource: string;
}

/**
 * The outcome of rejecting or reverting a suggestion.
 *
 * @stability experimental
 */
export interface RejectRevertResult {
  id: string;
  status: string;
}

/**
 * The job a location inference re-run enqueued.
 *
 * @stability experimental
 */
export interface InferLocationResult {
  jobId: string;
  status: string;
}

/**
 * Lists a circle's location suggestions, filtered and sorted (media:read).
 *
 * @stability experimental
 */
export async function listLocationSuggestions(params: {
  circleId: string;
  mediaItemId?: string;
  status?: LocationSuggestionStatus;
  page?: number;
  pageSize?: number;
  sortBy?: LocationSuggestionSortBy;
  sortOrder?: SortOrder;
}): Promise<LocationSuggestionListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.mediaItemId) p.set('mediaItemId', params.mediaItemId);
  if (params.status) p.set('status', params.status);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  if (params.sortBy) p.set('sortBy', params.sortBy);
  if (params.sortOrder) p.set('sortOrder', params.sortOrder);
  const result = await api.get<LocationSuggestionListResponse>(`/media/location-suggestions?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

/**
 * Accepts a pending suggestion, optionally with adjusted coordinates (media:write).
 *
 * @stability experimental
 */
export async function acceptLocationSuggestion(
  id: string,
  lat?: number,
  lng?: number,
): Promise<AcceptLocationSuggestionResult> {
  const body: { lat?: number; lng?: number } = {};
  if (lat !== undefined) body.lat = lat;
  if (lng !== undefined) body.lng = lng;
  return api.post<AcceptLocationSuggestionResult>(`/media/location-suggestions/${id}/accept`, body);
}

/**
 * Rejects a pending suggestion (media:write).
 *
 * @stability experimental
 */
export async function rejectLocationSuggestion(id: string): Promise<RejectRevertResult> {
  return api.post<RejectRevertResult>(`/media/location-suggestions/${id}/reject`);
}

/**
 * Undoes an auto-applied suggestion (media:write).
 *
 * @stability experimental
 */
export async function revertLocationSuggestion(id: string): Promise<RejectRevertResult> {
  return api.post<RejectRevertResult>(`/media/location-suggestions/${id}/revert`);
}

/**
 * Forces a fresh location inference for one item (media:write).
 *
 * @stability experimental
 */
export async function inferLocation(mediaItemId: string): Promise<InferLocationResult> {
  return api.post<InferLocationResult>(`/media/${mediaItemId}/infer-location`);
}
