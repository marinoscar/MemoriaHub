/**
 * node/compute/geocode.ts — Reverse-geocoding compute.
 *
 * Pure DB + network work — reads stored takenLat/takenLng (no image
 * download; `inputPath` is unused). Fetches TRANSIENT, per-job credentials
 * via `POST /api/nodes/:id/jobs/:jobId/credentials` (see
 * node/compute/auto-tagging.ts's header for the full design rationale — the
 * "AI-proxy" pattern in docs/specs/distributed-nodes.md was rejected for this
 * job type too) and calls the active reverse-geocode provider's HTTP API
 * directly via the shared @memoriahub/enrichment-compute/geo helpers, so a
 * node and the server produce byte-identical geo columns from the same raw
 * response.
 *
 * The 'offline' provider (server-side GeoNames dataset) has no node-side
 * equivalent — a job routed to it declines with CapabilityUnavailableError
 * and stays server-only.
 *
 * RATE LIMITS: fetchNominatim/fetchGoogleReverse already throw
 * `GeoProviderRateLimitError` (package `/geo`) on a 429/5xx/quota-exhaustion
 * throttle, which extends the shared `ProviderRateLimitError` (package
 * `/rate-limit`) — no local translation needed here. It propagates unchanged
 * up through this compute function to node-engine.ts's processJob catch
 * block, which detects `err instanceof ProviderRateLimitError` and forwards
 * `{ rateLimited: true, retryAfterMs }` to the server's failure endpoint so
 * the job backs off instead of burning through ENRICHMENT_MAX_ATTEMPTS.
 */

import {
  fetchNominatim,
  fetchGoogleReverse,
  mapNominatimResponse,
  mapGoogleResponse,
} from '@memoriahub/enrichment-compute/geo';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';
import { ApiClient } from '../../api.js';
import { loadConfig } from '../../config.js';

interface GeocodeComputeResult {
  country: string | null;
  countryCode: string | null;
  admin1: string | null;
  admin2: string | null;
  locality: string | null;
  placeName: string | null;
  source: string;
}

const NOMINATIM_DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';

const computeGeocode: ComputeFn = async (_inputPath, _params, ctx): Promise<GeocodeComputeResult> => {
  if (!ctx) {
    throw new Error(
      'job context not provided — geocode compute requires { nodeId, jobId } to fetch transient credentials',
    );
  }

  const config = loadConfig();
  if (!config) {
    throw new Error('not logged in — no CLI config found (run `memoriahub login`)');
  }
  const client = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

  const creds = await client.getJobCredentials(ctx.nodeId, ctx.jobId);
  if (creds.type !== 'geocode') {
    throw new Error(`unexpected credentials type "${creds.type}" for geocode job`);
  }

  if (creds.provider === 'offline') {
    throw new CapabilityUnavailableError(
      'offline geocoding requires the server-side GeoNames dataset — not available on nodes',
      'geocode',
    );
  }

  if (creds.provider === 'nominatim') {
    const baseUrl = creds.baseUrl ?? NOMINATIM_DEFAULT_BASE_URL;
    const raw = await fetchNominatim(baseUrl, creds.lat, creds.lng);
    const mapped = mapNominatimResponse(raw);
    return {
      country: mapped?.country ?? null,
      countryCode: mapped?.countryCode ?? null,
      admin1: mapped?.admin1 ?? null,
      admin2: mapped?.admin2 ?? null,
      locality: mapped?.locality ?? null,
      placeName: mapped?.placeName ?? null,
      source: 'nominatim',
    };
  }

  if (creds.provider === 'google') {
    if (!creds.apiKey) {
      throw new Error('google geocode credentials missing apiKey');
    }
    const raw = await fetchGoogleReverse(creds.apiKey, creds.lat, creds.lng);
    const mapped = mapGoogleResponse(raw);
    return {
      country: mapped?.country ?? null,
      countryCode: mapped?.countryCode ?? null,
      admin1: mapped?.admin1 ?? null,
      admin2: mapped?.admin2 ?? null,
      locality: mapped?.locality ?? null,
      placeName: mapped?.placeName ?? null,
      source: 'google',
    };
  }

  throw new CapabilityUnavailableError(
    `geocode provider "${(creds as { provider: string }).provider}" not supported on nodes`,
    'geocode',
  );
};

export default computeGeocode;
