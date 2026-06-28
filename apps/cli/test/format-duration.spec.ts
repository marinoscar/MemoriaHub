/**
 * test/format-duration.spec.ts — Unit tests for formatDuration.
 *
 * Verifies each output branch:
 *   - null / undefined / negative → "—"
 *   - < 1000ms  → "Nms"
 *   - < 60 000ms → "Ns"
 *   - < 3 600 000ms → "Nm Xs"  (or "Nm" when sec=0)
 *   - < 86 400 000ms → "Nh Xm"  (or "Nh" when min=0)
 *   - ≥ 86 400 000ms → "Nd Xh"  (or "Nd" when hour=0)
 *
 * No mocking needed — pure function.
 */

import { jest } from '@jest/globals';
import { formatDuration } from '../src/format-duration.js';

describe('formatDuration', () => {

  // =========================================================================
  // Null / undefined / negative
  // =========================================================================

  describe('null / undefined / negative', () => {
    it('returns "—" for null', () => {
      expect(formatDuration(null)).toBe('—');
    });

    it('returns "—" for undefined', () => {
      expect(formatDuration(undefined)).toBe('—');
    });

    it('returns "—" for negative values', () => {
      expect(formatDuration(-1)).toBe('—');
    });

    it('returns "—" for large negative values', () => {
      expect(formatDuration(-99999)).toBe('—');
    });
  });

  // =========================================================================
  // Sub-second (< 1000ms)
  // =========================================================================

  describe('< 1000ms — milliseconds', () => {
    it('returns "0ms" for 0', () => {
      expect(formatDuration(0)).toBe('0ms');
    });

    it('returns "1ms" for 1', () => {
      expect(formatDuration(1)).toBe('1ms');
    });

    it('returns "450ms" for 450', () => {
      expect(formatDuration(450)).toBe('450ms');
    });

    it('returns "999ms" for 999', () => {
      expect(formatDuration(999)).toBe('999ms');
    });

    it('rounds ms (0.6 → 1ms)', () => {
      expect(formatDuration(0.6)).toBe('1ms');
    });
  });

  // =========================================================================
  // Seconds (1000ms ≤ ms < 60 000ms)
  // =========================================================================

  describe('1000ms–59999ms — seconds', () => {
    it('returns "1s" for 1000', () => {
      expect(formatDuration(1000)).toBe('1s');
    });

    it('returns "45s" for 45 000', () => {
      expect(formatDuration(45_000)).toBe('45s');
    });

    it('returns "59s" for 59 000', () => {
      expect(formatDuration(59_000)).toBe('59s');
    });

    it('returns "1s" for 1500 (floors)', () => {
      expect(formatDuration(1500)).toBe('1s');
    });
  });

  // =========================================================================
  // Minutes + seconds (60 000ms ≤ ms < 3 600 000ms)
  // =========================================================================

  describe('60 000ms–3 599 999ms — minutes and seconds', () => {
    it('returns "1m" for exactly 60 000ms (no trailing 0s)', () => {
      expect(formatDuration(60_000)).toBe('1m');
    });

    it('returns "1m 30s" for 90 000', () => {
      expect(formatDuration(90_000)).toBe('1m 30s');
    });

    it('returns "3m 12s" for 192 000', () => {
      expect(formatDuration(192_000)).toBe('3m 12s');
    });

    it('returns "59m 59s" for 3 599 000', () => {
      expect(formatDuration(3_599_000)).toBe('59m 59s');
    });

    it('returns "5m" for 300 000 (no trailing 0s)', () => {
      expect(formatDuration(300_000)).toBe('5m');
    });
  });

  // =========================================================================
  // Hours + minutes (3 600 000ms ≤ ms < 86 400 000ms)
  // =========================================================================

  describe('3 600 000ms–86 399 999ms — hours and minutes', () => {
    it('returns "1h" for exactly 3 600 000ms (no trailing 0m)', () => {
      expect(formatDuration(3_600_000)).toBe('1h');
    });

    it('returns "2h 5m" for 7 500 000', () => {
      expect(formatDuration(7_500_000)).toBe('2h 5m');
    });

    it('returns "1h 30m" for 5 400 000', () => {
      expect(formatDuration(5_400_000)).toBe('1h 30m');
    });

    it('returns "23h 59m" for 86 340 000', () => {
      expect(formatDuration(86_340_000)).toBe('23h 59m');
    });

    it('returns "3h" for 10 800 000 (no trailing 0m)', () => {
      expect(formatDuration(10_800_000)).toBe('3h');
    });
  });

  // =========================================================================
  // Days + hours (≥ 86 400 000ms)
  // =========================================================================

  describe('≥ 86 400 000ms — days and hours', () => {
    it('returns "1d" for exactly 86 400 000ms (no trailing 0h)', () => {
      expect(formatDuration(86_400_000)).toBe('1d');
    });

    it('returns "1d 3h" for 97 200 000', () => {
      expect(formatDuration(97_200_000)).toBe('1d 3h');
    });

    it('returns "7d" for 604 800 000 (no trailing 0h)', () => {
      expect(formatDuration(604_800_000)).toBe('7d');
    });

    it('returns "2d 12h" for 2*86400000 + 12*3600000', () => {
      expect(formatDuration(2 * 86_400_000 + 12 * 3_600_000)).toBe('2d 12h');
    });

    it('returns "30d" for 30 days exactly', () => {
      expect(formatDuration(30 * 86_400_000)).toBe('30d');
    });
  });
});

// Suppress unused import warning
void jest;
