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
 * read which pool was growing. Each line also carries `heapGrowthMbPerHour`, a
 * least-squares slope over the retained sample window, so "is it still
 * climbing?" is a number in the log rather than an eyeball judgement across
 * hours of lines. It pairs with `heap-snapshot.ts`: the log says which pool and
 * how fast, the snapshot names the exact retainer.
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
  /**
   * Least-squares slope of `heapUsed` over the retained sample window, in
   * MB/hour. Absent until the retained readings span `MIN_TREND_SPAN_MS`
   * (~30 min), because a slope over a shorter window is mostly GC sawtooth.
   *
   * This is the number the issue-#156 bisection actually turns on (issue #156):
   * "run a batch with `duplicate_detection` excluded and see whether the heap
   * still climbs" is only answerable by eyeballing a log trend unless the trend
   * itself is reported. A steady positive slope across a window that spans
   * several GC cycles is a leak; a bounded sawtooth averages out near zero.
   */
  heapGrowthMbPerHour?: number;
  /** Minutes spanned by the samples behind `heapGrowthMbPerHour`. */
  trendWindowMinutes?: number;
}

export interface MemoryWatchdogOptions {
  /** Sample interval in ms (default 60_000). */
  intervalMs?: number;
  /** heapUsed/heapLimit fraction at/above which a sample escalates to `warn` (default 0.85). */
  warnFraction?: number;
  /**
   * heapUsed/heapLimit fraction at/above which `onCritical` fires ONCE (default
   * 0.90; `0` disables). Overridable via `MEMORIAHUB_HEAP_RESTART_FRACTION`.
   * Should sit above `warnFraction` so a warn is logged before the critical
   * action. This is the trigger for the supervised drain-and-restart safety
   * valve — see the caller in `node start`.
   */
  restartFraction?: number;
  /**
   * Invoked at most ONCE, the first sample whose `heapUsedFraction` reaches
   * `restartFraction`. The caller decides what to do (typically: drain
   * in-flight jobs and exit for a supervised restart). Sampling continues after
   * it fires (so the log keeps recording the climb) but it never fires twice.
   */
  onCritical?: (sample: MemorySample) => void;
}

const MB = 1024 * 1024;

/** One retained (time, heapUsed) reading behind the growth trend. */
export interface HeapTrendPoint {
  atMs: number;
  heapUsedMb: number;
}

/**
 * Age at which a reading falls out of the trend window (one hour). The window
 * is time-based rather than count-based so the slope means the same thing at
 * the default 60 s cadence and at the untuned 15 s cadence.
 */
export const TREND_WINDOW_MS = 60 * 60_000;

/**
 * Minimum span the retained readings must cover before a slope is reported.
 *
 * This guard is load-bearing, not decoration: GC sawtooth over a SHORT window
 * produces a large spurious rate. A ±40 MB alternation sampled every minute
 * regresses to ~100 MB/h over 12 minutes, ~16 MB/h over 30, and ~4 MB/h over
 * 60 — so a slope from a five-minute window would cry leak on a perfectly
 * healthy worker. Waiting for a real window is what makes the number
 * trustworthy enough to act on.
 */
export const MIN_TREND_SPAN_MS = 30 * 60_000;

/** Minimum readings before a slope is reported at all. */
export const MIN_TREND_SAMPLES = 5;

/**
 * Hard cap on retained readings — a safety bound only. The time window above
 * governs in practice (240 points at the 15 s cadence); this exists so a
 * pathological interval can never make the trend buffer itself the leak.
 */
export const MAX_TREND_POINTS = 720;

/**
 * Least-squares slope of heapUsed over time, in MB/hour. Returns `null` when
 * the readings are too few, or span less than `MIN_TREND_SPAN_MS`, so a caller
 * can omit the field rather than publish a number that is mostly GC noise.
 */
export function heapGrowthMbPerHour(points: readonly HeapTrendPoint[]): number | null {
  if (points.length < MIN_TREND_SAMPLES) return null;
  const n = points.length;
  if (points[n - 1]!.atMs - points[0]!.atMs < MIN_TREND_SPAN_MS) return null;
  const t0 = points[0]!.atMs;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of points) {
    // Hours since the first retained point — keeps the slope in MB/hour directly.
    const x = (p.atMs - t0) / 3_600_000;
    const y = p.heapUsedMb;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null; // all readings at the same instant
  return Math.round(((n * sumXY - sumX * sumY) / denom) * 10) / 10;
}

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
  const restartFraction = resolveRestartFraction(opts.restartFraction);
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;

  let criticalFired = false;
  const trend: HeapTrendPoint[] = [];
  const tick = (): void => {
    const s = sample(heapLimitBytes);

    // Bounded ring: retaining the trend must never itself be a leak. Evict by
    // age first (the window that gives the slope its meaning), then by the
    // hard count cap as a backstop.
    const now = Date.now();
    trend.push({ atMs: now, heapUsedMb: s.heapUsedMb });
    while (trend.length > 0 && now - trend[0]!.atMs > TREND_WINDOW_MS) trend.shift();
    while (trend.length > MAX_TREND_POINTS) trend.shift();
    const slope = heapGrowthMbPerHour(trend);
    if (slope !== null) {
      s.heapGrowthMbPerHour = slope;
      s.trendWindowMinutes =
        Math.round(((trend[trend.length - 1]!.atMs - trend[0]!.atMs) / 60_000) * 10) / 10;
    }

    emit(s.heapUsedFraction >= warnFraction ? 'warn' : 'info', s);
    if (
      !criticalFired &&
      restartFraction > 0 &&
      s.heapUsedFraction >= restartFraction &&
      opts.onCritical
    ) {
      criticalFired = true;
      opts.onCritical(s);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Resolve the critical (drain-and-restart) heap fraction: the explicit option,
 * else `MEMORIAHUB_HEAP_RESTART_FRACTION` (a value in (0,1]; `0` disables), else
 * `fallback` (default 0.90). An out-of-range env value is ignored in favor of
 * the option / fallback.
 */
export function resolveRestartFraction(explicit?: number, fallback = 0.9): number {
  if (explicit !== undefined) return explicit;
  const env = process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
  if (env !== undefined && env.trim() !== '') {
    const n = Number.parseFloat(env);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Untuned-process tightening (issue #156)
// ---------------------------------------------------------------------------

/** Sample interval used when the process runs at an untuned heap ceiling. */
export const UNTUNED_WATCHDOG_INTERVAL_MS = 15_000;
/** Default critical fraction used when the process runs at an untuned heap ceiling. */
export const UNTUNED_RESTART_FRACTION = 0.8;

/**
 * Tightened watchdog options for an engine running in a process whose V8 heap
 * ceiling was NOT raised to the RAM-aware target (see
 * `describeHeapTuning()` in runtime-tuning.ts) — e.g. an in-process engine
 * inside the interactive TUI, which cannot re-exec to set launch flags.
 *
 * Rationale (issue #156): at the ~2 GB default ceiling, the standard settings
 * (60 s sampling, drain at 90%) leave only ~200 MB of margin — a burst of
 * in-flight image jobs can blow through that between two samples, which is
 * exactly how the 1.2.14 TUI crash sailed past the safety valve. Sampling 4×
 * faster and draining at 80% trades a slightly earlier stop for actually
 * catching the climb. An explicit `MEMORIAHUB_HEAP_RESTART_FRACTION` still
 * wins over the tightened default.
 */
export function untunedWatchdogOptions(): Pick<
  MemoryWatchdogOptions,
  'intervalMs' | 'restartFraction'
> {
  return {
    intervalMs: UNTUNED_WATCHDOG_INTERVAL_MS,
    restartFraction: resolveRestartFraction(undefined, UNTUNED_RESTART_FRACTION),
  };
}
