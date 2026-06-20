/**
 * http/retry.ts — Rate-limit-aware HTTP retry engine.
 *
 * A single retry engine shared by the ApiClient (JSON requests) and the
 * presigned-PUT path. Retries only transient failures — HTTP 429/502/503/504
 * and network errors — with exponential backoff + full jitter, honoring the
 * server's `Retry-After` header as a floor. Non-retryable errors (other 4xx)
 * are rethrown immediately.
 *
 * This module is dependency-free (no imports from api.ts) so it can be unit
 * tested in isolation and reused anywhere.
 */

export interface RetryConfig {
  /** Number of retry attempts AFTER the first try (total tries = maxRetries + 1). */
  maxRetries: number;
  /** Base backoff in milliseconds. */
  baseMs: number;
  /** Per-attempt backoff cap in milliseconds. */
  maxMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseMs: 500,
  maxMs: 30_000,
};

/** HTTP statuses that warrant a retry. */
export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Transient network error codes that warrant a retry. */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export interface RetryableInfo {
  retryable: boolean;
  /** HTTP status if the error carried one. */
  status?: number;
  /** Parsed `Retry-After` in ms, if the error carried one. */
  retryAfterMs?: number | null;
}

/**
 * Classify an arbitrary thrown value as retryable or not, duck-typing the
 * shapes produced by ApiClient (`status`, `retryAfterMs`, `isNetworkError`)
 * as well as raw Node/undici network errors (`code`) and fetch `TypeError`s.
 */
export function classifyError(err: unknown): RetryableInfo {
  if (err == null || typeof err !== 'object') {
    return { retryable: false };
  }
  const e = err as Record<string, unknown>;

  const status = typeof e.status === 'number' ? e.status : undefined;
  const retryAfterMs =
    typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined;

  // Explicit retryable marker (e.g. an S3 `SlowDown` body on a non-429 status).
  if (e.retryable === true) {
    return { retryable: true, status, retryAfterMs };
  }

  // Explicit network-error marker (set by ApiClient.NetworkError).
  if (e.isNetworkError === true) {
    return { retryable: true };
  }

  // Raw Node/undici transient socket errors.
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code && RETRYABLE_NET_CODES.has(code)) {
    return { retryable: true };
  }

  // A bare fetch network failure surfaces as a TypeError with no status.
  if (status === undefined && err instanceof TypeError) {
    return { retryable: true };
  }

  if (status !== undefined && RETRYABLE_STATUSES.has(status)) {
    return { retryable: true, status, retryAfterMs };
  }

  return { retryable: false, status, retryAfterMs };
}

/** Convenience predicate over {@link classifyError}. */
export function isRetryable(err: unknown): boolean {
  return classifyError(err).retryable;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *  - Integer seconds          → seconds * 1000
 *  - HTTP-date                → max(0, date - now)
 *  - absent / unparseable     → null
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: () => number = Date.now,
): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - now());
  }

  return null;
}

/**
 * Compute the backoff delay (ms) for a given 1-based attempt.
 *
 * Exponential with full jitter: `rand() * min(maxMs, baseMs * 2^(attempt-1))`.
 * When `retryAfterMs` is present it acts as a floor (jitter is still applied
 * above it) and may exceed `maxMs` since the server value is authoritative —
 * but it is hard-capped at `maxMs * 4` to avoid pathological waits.
 */
export function computeBackoffMs(
  attempt: number,
  cfg: RetryConfig,
  retryAfterMs: number | null = null,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(cfg.maxMs, cfg.baseMs * 2 ** (attempt - 1));
  const jittered = rand() * exp;

  if (retryAfterMs != null) {
    return Math.min(Math.max(retryAfterMs, jittered), cfg.maxMs * 4);
  }
  return jittered;
}

export interface WithRetryHooks {
  /** Override the retryable classifier (defaults to {@link classifyError}). */
  classify?: (err: unknown) => RetryableInfo;
  /** Called before each backoff sleep — used to drive the cooldown gate / UI. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status?: number;
    retryAfterMs?: number | null;
  }) => void | Promise<void>;
  /** Injectable sleep (defaults to setTimeout) — tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for deterministic jitter in tests. */
  rand?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * Rethrows the last error once retries are exhausted or the error is not
 * retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig,
  hooks: WithRetryHooks = {},
): Promise<T> {
  const classify = hooks.classify ?? classifyError;
  const sleep = hooks.sleep ?? defaultSleep;
  const rand = hooks.rand ?? Math.random;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const info = classify(err);
      if (!info.retryable || attempt > cfg.maxRetries) {
        throw err;
      }
      const delayMs = computeBackoffMs(
        attempt,
        cfg,
        info.retryAfterMs ?? null,
        rand,
      );
      if (hooks.onRetry) {
        await hooks.onRetry({
          attempt,
          delayMs,
          status: info.status,
          retryAfterMs: info.retryAfterMs,
        });
      }
      await sleep(delayMs);
    }
  }
}
