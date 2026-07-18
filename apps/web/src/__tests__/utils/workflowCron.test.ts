/**
 * Unit tests for workflowCron.ts (issue #141 — Workflows Phase 3 web UI).
 *
 * `isValidCron` enforces standard 5-field cron syntax PLUS an hourly floor:
 * the minute field must be a single fixed integer (no wildcard, step, list,
 * or range), so nothing runs more often than once an hour.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidCron,
  CRON_PRESETS,
  CRON_MIN_INTERVAL_HINT,
} from '../../utils/workflowCron';

describe('isValidCron', () => {
  describe('valid expressions', () => {
    it('accepts a plain daily expression', () => {
      expect(isValidCron('0 3 * * *')).toBe(true);
    });

    it('accepts a weekly expression with a day-of-week', () => {
      expect(isValidCron('0 4 * * 0')).toBe(true);
    });

    it('accepts a monthly expression with a day-of-month', () => {
      expect(isValidCron('0 5 1 * *')).toBe(true);
    });

    it('accepts a range in the day-of-month field', () => {
      expect(isValidCron('0 6 1-15 * *')).toBe(true);
    });

    it('accepts a list in the month field', () => {
      expect(isValidCron('0 6 1 1,6,12 *')).toBe(true);
    });

    it('accepts a step in a non-minute field', () => {
      expect(isValidCron('0 */2 * * *')).toBe(true);
    });

    it('accepts day-of-week 7 (alternate Sunday)', () => {
      expect(isValidCron('0 4 * * 7')).toBe(true);
    });

    it('tolerates surrounding whitespace and multi-space separators', () => {
      expect(isValidCron('  0   3  *  *  *  ')).toBe(true);
    });
  });

  describe('invalid expressions — hourly floor', () => {
    it('rejects a wildcard minute field (would run every minute)', () => {
      expect(isValidCron('* * * * *')).toBe(false);
    });

    it('rejects a step minute field (sub-hourly)', () => {
      expect(isValidCron('*/15 * * * *')).toBe(false);
    });

    it('rejects a list minute field', () => {
      expect(isValidCron('0,30 * * * *')).toBe(false);
    });

    it('rejects a range minute field', () => {
      expect(isValidCron('0-30 * * * *')).toBe(false);
    });
  });

  describe('invalid expressions — malformed', () => {
    it('rejects the wrong number of fields', () => {
      expect(isValidCron('0 3 * *')).toBe(false);
      expect(isValidCron('0 3 * * * *')).toBe(false);
    });

    it('rejects an out-of-range hour', () => {
      expect(isValidCron('0 24 * * *')).toBe(false);
    });

    it('rejects an out-of-range day-of-month', () => {
      expect(isValidCron('0 3 32 * *')).toBe(false);
      expect(isValidCron('0 3 0 * *')).toBe(false);
    });

    it('rejects an out-of-range month', () => {
      expect(isValidCron('0 3 1 13 *')).toBe(false);
    });

    it('rejects an out-of-range day-of-week', () => {
      expect(isValidCron('0 3 * * 8')).toBe(false);
    });

    it('rejects a non-numeric field', () => {
      expect(isValidCron('0 abc * * *')).toBe(false);
    });

    it('rejects an inverted range (a > b)', () => {
      expect(isValidCron('0 3 20-10 * *')).toBe(false);
    });

    it('rejects a non-positive step value', () => {
      expect(isValidCron('0 */0 * * *')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isValidCron('')).toBe(false);
    });

    it('rejects non-string input defensively', () => {
      // @ts-expect-error — deliberately passing a non-string to verify the
      // runtime guard, since callers may pass an untyped form value.
      expect(isValidCron(null)).toBe(false);
      // @ts-expect-error — same as above.
      expect(isValidCron(undefined)).toBe(false);
    });
  });
});

describe('CRON_PRESETS', () => {
  it('exposes exactly the nightly / weekly / monthly presets', () => {
    expect(CRON_PRESETS).toHaveLength(3);
    expect(CRON_PRESETS.map((p) => p.id)).toEqual(['nightly', 'weekly', 'monthly']);
  });

  it('every preset expression is itself valid under isValidCron', () => {
    for (const preset of CRON_PRESETS) {
      expect(isValidCron(preset.expression)).toBe(true);
    }
  });
});

describe('CRON_MIN_INTERVAL_HINT', () => {
  it('is a non-empty explanatory string', () => {
    expect(typeof CRON_MIN_INTERVAL_HINT).toBe('string');
    expect(CRON_MIN_INTERVAL_HINT.length).toBeGreaterThan(0);
    expect(CRON_MIN_INTERVAL_HINT.toLowerCase()).toContain('hour');
  });
});
