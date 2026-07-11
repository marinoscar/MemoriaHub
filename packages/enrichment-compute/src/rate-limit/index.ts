/**
 * Shared provider rate-limit signal — the framework-agnostic counterpart to
 * apps/api/src/enrichment/rate-limit.error.ts's `RateLimitError` /
 * `parseRetryAfterMs`.
 *
 * WHY THIS EXISTS: every provider-calling subpath in this package (`/ai` ->
 * Anthropic, `/geo` -> Nominatim/Google) can receive a 429/rate-limit
 * response, and both the server's in-process enrichment worker AND a
 * distributed CLI worker node need to react the same way — defer with
 * backoff instead of burning through the normal retry-attempt budget. Rather
 * than each subpath inventing its own ad-hoc error shape, they all throw (or
 * a caller can classify into) this one `ProviderRateLimitError`, so:
 *
 *   - apps/api's enrichment handlers can catch it and re-wrap as its own
 *     `RateLimitError` (or, once handlers import this package directly,
 *     use it verbatim) to route through `EnrichmentTerminalService`'s
 *     deferral path.
 *   - apps/cli's node-engine.ts (node/node-engine.ts) has ONE place —
 *     `err instanceof ProviderRateLimitError` — that classifies a compute
 *     failure as rate-limited and forwards `{ rateLimited, retryAfterMs }` to
 *     `POST /nodes/:id/jobs/:jobId/failure`, regardless of which compute
 *     module (auto-tagging via Anthropic, geocode via Nominatim/Google, or a
 *     future provider) threw it.
 *
 * `GeoProviderRateLimitError` (packages/enrichment-compute/src/geo/index.ts)
 * extends this class rather than duplicating it, so `err instanceof
 * ProviderRateLimitError` is true for both `/geo`- and `/ai`-origin errors.
 */

/**
 * Parse a Retry-After header value into milliseconds.
 *
 * Accepts:
 *  - Integer seconds (e.g. "30")
 *  - HTTP-date string (e.g. "Wed, 21 Oct 2025 07:28:00 GMT")
 *
 * Returns undefined when the value is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  // Integer seconds
  const asInt = parseInt(trimmed, 10);
  if (!isNaN(asInt) && String(asInt) === trimmed) {
    return Math.max(0, asInt * 1000);
  }

  // HTTP-date
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    return Math.max(0, parsed - Date.now());
  }

  return undefined;
}

/**
 * Thrown (or classified into, via a subpath's own detection logic) when a
 * remote provider signals that a request must be retried later — HTTP 429,
 * Anthropic's 529 "Overloaded", a provider's own quota-exhaustion status
 * field, etc.
 *
 * Consumers should check `err instanceof ProviderRateLimitError` (matches
 * subclasses like `GeoProviderRateLimitError` too) and forward `retryAfterMs`
 * to whatever backoff/deferral mechanism they own.
 */
export class ProviderRateLimitError extends Error {
  constructor(
    message: string,
    /** Provider key (e.g. "anthropic", "nominatim", "google") for logging. */
    public readonly provider?: string,
    /** Provider's requested delay in milliseconds (from a Retry-After header), if known. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderRateLimitError';
    // Maintain proper prototype chain in environments that transpile classes
    // (matches apps/api/src/enrichment/rate-limit.error.ts's RateLimitError).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
