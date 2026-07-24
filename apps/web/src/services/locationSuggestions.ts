import { api } from './api';

export type LocationSuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'auto_applied' | 'reverted';
export type LocationSuggestionMethod = 'interpolated' | 'nearest';

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

export interface LocationSuggestionListMeta {
  total: number;
  page: number;
  pageSize: number;
}

export interface LocationSuggestionListResponse {
  items: LocationSuggestionSummary[];
  meta: LocationSuggestionListMeta;
}

export interface AcceptLocationSuggestionResult {
  id: string;
  status: string;
  lat: number;
  lng: number;
  coordSource: string;
}

export interface RejectRevertResult {
  id: string;
  status: string;
}

export interface InferLocationResult {
  jobId: string;
  status: string;
}

export async function listLocationSuggestions(params: {
  circleId: string;
  mediaItemId?: string;
  status?: LocationSuggestionStatus;
  page?: number;
  pageSize?: number;
}): Promise<LocationSuggestionListResponse> {
  const p = new URLSearchParams({ circleId: params.circleId });
  if (params.mediaItemId) p.set('mediaItemId', params.mediaItemId);
  if (params.status) p.set('status', params.status);
  if (params.page) p.set('page', String(params.page));
  if (params.pageSize) p.set('pageSize', String(params.pageSize));
  const result = await api.get<LocationSuggestionListResponse>(`/media/location-suggestions?${p.toString()}`);
  return { items: result.items ?? [], meta: result.meta };
}

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

export async function rejectLocationSuggestion(id: string): Promise<RejectRevertResult> {
  return api.post<RejectRevertResult>(`/media/location-suggestions/${id}/reject`);
}

export async function revertLocationSuggestion(id: string): Promise<RejectRevertResult> {
  return api.post<RejectRevertResult>(`/media/location-suggestions/${id}/revert`);
}

export async function inferLocation(mediaItemId: string): Promise<InferLocationResult> {
  return api.post<InferLocationResult>(`/media/${mediaItemId}/infer-location`);
}
