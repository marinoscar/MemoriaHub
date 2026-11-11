import { MemoriahubRateLimitError } from '../../ports/index.js';

// =============================================================================
// The media-item subject of a media job handler (RETRO-J5, #613)
// =============================================================================
//
// The media services read three fields of a job (`id`, `mediaItemId`, `circleId`);
// `resolveMediaItemJob` (jobs/enrichment-jobs.ts) resolves them from the queue's job. This file
// adds the context type the services accept and the rate-limit adapter of a media handler.
// =============================================================================

/**
 * What the media services read of a job.
 *
 * @stability experimental
 */
export interface MediaJobContext {
  /** The job id. */
  readonly id: string;
  /** The media item, or null for a malformed context. */
  readonly mediaItemId: string | null;
  /** The circle (owner scope) of the item. */
  readonly circleId: string | null;
}

const AWS_THROTTLE_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'SlowDown',
]);

/**
 * The throttle bucket of the reverse-geocoding and storage quota the media jobs hit.
 *
 * @stability experimental
 */
export const MEDIA_THROTTLE_KEY = 'media';

function retryAfterOf(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as Record<string, unknown>;
  const raw = h['retry-after'] ?? h['Retry-After'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const asInt = parseInt(trimmed, 10);
  if (!isNaN(asInt) && String(asInt) === trimmed) return Math.max(0, asInt * 1000);
  const parsed = Date.parse(trimmed);
  return isNaN(parsed) ? undefined : Math.max(0, parsed - Date.now());
}

/**
 * Classifies a provider throttle signal (HTTP 429 or 529, or an AWS throttle name) as the rate-limit
 * error the queue defers on, or `null` when the error is not a throttle.
 *
 * @param error - the thrown value.
 * @returns the rate-limit error, or `null`.
 * @stability experimental
 */
export function classifyMediaRateLimit(error: unknown): MemoriahubRateLimitError | null {
  if (error instanceof MemoriahubRateLimitError) return error;
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const response = e['response'] && typeof e['response'] === 'object' ? (e['response'] as Record<string, unknown>) : undefined;
  const meta = e['$metadata'] && typeof e['$metadata'] === 'object' ? (e['$metadata'] as Record<string, unknown>) : undefined;

  const retryAfterMs = retryAfterOf(response?.['headers']) ?? retryAfterOf(e['headers']);
  const status =
    (typeof e['status'] === 'number' ? e['status'] : undefined) ??
    (typeof response?.['status'] === 'number' ? (response['status'] as number) : undefined) ??
    (typeof meta?.['httpStatusCode'] === 'number' ? (meta['httpStatusCode'] as number) : undefined);

  if (status === 429 || status === 529) {
    const message = typeof e['message'] === 'string' ? e['message'] : `Provider rate limit exceeded (HTTP ${status})`;
    return new MemoriahubRateLimitError(MEDIA_THROTTLE_KEY, retryAfterMs, message);
  }

  const name = typeof e['name'] === 'string' ? e['name'] : undefined;
  const code = typeof e['Code'] === 'string' ? e['Code'] : typeof meta?.['Code'] === 'string' ? (meta['Code'] as string) : undefined;
  if ((name && AWS_THROTTLE_NAMES.has(name)) || (code && AWS_THROTTLE_NAMES.has(code))) {
    const message = typeof e['message'] === 'string' ? e['message'] : `AWS throttle: ${name ?? code ?? 'unknown'}`;
    return new MemoriahubRateLimitError(MEDIA_THROTTLE_KEY, retryAfterMs, message);
  }
  return null;
}

/**
 * Runs `fn`, rethrowing any provider throttle signal as the queue's rate-limit error (so the job is
 * deferred, not failed).
 *
 * @param fn - the work.
 * @returns what `fn` returns.
 * @stability experimental
 */
export async function withMediaRateLimits<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    const rateLimit = classifyMediaRateLimit(error);
    if (rateLimit) throw rateLimit;
    throw error;
  }
}
