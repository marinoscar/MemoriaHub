/**
 * test/node/memory-watchdog.spec.ts — Unit tests for
 * src/node/memory-watchdog.ts (periodic memory-pressure sampler for the
 * worker).
 *
 * Covered:
 *   1. emit fires once per interval tick (fake timers).
 *   2. Each emitted sample has the documented numeric fields.
 *   3. level escalates to 'warn' when warnFraction is unreachable-low (0),
 *      and stays 'info' under the default/high warnFraction (1.1).
 *   4. The returned stop function clears the interval — no further emits.
 *   5. MEMORIAHUB_MEMWATCH=0 disables the watchdog entirely (no-op stopper,
 *      emit never called).
 *   6. intervalMs is floored at 1000ms (Math.max(1000, ...) clamp) — a tick
 *      requested at 1ms still only fires once 1000ms have elapsed.
 *   7. The heap-growth trend (issue #156): omitted until the retained readings
 *      span MIN_TREND_SPAN_MS, then reported as a MB/hour slope — including
 *      the case that motivates the span guard, where a bounded GC sawtooth
 *      over a short window would otherwise regress to a steep phantom leak.
 *
 * Uses Jest fake timers since the module drives its sampling via
 * setInterval. process.env['MEMORIAHUB_MEMWATCH'] is snapshotted/restored
 * around the one test that sets it, mirroring the save/restore style in
 * test/node/runtime-tuning.spec.ts.
 */

import { jest } from '@jest/globals';
import {
  startMemoryWatchdog,
  resolveRestartFraction,
  untunedWatchdogOptions,
  heapGrowthMbPerHour,
  MIN_TREND_SAMPLES,
  MIN_TREND_SPAN_MS,
  UNTUNED_WATCHDOG_INTERVAL_MS,
  UNTUNED_RESTART_FRACTION,
} from '../../src/node/memory-watchdog.js';
import type { MemoryWatchdogLevel, MemorySample } from '../../src/node/memory-watchdog.js';

describe('startMemoryWatchdog', () => {
  let savedMemwatch: string | undefined;

  beforeEach(() => {
    savedMemwatch = process.env['MEMORIAHUB_MEMWATCH'];
    delete process.env['MEMORIAHUB_MEMWATCH'];
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (savedMemwatch === undefined) delete process.env['MEMORIAHUB_MEMWATCH'];
    else process.env['MEMORIAHUB_MEMWATCH'] = savedMemwatch;
    jest.useRealTimers();
  });

  it('invokes emit once per interval tick, and not before the first tick fires', () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1000 });

    expect(emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(999);
    expect(emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2000);
    expect(emit).toHaveBeenCalledTimes(3);

    stop();
  });

  it('emits a sample object with all documented numeric fields', () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    const [, sample]: [MemoryWatchdogLevel, MemorySample] = emit.mock.calls[0];

    expect(typeof sample.rssMb).toBe('number');
    expect(typeof sample.heapUsedMb).toBe('number');
    expect(typeof sample.heapTotalMb).toBe('number');
    expect(typeof sample.externalMb).toBe('number');
    expect(typeof sample.arrayBuffersMb).toBe('number');
    expect(typeof sample.heapLimitMb).toBe('number');
    expect(typeof sample.heapUsedFraction).toBe('number');

    stop();
  });

  it("reports level 'info' under the default/high warnFraction (1.1, unreachable)", () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1000, warnFraction: 1.1 });

    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    const [level]: [MemoryWatchdogLevel, MemorySample] = emit.mock.calls[0];
    expect(level).toBe('info');

    stop();
  });

  it("reports level 'warn' when warnFraction is 0 (always at/above the threshold)", () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1000, warnFraction: 0 });

    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    const [level]: [MemoryWatchdogLevel, MemorySample] = emit.mock.calls[0];
    expect(level).toBe('warn');

    stop();
  });

  it('stop() clears the interval so no further emits occur', () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    stop();

    jest.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op stopper and never calls emit when MEMORIAHUB_MEMWATCH=0', () => {
    process.env['MEMORIAHUB_MEMWATCH'] = '0';

    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1000 });

    jest.advanceTimersByTime(10_000);
    expect(emit).not.toHaveBeenCalled();

    // Stopping the no-op should not throw.
    expect(() => stop()).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it('floors intervalMs at 1000ms — a requested 1ms interval still only ticks after 1000ms', () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 1 });

    jest.advanceTimersByTime(999);
    expect(emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);

    stop();
  });
});

describe('resolveRestartFraction', () => {
  let savedRestartFraction: string | undefined;

  beforeEach(() => {
    savedRestartFraction = process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
    delete process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
  });

  afterEach(() => {
    if (savedRestartFraction === undefined) delete process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
    else process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = savedRestartFraction;
  });

  it('returns the explicit arg when provided, ignoring env entirely', () => {
    process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = '0.2';
    expect(resolveRestartFraction(0.5)).toBe(0.5);
  });

  it('defaults to 0.9 when no explicit arg is given and the env var is unset', () => {
    expect(resolveRestartFraction()).toBe(0.9);
  });

  it.each([
    ['0.75', 0.75],
    ['0', 0],
  ])('reads a valid env value %s -> %d', (envVal, expected) => {
    process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = envVal;
    expect(resolveRestartFraction()).toBe(expected);
  });

  it.each(['1.5', '-0.2', 'abc', ''])(
    'ignores an out-of-range/garbage env value (%j) and falls back to 0.9',
    (envVal) => {
      process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = envVal;
      expect(resolveRestartFraction()).toBe(0.9);
    },
  );

  it('uses the caller-supplied fallback instead of 0.9 when env is unset', () => {
    expect(resolveRestartFraction(undefined, 0.8)).toBe(0.8);
  });

  it('still lets a valid env value win over the caller-supplied fallback', () => {
    process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = '0.7';
    expect(resolveRestartFraction(undefined, 0.8)).toBe(0.7);
  });
});

describe('untunedWatchdogOptions', () => {
  let savedRestartFraction: string | undefined;

  beforeEach(() => {
    savedRestartFraction = process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
    delete process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
  });

  afterEach(() => {
    if (savedRestartFraction === undefined) delete process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'];
    else process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = savedRestartFraction;
  });

  it('tightens sampling to 15s and the critical fraction to 0.8 by default', () => {
    expect(untunedWatchdogOptions()).toEqual({
      intervalMs: UNTUNED_WATCHDOG_INTERVAL_MS,
      restartFraction: UNTUNED_RESTART_FRACTION,
    });
    expect(UNTUNED_WATCHDOG_INTERVAL_MS).toBe(15_000);
    expect(UNTUNED_RESTART_FRACTION).toBe(0.8);
  });

  it('an explicit MEMORIAHUB_HEAP_RESTART_FRACTION still wins over the tightened default', () => {
    process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = '0.95';
    expect(untunedWatchdogOptions().restartFraction).toBe(0.95);
  });

  it('env 0 (disable the valve) is respected', () => {
    process.env['MEMORIAHUB_HEAP_RESTART_FRACTION'] = '0';
    expect(untunedWatchdogOptions().restartFraction).toBe(0);
  });
});

describe('startMemoryWatchdog onCritical', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('never calls onCritical when restartFraction is 0 (disabled), even after many ticks', () => {
    const emit = jest.fn();
    const onCritical = jest.fn();
    const stop = startMemoryWatchdog(emit, {
      intervalMs: 1000,
      restartFraction: 0,
      onCritical,
    });

    jest.advanceTimersByTime(5000);
    expect(emit).toHaveBeenCalledTimes(5);
    expect(onCritical).not.toHaveBeenCalled();

    stop();
  });

  it('fires onCritical exactly once when restartFraction is effectively always-true, and emit keeps firing every tick afterward', () => {
    const emit = jest.fn();
    const onCritical = jest.fn();
    const stop = startMemoryWatchdog(emit, {
      intervalMs: 1000,
      restartFraction: 0.0001,
      onCritical,
    });

    jest.advanceTimersByTime(5000);

    expect(emit).toHaveBeenCalledTimes(5);
    expect(onCritical).toHaveBeenCalledTimes(1);

    const [sample]: [MemorySample] = onCritical.mock.calls[0];
    expect(typeof sample.heapUsedFraction).toBe('number');

    stop();
  });

  it('does not throw when onCritical is omitted and restartFraction is low (sampling continues normally)', () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, {
      intervalMs: 1000,
      restartFraction: 0.0001,
    });

    expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(5);

    stop();
  });

  // -------------------------------------------------------------------------
  // Heap-growth trend (issue #156)
  // -------------------------------------------------------------------------

  it('omits the growth trend until the retained readings span MIN_TREND_SPAN_MS, then reports it', () => {
    const emit = jest.fn();
    const stop = startMemoryWatchdog(emit, { intervalMs: 60_000 });

    // Just short of the required span — every sample so far must omit the trend.
    jest.advanceTimersByTime(MIN_TREND_SPAN_MS);
    expect(emit.mock.calls.length).toBeGreaterThan(MIN_TREND_SAMPLES);
    for (const call of emit.mock.calls) {
      const [, s] = call as [MemoryWatchdogLevel, MemorySample];
      expect(s.heapGrowthMbPerHour).toBeUndefined();
      expect(s.trendWindowMinutes).toBeUndefined();
    }

    jest.advanceTimersByTime(60_000);
    const [, latest] = emit.mock.calls[emit.mock.calls.length - 1] as [
      MemoryWatchdogLevel,
      MemorySample,
    ];
    expect(typeof latest.heapGrowthMbPerHour).toBe('number');
    expect(latest.trendWindowMinutes).toBeGreaterThanOrEqual(30);

    stop();
  });
});

describe('heapGrowthMbPerHour', () => {
  const HOUR = 3_600_000;

  /** `count` readings evenly spaced across `spanMs`, valued by `valueAt`. */
  function series(
    count: number,
    spanMs: number,
    valueAt: (i: number) => number,
  ): Array<{ atMs: number; heapUsedMb: number }> {
    const step = spanMs / (count - 1);
    return Array.from({ length: count }, (_, i) => ({ atMs: i * step, heapUsedMb: valueAt(i) }));
  }

  it('returns null below MIN_TREND_SAMPLES readings', () => {
    const points = series(MIN_TREND_SAMPLES - 1, 2 * HOUR, (i) => 100 + i);
    expect(heapGrowthMbPerHour(points)).toBeNull();
  });

  it('returns null when the readings span less than MIN_TREND_SPAN_MS', () => {
    // Plenty of readings, but only a five-minute window — the span guard is
    // what stops a GC sawtooth from being reported as a steep leak.
    const points = series(20, MIN_TREND_SPAN_MS - 1000, (i) => 500 + i * 10);
    expect(heapGrowthMbPerHour(points)).toBeNull();
  });

  it('measures a steady climb in MB/hour', () => {
    // +100 MB over 2 hours, sampled every 15 minutes → 50 MB/h.
    const points = series(9, 2 * HOUR, (i) => 500 + i * 12.5);
    expect(heapGrowthMbPerHour(points)).toBeCloseTo(50, 1);
  });

  it('reports a near-flat slope for a bounded GC sawtooth over a full window', () => {
    // Oscillates around a flat mean: over the module's one-hour window the
    // alternation regresses to a few MB/h, well under any real leak rate.
    const points = series(60, HOUR, (i) => 800 + (i % 2 === 0 ? -40 : 40));
    expect(Math.abs(heapGrowthMbPerHour(points)!)).toBeLessThan(10);
  });

  it('reports a negative slope when the heap is shrinking', () => {
    const points = series(6, 2.5 * HOUR, (i) => 1000 - i * 100);
    expect(heapGrowthMbPerHour(points)!).toBeLessThan(0);
  });

  it('returns null when every reading shares one instant (no time span)', () => {
    const points = Array.from({ length: 6 }, () => ({ atMs: 1000, heapUsedMb: 500 }));
    expect(heapGrowthMbPerHour(points)).toBeNull();
  });
});
