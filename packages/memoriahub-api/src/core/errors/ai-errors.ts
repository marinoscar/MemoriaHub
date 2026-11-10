import {
  MemoriahubAiError,
  MemoriahubRateLimitError,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';

/**
 * The error a job handler should throw for an AI failure: a {@link MemoriahubRateLimitError} for a
 * provider throttle (the queue DEFERS the job without charging an attempt), the error itself otherwise.
 *
 * @param err - what the AI call threw.
 * @param throttleKey - the bucket the call draws on (`tagging`).
 * @returns the value to throw.
 * @stability experimental
 */
export function asJobError(err: unknown, throttleKey = 'ai'): unknown {
  return aiRateLimit(err, throttleKey) ?? err;
}

/**
 * The rate-limit signal in `err`, or `null`: a {@link MemoriahubAiError} of class `rate_limit` only.
 *
 * @param err - what the AI call threw.
 * @param throttleKey - the bucket the call draws on.
 * @returns the error to rethrow so the queue defers the job, or `null`.
 * @stability experimental
 */
export function aiRateLimit(err: unknown, throttleKey = 'ai'): MemoriahubRateLimitError | null {
  if (err instanceof MemoriahubAiError && err.errorClass === 'rate_limit') {
    return new MemoriahubRateLimitError(throttleKey, err.retryAfterMs, err.message);
  }
  return null;
}

/**
 * A feature's saved model: the `ai.features.<key>` selection an administrator made.
 *
 * @stability experimental
 */
export interface MemoriahubAiSelection {
  /** The provider id. */
  provider: string;
  /** The model id. */
  model: string;
}

/**
 * Reads the model an administrator saved for a feature (`ai.features.<key>`, for example `tagging`,
 * `embedding`, `search`, `transcription`) through the settings port, or `null` when it is unset or
 * half-filled. No key is here: whose key pays is the host's, resolved per call.
 *
 * @param settings - the settings port.
 * @param key - the selection key under `ai.features`.
 * @returns the selection, or null.
 * @stability experimental
 */
export async function readAiSelection(
  settings: MemoriahubSettingsPort,
  key: string,
): Promise<MemoriahubAiSelection | null> {
  const { value } = await settings.readSystem<{ features?: Record<string, { provider?: string | null; model?: string | null } | null> }>('ai');
  const chosen = value?.features?.[key];
  if (!chosen?.provider || !chosen?.model) return null;
  return { provider: chosen.provider, model: chosen.model };
}

const THROTTLE_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'SlowDown',
]);

function retryAfterOf(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as Record<string, unknown>;
  const raw = h['retry-after'] ?? h['Retry-After'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds) && String(seconds) === trimmed) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  return isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Best-effort classification of an unknown error as a provider throttle: HTTP 429 and 529
 * (Anthropic "Overloaded") by `status`, `response.status` or `$metadata.httpStatusCode`, the AWS
 * throttling names (`SlowDown`, `ThrottlingException`, ...), and a `Retry-After` header on the
 * response. A job handler runs its body through it so the queue defers the job instead of charging
 * an attempt. An AI failure is classified by {@link aiRateLimit}.
 *
 * @param err - what a call threw.
 * @param throttleKey - the throttle bucket the cooldown lands on.
 * @returns the deferral signal, or null when the error is not a throttle.
 * @stability experimental
 */
export function classifyProviderThrottle(err: unknown, throttleKey = 'ai'): MemoriahubRateLimitError | null {
  if (err instanceof MemoriahubRateLimitError) return err;
  const fromAi = aiRateLimit(err, throttleKey);
  if (fromAi) return fromAi;
  if (!err || typeof err !== 'object') return null;

  const e = err as Record<string, unknown>;
  const response = e['response'] && typeof e['response'] === 'object' ? (e['response'] as Record<string, unknown>) : undefined;
  const meta = e['$metadata'] && typeof e['$metadata'] === 'object' ? (e['$metadata'] as Record<string, unknown>) : undefined;
  const retryAfterMs = retryAfterOf(response?.['headers']) ?? retryAfterOf(e['headers']);

  const status =
    (typeof e['status'] === 'number' ? e['status'] : undefined) ??
    (typeof response?.['status'] === 'number' ? (response['status'] as number) : undefined) ??
    (typeof meta?.['httpStatusCode'] === 'number' ? (meta['httpStatusCode'] as number) : undefined);
  if (status === 429 || status === 529) {
    const message = typeof e['message'] === 'string' ? e['message'] : `Provider rate limit exceeded (HTTP ${status})`;
    return new MemoriahubRateLimitError(throttleKey, retryAfterMs, message);
  }

  const name = typeof e['name'] === 'string' ? e['name'] : undefined;
  const code = typeof e['Code'] === 'string' ? e['Code'] : typeof meta?.['Code'] === 'string' ? (meta['Code'] as string) : undefined;
  if ((name && THROTTLE_NAMES.has(name)) || (code && THROTTLE_NAMES.has(code))) {
    const message = typeof e['message'] === 'string' ? e['message'] : `AWS throttle: ${name ?? code ?? 'unknown'}`;
    return new MemoriahubRateLimitError(throttleKey, retryAfterMs, message);
  }
  return null;
}
