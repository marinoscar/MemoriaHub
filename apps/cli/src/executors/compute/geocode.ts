/**
 * executors/compute/geocode.ts - Reverse-geocoding compute.
 *
 * The job payload carries the item's coordinates (`lat`, `lng`; the API adds them when it enqueues
 * a geocode job) and no media bytes are read. The provider is Google, the only one a node is
 * offered the job for: the key arrives through the platform's per-job secret
 * (`context.api.jobSecret`, `POST /api/nodes/:id/jobs/:jobId/secret`, off by default on the server)
 * and lives in a local variable for this one call. It is never written to disk, the environment, argv or a log.
 * Nominatim needs no key, so a payload that names it (`provider: 'nominatim'`) is run without a secret.
 *
 * RATE LIMITS: `fetchNominatim` / `fetchGoogleReverse` throw `GeoProviderRateLimitError`, which
 * extends the shared `ProviderRateLimitError`; the executor converts it to the platform's class, so
 * the job is deferred server-side without consuming an attempt.
 */

import {
  fetchNominatim,
  fetchGoogleReverse,
  mapNominatimResponse,
  mapGoogleResponse,
} from '@memoriahub/enrichment-compute/geo';
import { CapabilityUnavailableError, runPhase, type ComputeFn } from '../support.js';

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

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const computeGeocode: ComputeFn = async (_inputPath, params, ctx): Promise<GeocodeComputeResult> => {
  const lat = finite(params['lat']);
  const lng = finite(params['lng']);
  if (lat === undefined || lng === undefined) {
    throw new CapabilityUnavailableError(
      'geocode job payload has no coordinates (lat, lng): the API adds them at enqueue; an older job row is run by the server',
      'geocode',
    );
  }

  if (params['provider'] === 'nominatim') {
    const baseUrl = typeof params['baseUrl'] === 'string' ? params['baseUrl'] : NOMINATIM_DEFAULT_BASE_URL;
    const raw = await runPhase(ctx, 'job.app.geocode', () => fetchNominatim(baseUrl, lat, lng), {
      geoProvider: 'nominatim',
    });
    return shape(mapNominatimResponse(raw), 'nominatim');
  }

  // Google: the key is a per-job secret held in this local only.
  const secret = await ctx.api.jobSecret(ctx.nodeId, ctx.jobId, ctx.claimToken);
  const apiKey = secret.material['apiKey'];
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new Error(`the ${secret.kind} secret carries no apiKey`);
  }
  const raw = await runPhase(ctx, 'job.app.geocode', () => fetchGoogleReverse(apiKey, lat, lng), {
    geoProvider: 'google',
  });
  return shape(mapGoogleResponse(raw), 'google');
};

function shape(
  mapped:
    | {
        country?: string | null;
        countryCode?: string | null;
        admin1?: string | null;
        admin2?: string | null;
        locality?: string | null;
        placeName?: string | null;
      }
    | null
    | undefined,
  source: string,
): GeocodeComputeResult {
  return {
    country: mapped?.country ?? null,
    countryCode: mapped?.countryCode ?? null,
    admin1: mapped?.admin1 ?? null,
    admin2: mapped?.admin2 ?? null,
    locality: mapped?.locality ?? null,
    placeName: mapped?.placeName ?? null,
    source,
  };
}

export default computeGeocode;
