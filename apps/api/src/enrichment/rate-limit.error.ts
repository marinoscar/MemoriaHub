// =============================================================================
// RateLimitError + provider-throttle classifier
// =============================================================================
//
// Thrown by enrichment handlers (or detected by the worker fallback) when a
// remote provider signals that the request must be retried later.
//
// Handlers should throw this explicitly when they can parse a structured
// throttle error. The worker also calls `classifyRateLimit` as a fallback to
// catch any unclassified provider errors.
// =============================================================================

/**
 * Parse a Retry-After header value into milliseconds.
 *
 * Accepts:
 *  - Integer seconds (e.g. "30")
 *  - HTTP-date string (e.g. "Wed, 21 Oct 2025 07:28:00 GMT")
 *
 * Returns null when the value is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | undefined | null): number | null {
  if (!value) return null;
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

  return null;
}

/**
 * Error class thrown when an enrichment handler encounters a provider rate
 * limit (HTTP 429 / AWS ThrottlingException / etc.).
 *
 * The worker uses this to branch into the rate-limit deferral path instead
 * of the normal exponential-retry path, and tracks hits separately so that
 * ordinary transient errors do not consume rate-limit quota (and vice versa).
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    /** Provider's requested delay in milliseconds (from Retry-After header), if known. */
    public readonly retryAfterMs?: number,
    /** Provider key (e.g. "anthropic", "openai", "rekognition") for logging. */
    public readonly providerKey?: string,
  ) {
    super(message);
    this.name = 'RateLimitError';
    // Maintain proper prototype chain in environments that transpile classes
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Well-known AWS throttling error names (SDK v3 + legacy Code field)
// ---------------------------------------------------------------------------

const AWS_THROTTLE_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'SlowDown',
]);

/**
 * Best-effort classification of an unknown error as a provider rate-limit.
 *
 * Returns a `RateLimitError` (with any parseable `retryAfterMs`) when the
 * error is identified as a throttle response. Returns `null` otherwise.
 *
 * Detects:
 *  - HTTP 429 via `err.status`, `err.response.status`, or
 *    `err.$metadata.httpStatusCode`
 *  - AWS SDK v3 throttling errors by name / Code field
 *  - `Retry-After` headers on the response object
 */
export function classifyRateLimit(err: unknown): RateLimitError | null {
  if (!err || typeof err !== 'object') return null;

  const e = err as Record<string, unknown>;

  // ── Extract Retry-After from response headers ──────────────────────────
  let retryAfterMs: number | undefined;

  const extractRetryAfter = (headers: unknown): number | undefined => {
    if (!headers || typeof headers !== 'object') return undefined;
    const h = headers as Record<string, unknown>;
    const raw = h['retry-after'] ?? h['Retry-After'];
    if (typeof raw === 'string') {
      const ms = parseRetryAfterMs(raw);
      return ms ?? undefined;
    }
    return undefined;
  };

  // Try err.response.headers (Axios / fetch-style)
  if (e['response'] && typeof e['response'] === 'object') {
    const res = e['response'] as Record<string, unknown>;
    const fromResponse = extractRetryAfter(res['headers']);
    if (fromResponse !== undefined) retryAfterMs = fromResponse;
  }

  // Try err.headers directly (some AWS SDK v3 shapes)
  if (retryAfterMs === undefined) {
    const fromDirect = extractRetryAfter(e['headers']);
    if (fromDirect !== undefined) retryAfterMs = fromDirect;
  }

  // ── HTTP 429 detection ─────────────────────────────────────────────────

  const httpStatus =
    (typeof e['status'] === 'number' ? e['status'] : undefined) ??
    (typeof (e['response'] as Record<string, unknown> | undefined)?.['status'] === 'number'
      ? ((e['response'] as Record<string, unknown>)['status'] as number)
      : undefined) ??
    (typeof (e['$metadata'] as Record<string, unknown> | undefined)?.['httpStatusCode'] === 'number'
      ? ((e['$metadata'] as Record<string, unknown>)['httpStatusCode'] as number)
      : undefined);

  if (httpStatus === 429) {
    const message =
      typeof e['message'] === 'string'
        ? e['message']
        : 'Provider rate limit exceeded (HTTP 429)';
    return new RateLimitError(message, retryAfterMs);
  }

  // ── AWS throttling error names ─────────────────────────────────────────

  const errorName = typeof e['name'] === 'string' ? e['name'] : undefined;
  const errorCode =
    typeof e['Code'] === 'string'
      ? e['Code']
      : typeof (e['$metadata'] as Record<string, unknown> | undefined)?.['Code'] === 'string'
        ? ((e['$metadata'] as Record<string, unknown>)['Code'] as string)
        : undefined;

  if ((errorName && AWS_THROTTLE_NAMES.has(errorName)) || (errorCode && AWS_THROTTLE_NAMES.has(errorCode))) {
    const message =
      typeof e['message'] === 'string'
        ? e['message']
        : `AWS throttle: ${errorName ?? errorCode ?? 'unknown'}`;
    return new RateLimitError(message, retryAfterMs);
  }

  return null;
}
