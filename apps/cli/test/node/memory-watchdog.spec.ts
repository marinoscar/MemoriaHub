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
 *
 * Uses Jest fake timers since the module drives its sampling via
 * setInterval. process.env['MEMORIAHUB_MEMWATCH'] is snapshotted/restored
 * around the one test that sets it, mirroring the save/restore style in
 * test/node/runtime-tuning.spec.ts.
 */

import { jest } from '@jest/globals';
import { startMemoryWatchdog } from '../../src/node/memory-watchdog.js';
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
