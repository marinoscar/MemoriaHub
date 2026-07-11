/**
 * Shared geo response-mapping primitives — extracted from
 * apps/api/src/media/geo/{nominatim,google}-geo-location.provider.ts.
 *
 * Only the RAW-PROVIDER-JSON → typed-result mapping is shared here (the pure,
 * side-effect-free part). Server-side rate-limit detection (RateLimitError,
 * which requires the enrichment module) and the offline GeoNames dataset stay
 * server-only — see docs/specs/distributed-nodes.md (stale on the "AI-proxy"
 * point; the mandated design for this pass is a distributed worker node
 * fetching TRANSIENT provider credentials per-job and calling the provider's
 * HTTP API directly — see `POST /api/nodes/:id/jobs/:jobId/credentials`).
 *
 * mapNominatimResponse / mapGoogleResponse are used by BOTH the server
 * providers (thin delegates) and the CLI node compute module so a node and
 * the server produce byte-identical `GeoLocationResult`-shaped values from
 * the same raw provider response.
 */

// ---------------------------------------------------------------------------
// Mapped result shape — structurally identical to
// apps/api/src/media/geo/geo-location-provider.interface.ts's GeoLocationResult
// ---------------------------------------------------------------------------

export interface GeoMappedResult {
  /** Human-readable country name, e.g. "Costa Rica" */
  country?: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "CR" */
  countryCode?: string;
  /** State / province / region, e.g. "Alajuela" */
  admin1?: string;
  /** County / canton (optional second tier), e.g. "San Carlos" */
  admin2?: string;
  /** City / town, e.g. "La Fortuna" */
  locality?: string;
  /** POI / landmark / display label */
  placeName?: string;
}

// ---------------------------------------------------------------------------
// Nominatim
// ---------------------------------------------------------------------------

interface NominatimAddress {
  country?: string;
  country_code?: string;
  state?: string;
  county?: string;
  city?: string;
  town?: string;
  village?: string;
  neighbourhood?: string;
  suburb?: string;
}

interface NominatimResponse {
  address?: NominatimAddress;
  display_name?: string;
}

/**
 * Maps a raw Nominatim `/reverse` JSON response to GeoMappedResult.
 * Returns null when the response has no `address` block (no match).
 */
export function mapNominatimResponse(json: unknown): GeoMappedResult | null {
  const data = json as NominatimResponse | null | undefined;
  if (!data?.address) return null;

  const addr = data.address;
  const locality = addr.city ?? addr.town ?? addr.village ?? addr.neighbourhood ?? addr.suburb;

  return {
    country: addr.country,
    countryCode: addr.country_code?.toUpperCase(),
    admin1: addr.state,
    admin2: addr.county,
    locality,
    placeName: data.display_name,
  };
}

/**
 * Plain-fetch Nominatim `/reverse` call (no SDK). Callers are responsible for
 * rate-limit / error-status handling appropriate to their environment (the
 * API's NominatimGeoLocationProvider throws a server-specific RateLimitError
 * on HTTP 429/5xx; a node caller should treat those statuses as retryable
 * too, but has no dependency on the server's error-class hierarchy).
 */
export async function fetchNominatim(baseUrl: string, lat: number, lng: number): Promise<unknown> {
  const url = `${baseUrl}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
  const response = await fetch(url, {
    headers: {
      // OSM policy requires a valid User-Agent identifying the application.
      'User-Agent': 'MemoriaHub-Node/1.0 (https://github.com/memoriaHub)',
      'Accept-Language': 'en',
    },
  });

  if (response.status === 429 || response.status >= 500) {
    throw new GeoProviderRateLimitError(`Nominatim throttled (HTTP ${response.status})`, 'nominatim');
  }
  if (!response.ok) {
    throw new Error(`Nominatim returned HTTP ${response.status}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Google Geocoding API
// ---------------------------------------------------------------------------

interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GoogleGeocodeResponse {
  status: string;
  results: Array<{
    address_components: GoogleAddressComponent[];
    formatted_address: string;
  }>;
  error_message?: string;
}

/**
 * Maps a raw Google Geocoding API JSON response to GeoMappedResult.
 * Returns null for ZERO_RESULTS / non-OK status / no results — callers that
 * need to distinguish quota-exhaustion (OVER_QUERY_LIMIT/RESOURCE_EXHAUSTED)
 * as a retryable condition must check `status` themselves BEFORE calling this
 * (see the API's GoogleGeoLocationProvider, which does this check first).
 */
export function mapGoogleResponse(json: unknown): GeoMappedResult | null {
  const data = json as GoogleGeocodeResponse | null | undefined;
  if (!data || data.status !== 'OK') return null;

  const first = data.results?.[0];
  if (!first) return null;

  const components = first.address_components;
  const get = (type: string, name: 'long_name' | 'short_name') =>
    components.find((c) => c.types.includes(type))?.[name];

  return {
    country: get('country', 'long_name'),
    countryCode: get('country', 'short_name'),
    admin1: get('administrative_area_level_1', 'long_name'),
    admin2: get('administrative_area_level_2', 'long_name'),
    locality: get('locality', 'long_name') ?? get('postal_town', 'long_name'),
    placeName: first.formatted_address,
  };
}

/** Plain-fetch Google Geocoding API reverse call (no SDK). */
export async function fetchGoogleReverse(apiKey: string, lat: number, lng: number): Promise<unknown> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
  const response = await fetch(url);

  if (response.status === 429 || response.status >= 500) {
    throw new GeoProviderRateLimitError(`Google Geocoding API returned HTTP ${response.status}`, 'google');
  }

  const data = (await response.json()) as GoogleGeocodeResponse;

  if (data.status === 'OVER_QUERY_LIMIT' || data.status === 'RESOURCE_EXHAUSTED') {
    throw new GeoProviderRateLimitError(`Google Geocoding quota exceeded (${data.status})`, 'google');
  }

  return data;
}

// ---------------------------------------------------------------------------
// Rate-limit signal
// ---------------------------------------------------------------------------

/**
 * Thrown by fetchNominatim/fetchGoogleReverse on a provider throttle/overload
 * signal (HTTP 429/5xx, or Google's OVER_QUERY_LIMIT/RESOURCE_EXHAUSTED
 * status). Framework-agnostic (this package has no NestJS dependency) — a
 * caller that wants server-style rate-limit-deferral semantics (e.g.
 * apps/api's RateLimitError) should catch this and re-wrap it.
 */
export class GeoProviderRateLimitError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(message);
    this.name = 'GeoProviderRateLimitError';
  }
}
