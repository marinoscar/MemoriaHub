import {
  MemoriahubAiError,
  MemoriahubRateLimitError,
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
