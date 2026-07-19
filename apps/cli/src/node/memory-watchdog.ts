/**
 * node/memory-watchdog.ts — Periodic memory-pressure sampler for the worker.
 *
 * A long-lived worker under sustained bulk-import load can slowly climb memory
 * and eventually die with "Ineffective mark-compacts near heap limit —
 * JavaScript heap out of memory". When that happens the fatal V8 log tells you
 * the heap was full but NOT which pool grew — and that distinction is the whole
 * diagnosis:
 *   - `heapUsed` climbing  → a JS-object/string/typed-array leak (V8-managed)
 *   - `external`/`arrayBuffers` climbing → native buffers (sharp/onnx/undici)
 *   - `rss` >> heapUsed    → native allocator / off-heap growth
 *
 * This watchdog samples `process.memoryUsage()` on an interval and writes one
 * structured line per sample to the worker's normal log, escalating to `warn`
 * once heapUsed crosses a fraction of the V8 heap ceiling — so an operator
 * watching `memoriahub node logs` sees the climb coming, and a post-mortem can
 * read which pool was growing. It pairs with the `--heapsnapshot-near-heap-limit`
 * flag (see runtime-tuning.ts): the log says which pool, the snapshot names the
 * exact retainer.
 *
 * Cheap and side-effect-free: one `setInterval` (unref'd, so it never keeps the
 * process alive) calling a cheap syscall-free V8 stat. Disable with
 * `MEMORIAHUB_MEMWATCH=0`.
 */

import v8 from 'node:v8';

export type MemoryWatchdogLevel = 'info' | 'warn';

export interface MemorySample {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  heapLimitMb: number;
  /** heapUsed as a fraction of the V8 heap ceiling, rounded to 2 dp. */
  heapUsedFraction: number;
}

export interface MemoryWatchdogOptions {
  /** Sample interval in ms (default 60_000). */
  intervalMs?: number;
  /** heapUsed/heapLimit fraction at/above which a sample escalates to `warn` (default 0.85). */
  warnFraction?: number;
}

const MB = 1024 * 1024;

function sample(heapLimitBytes: number): MemorySample {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / MB),
    heapUsedMb: Math.round(m.heapUsed / MB),
    heapTotalMb: Math.round(m.heapTotal / MB),
    externalMb: Math.round(m.external / MB),
    arrayBuffersMb: Math.round(m.arrayBuffers / MB),
    heapLimitMb: Math.round(heapLimitBytes / MB),
    heapUsedFraction: Math.round((m.heapUsed / heapLimitBytes) * 100) / 100,
  };
}

/**
 * Start sampling memory on an interval, invoking `emit(level, sample)` for each
 * reading. Returns a stop function that clears the timer. A no-op (returns a
 * no-op stopper) when `MEMORIAHUB_MEMWATCH=0`.
 *
 * `emit` is where the caller routes the sample — typically the worker's
 * structured logger, so it lands in `node logs`.
 */
export function startMemoryWatchdog(
  emit: (level: MemoryWatchdogLevel, sample: MemorySample) => void,
  opts: MemoryWatchdogOptions = {},
): () => void {
  if (process.env['MEMORIAHUB_MEMWATCH'] === '0') return () => {};

  const intervalMs = Math.max(1000, opts.intervalMs ?? 60_000);
  const warnFraction = opts.warnFraction ?? 0.85;
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;

  const tick = (): void => {
    const s = sample(heapLimitBytes);
    emit(s.heapUsedFraction >= warnFraction ? 'warn' : 'info', s);
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
