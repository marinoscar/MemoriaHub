// =============================================================================
// A read shared by a gauge callback, memoized for 60 s (RETRO-T3, #628)
// =============================================================================
//
// The SDK calls every gauge callback on each export (about once a minute per
// reader), and several gauges can share one query. `memoizedRead` runs the
// query at most once per `ttlMs`, shares an in-flight promise, logs a warning
// when a read takes more than 50 ms (the issue's per-gauge budget) and never
// throws: a failed read observes nothing and is retried on the next export.
// =============================================================================

import { Logger } from '@nestjs/common';

/** The memo window of every MemoriaHub gauge read. */
export const GAUGE_MEMO_MS = 60_000;
/** A gauge read slower than this logs a warning. */
export const GAUGE_SLOW_MS = 50;

export interface MemoizedRead<T> {
  /** The value (fresh, or at most `ttlMs` old), or `null` when the read failed. */
  get(): Promise<T | null>;
}

export function memoizedRead<T>(
  name: string,
  read: () => Promise<T>,
  options: { ttlMs?: number; now?: () => number; logger?: Pick<Logger, 'warn' | 'debug'> } = {},
): MemoizedRead<T> {
  const ttlMs = options.ttlMs ?? GAUGE_MEMO_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? new Logger('MemoriaHubGauges');
  let cached: { at: number; value: T } | null = null;
  let inFlight: Promise<T | null> | null = null;

  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      if (inFlight) return inFlight;
      const startedAt = now();
      inFlight = read()
        .then((value) => {
          const tookMs = now() - startedAt;
          if (tookMs > GAUGE_SLOW_MS) logger.warn(`gauge read "${name}" took ${tookMs} ms (budget ${GAUGE_SLOW_MS} ms)`);
          cached = { at: now(), value };
          return value;
        })
        .catch((error: unknown) => {
          logger.debug(`gauge read "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
