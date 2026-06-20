/**
 * Unit tests for computeQueueBackoffMs (backoff.util.ts)
 *
 * Covers: monotonic growth with increasing n, capping at maxMs,
 * equal-jitter bounds (rand=0 → exp/2, rand=1 → exp),
 * and Retry-After acting as a floor.
 */

import { computeQueueBackoffMs } from './backoff.util';

const BASE = 1_000;  // 1 s
const MAX  = 60_000; // 60 s

describe('computeQueueBackoffMs', () => {

  // -------------------------------------------------------------------------
  // Equal-jitter bounds
  // -------------------------------------------------------------------------

  describe('equal-jitter bounds', () => {
    it('returns exp/2 when rand=0 (lower bound of equal jitter)', () => {
      // n=1 → exp = min(60000, 1000*2^0) = 1000
      // half = 500; jittered = 500 + 0*500 = 500
      const result = computeQueueBackoffMs(1, { baseMs: BASE, maxMs: MAX }, () => 0);
      expect(result).toBe(500);
    });

    it('returns exp when rand=1 (upper bound of equal jitter)', () => {
      // n=1 → exp=1000; jittered = 500 + 1*500 = 1000
      const result = computeQueueBackoffMs(1, { baseMs: BASE, maxMs: MAX }, () => 1);
      expect(result).toBe(1000);
    });

    it('rand=0 lower bound at n=2', () => {
      // n=2 → exp = min(60000, 1000*2) = 2000; half=1000; jittered=1000
      const result = computeQueueBackoffMs(2, { baseMs: BASE, maxMs: MAX }, () => 0);
      expect(result).toBe(1000);
    });

    it('rand=1 upper bound at n=2', () => {
      // n=2 → exp=2000; jittered = 1000 + 1*1000 = 2000
      const result = computeQueueBackoffMs(2, { baseMs: BASE, maxMs: MAX }, () => 1);
      expect(result).toBe(2000);
    });

    it('rand=0.5 returns midpoint', () => {
      // n=1 → exp=1000; half=500; jittered = 500 + 0.5*500 = 750
      const result = computeQueueBackoffMs(1, { baseMs: BASE, maxMs: MAX }, () => 0.5);
      expect(result).toBe(750);
    });
  });

  // -------------------------------------------------------------------------
  // Monotonic growth with n (rand fixed at 0 to get lower bound)
  // -------------------------------------------------------------------------

  describe('monotonic growth', () => {
    it('delay increases with each successive n value (rand fixed at 0)', () => {
      const delays = [1, 2, 3, 4, 5].map(
        (n) => computeQueueBackoffMs(n, { baseMs: BASE, maxMs: MAX }, () => 0),
      );
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });

    it('delay at n=3 is greater than delay at n=1 (rand=0)', () => {
      const d1 = computeQueueBackoffMs(1, { baseMs: BASE, maxMs: MAX }, () => 0);
      const d3 = computeQueueBackoffMs(3, { baseMs: BASE, maxMs: MAX }, () => 0);
      expect(d3).toBeGreaterThan(d1);
    });
  });

  // -------------------------------------------------------------------------
  // Cap at maxMs
  // -------------------------------------------------------------------------

  describe('cap at maxMs', () => {
    it('result never exceeds maxMs regardless of n', () => {
      for (const n of [1, 5, 10, 20, 100]) {
        const result = computeQueueBackoffMs(n, { baseMs: BASE, maxMs: MAX }, () => 1);
        expect(result).toBeLessThanOrEqual(MAX);
      }
    });

    it('result equals maxMs when exp is already at maxMs and rand=1', () => {
      // baseMs=1, maxMs=2 → for large n, exp=2; rand=1 → 1 + 1*1 = 2
      const result = computeQueueBackoffMs(100, { baseMs: 1, maxMs: 2 }, () => 1);
      expect(result).toBe(2);
    });

    it('lower-bound (rand=0) at max cap equals maxMs/2', () => {
      const result = computeQueueBackoffMs(100, { baseMs: 1, maxMs: 2 }, () => 0);
      expect(result).toBe(1); // maxMs/2
    });
  });

  // -------------------------------------------------------------------------
  // Retry-After acts as a floor
  // -------------------------------------------------------------------------

  describe('retryAfterMs floor', () => {
    it('returns retryAfterMs when jitter is lower than the Retry-After value', () => {
      // n=1, rand=0 → jitter = 500. retryAfterMs=10000 → floor=10000 → 10000
      const result = computeQueueBackoffMs(
        1,
        { baseMs: BASE, maxMs: MAX, retryAfterMs: 10_000 },
        () => 0,
      );
      expect(result).toBe(10_000);
    });

    it('returns jitter when it already exceeds retryAfterMs', () => {
      // n=1, rand=1 → jitter=1000. retryAfterMs=100 → floor=100; max(100,1000)=1000
      const result = computeQueueBackoffMs(
        1,
        { baseMs: BASE, maxMs: MAX, retryAfterMs: 100 },
        () => 1,
      );
      expect(result).toBe(1000);
    });

    it('null retryAfterMs has no effect (no floor applied)', () => {
      const withNull = computeQueueBackoffMs(
        1,
        { baseMs: BASE, maxMs: MAX, retryAfterMs: null },
        () => 0,
      );
      const withUndefined = computeQueueBackoffMs(
        1,
        { baseMs: BASE, maxMs: MAX },
        () => 0,
      );
      expect(withNull).toBe(500);
      expect(withUndefined).toBe(500);
    });

    it('retryAfterMs=0 is treated as no floor (zero)', () => {
      // retryAfterMs=0 → floor condition: 0 > 0 is false → no floor
      const result = computeQueueBackoffMs(
        1,
        { baseMs: BASE, maxMs: MAX, retryAfterMs: 0 },
        () => 0,
      );
      expect(result).toBe(500);
    });

    it('returns at least retryAfterMs even when maxMs is lower than retryAfterMs', () => {
      // maxMs=100, retryAfterMs=200 → exp=min(100,100)=100; half=50; jitter<=100 < 200 → 200
      const result = computeQueueBackoffMs(
        10,
        { baseMs: 10, maxMs: 100, retryAfterMs: 200 },
        () => 0,
      );
      expect(result).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Result is always non-negative
  // -------------------------------------------------------------------------

  describe('non-negative output', () => {
    it('returns a non-negative value for any rand output', () => {
      const result = computeQueueBackoffMs(1, { baseMs: 0, maxMs: 0 }, () => 0);
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });
});
