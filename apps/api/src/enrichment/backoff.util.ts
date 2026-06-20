// =============================================================================
// Queue backoff calculator
// =============================================================================
//
// Used by the enrichment worker for both normal-error retry delays and
// rate-limit deferral delays. Implements equal-jitter exponential backoff:
//
//   exp   = min(maxMs, baseMs * 2^(n-1))
//   delay = exp/2 + rand() * (exp/2)
//
// When retryAfterMs is provided by the provider, the computed jitter is
// floored at that value so we never retry sooner than the server requested.
// =============================================================================

/**
 * Compute a backoff delay for the given 1-based attempt/hit count.
 *
 * @param n           1-based attempt or rate-limit-hit count
 * @param opts.baseMs Base delay in milliseconds for n=1
 * @param opts.maxMs  Maximum delay cap in milliseconds
 * @param opts.retryAfterMs  Provider-requested minimum delay (from Retry-After
 *                   header), or null/undefined to skip the floor.
 * @param rand        Injectable RNG (defaults to Math.random) for deterministic
 *                   testing.
 * @returns           Delay in milliseconds (always >= 0)
 */
export function computeQueueBackoffMs(
  n: number,
  opts: { baseMs: number; maxMs: number; retryAfterMs?: number | null },
  rand: () => number = Math.random,
): number {
  const { baseMs, maxMs, retryAfterMs } = opts;

  // Equal-jitter exponential backoff
  const exp = Math.min(maxMs, baseMs * Math.pow(2, n - 1));
  const half = exp / 2;
  const jittered = half + rand() * half;

  // If the provider specified a minimum wait, never go below it
  const floor = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.max(floor, jittered);
}
