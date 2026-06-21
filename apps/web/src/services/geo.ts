import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeoReverseProvider = 'offline' | 'nominatim' | 'google';

export interface GeoProvider {
  provider: string;
  configured: boolean;
  enabled: boolean;
  last4: string | null;
  baseUrl: string | null;
}

export interface GeoSettingsResponse {
  providers: GeoProvider[];
  activeReverseProvider: GeoReverseProvider;
}

export interface GeoTestResult {
  ok: boolean;
  sample?: {
    country?: string;
    locality?: string;
    placeName?: string;
  };
  error?: string;
}

export interface GeoBackfillResult {
  enqueued: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getGeoSettings(): Promise<GeoSettingsResponse> {
  return api.get<GeoSettingsResponse>('/geo/settings');
}

export async function putGeoCredentials(
  provider: string,
  body: { apiKey: string; baseUrl?: string; enabled?: boolean },
): Promise<void> {
  await api.put<void>(`/geo/credentials/${provider}`, body);
}

export async function deleteGeoCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/geo/credentials/${provider}`);
}

export async function testGeoProvider(body: {
  provider: GeoReverseProvider;
  lat?: number;
  lng?: number;
}): Promise<GeoTestResult> {
  return api.post<GeoTestResult>('/geo/test', body);
}

export async function putGeoReverseFeature(body: {
  provider: GeoReverseProvider;
}): Promise<void> {
  await api.put<void>('/geo/features/reverse', body);
}

export async function runGeoBackfill(body: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GeoBackfillResult> {
  return api.post<GeoBackfillResult>('/admin/geocode/backfill', body);
}
