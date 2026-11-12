import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The reverse-geocoding providers: `offline`, `nominatim` or `google`.
 *
 * @stability experimental
 */
export type GeoReverseProvider = 'offline' | 'nominatim' | 'google';

/**
 * One geo provider as the settings page lists it (the key is never included, only its last four characters).
 *
 * @stability experimental
 */
export interface GeoProvider {
  provider: string;
  configured: boolean;
  enabled: boolean;
  last4: string | null;
  baseUrl: string | null;
}

/**
 * The geo settings document: the providers and the active reverse provider.
 *
 * @stability experimental
 */
export interface GeoSettingsResponse {
  providers: GeoProvider[];
  activeReverseProvider: GeoReverseProvider;
}

/**
 * The outcome of a geo provider connectivity test.
 *
 * @stability experimental
 */
export interface GeoTestResult {
  ok: boolean;
  sample?: {
    country?: string;
    locality?: string;
    placeName?: string;
  };
  error?: string;
}

/**
 * The outcome of a global geocode backfill.
 *
 * @stability experimental
 */
export interface GeoBackfillResult {
  enqueued: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Reads the geo provider settings: the configured providers (masked) and the active reverse provider.
 *
 * @returns the settings document
 *
 * @stability experimental
 */
export async function getGeoSettings(): Promise<GeoSettingsResponse> {
  return api.get<GeoSettingsResponse>('/geo/settings');
}

/**
 * Stores a geo provider credential, encrypted at rest.
 *
 * @param provider - the provider id (`google`)
 * @param body - the key, an optional base URL and the enabled flag
 *
 * @stability experimental
 */
export async function putGeoCredentials(
  provider: string,
  body: { apiKey: string; baseUrl?: string; enabled?: boolean },
): Promise<void> {
  await api.put<void>(`/geo/credentials/${provider}`, body);
}

/**
 * Removes a geo provider credential.
 *
 * @param provider - the provider id
 *
 * @stability experimental
 */
export async function deleteGeoCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/geo/credentials/${provider}`);
}

/**
 * Tests a geo provider's connectivity with one reverse lookup.
 *
 * @param body - the provider and optional coordinates
 * @returns the outcome of the lookup
 *
 * @stability experimental
 */
export async function testGeoProvider(body: {
  provider: GeoReverseProvider;
  lat?: number;
  lng?: number;
}): Promise<GeoTestResult> {
  return api.post<GeoTestResult>('/geo/test', body);
}

/**
 * Chooses the active reverse-geocoding provider.
 *
 * @param body - the provider to switch to (`offline`, `nominatim` or `google`)
 *
 * @stability experimental
 */
export async function putGeoReverseFeature(body: {
  provider: GeoReverseProvider;
}): Promise<void> {
  await api.put<void>('/geo/features/reverse', body);
}

/**
 * Enqueues geocoding for every item with coordinates across all circles (admin only).
 *
 * @param body - optional capture-date bounds and `force`
 * @returns the number of jobs enqueued
 *
 * @stability experimental
 */
export async function runGeoBackfill(body: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<GeoBackfillResult> {
  return api.post<GeoBackfillResult>('/admin/geocode/backfill', body);
}
