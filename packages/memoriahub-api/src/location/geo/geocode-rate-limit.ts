import { MemoriahubRateLimitError } from '../../ports/index.js';
import { classifyMediaRateLimit } from '../../media/index.js';

/**
 * The throttle bucket every geocoding provider call draws on (the geocoder's quota: a cooldown on one
 * `geocode` job holds the others).
 *
 * @stability experimental
 */
export const GEOCODE_THROTTLE_KEY = 'geocode';

/**
 * Classifies a thrown value as a geocoding rate limit, or `null` when it is not one. A provider quota
 * signal arrives as a {@link MemoriahubRateLimitError} already; a raw HTTP 429/529 or AWS throttle shape
 * is rebuilt on the geocoding bucket (never the media bucket) so the queue holds only geocoding back.
 *
 * @param error - the thrown value.
 * @returns the rate-limit error, or `null`.
 * @stability experimental
 */
export function classifyGeocodeRateLimit(error: unknown): MemoriahubRateLimitError | null {
  if (error instanceof MemoriahubRateLimitError) return error;
  const other = classifyMediaRateLimit(error);
  return other ? new MemoriahubRateLimitError(GEOCODE_THROTTLE_KEY, other.retryAfterMs, other.message) : null;
}
