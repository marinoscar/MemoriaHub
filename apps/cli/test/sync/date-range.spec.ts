/**
 * test/sync/date-range.spec.ts
 *
 * Unit tests for sync/date-range.ts — the pure --from/--to parsing and
 * human-readable description helpers used by the sync command and the
 * DateRangeFilter TUI screen.
 *
 * No DB, no fs, no mocking — plain function-in/value-out assertions. Local
 * day-edge expectations are built with `new Date(y, m-1, d, ...)` so the test
 * is timezone-independent (matches whatever TZ the test runner happens to be
 * in, the same way the implementation does).
 */

import { parseDateRange, describeRange } from '../../src/sync/date-range.js';

describe('parseDateRange', () => {
  describe('bare YYYY-MM-DD inputs', () => {
    it('parses a bare --from date to local start-of-day (00:00:00.000)', () => {
      const { fromMs } = parseDateRange('2023-06-15', undefined);
      const expected = new Date(2023, 5, 15, 0, 0, 0, 0).getTime();
      expect(fromMs).toBe(expected);
    });

    it('parses a bare --to date to local end-of-day (23:59:59.999)', () => {
      const { toMs } = parseDateRange(undefined, '2023-06-15');
      const expected = new Date(2023, 5, 15, 23, 59, 59, 999).getTime();
      expect(toMs).toBe(expected);
    });

    it('parses matching --from/--to on the same day to the full day window', () => {
      const { fromMs, toMs } = parseDateRange('2023-06-15', '2023-06-15');
      expect(fromMs).toBe(new Date(2023, 5, 15, 0, 0, 0, 0).getTime());
      expect(toMs).toBe(new Date(2023, 5, 15, 23, 59, 59, 999).getTime());
    });
  });

  describe('one-sided bounds', () => {
    it('leaves toMs undefined when only --from is supplied', () => {
      const r = parseDateRange('2023-01-01', undefined);
      expect(r.fromMs).toBeDefined();
      expect(r.toMs).toBeUndefined();
    });

    it('leaves fromMs undefined when only --to is supplied', () => {
      const r = parseDateRange(undefined, '2023-01-31');
      expect(r.toMs).toBeDefined();
      expect(r.fromMs).toBeUndefined();
    });
  });

  describe('unbounded / empty input', () => {
    it('returns an empty range when both are undefined', () => {
      expect(parseDateRange(undefined, undefined)).toEqual({});
    });

    it('treats empty strings as omitted', () => {
      expect(parseDateRange('', '')).toEqual({});
    });

    it('treats whitespace-only strings as omitted', () => {
      expect(parseDateRange('   ', '\t\n ')).toEqual({});
    });

    it('trims surrounding whitespace around a valid date', () => {
      const { fromMs } = parseDateRange('  2023-06-15  ', undefined);
      expect(fromMs).toBe(new Date(2023, 5, 15, 0, 0, 0, 0).getTime());
    });
  });

  describe('full ISO 8601 datetimes', () => {
    it('parses a full ISO datetime for --from as-is (not snapped to a day edge)', () => {
      const iso = '2023-06-15T10:30:00.000Z';
      const { fromMs } = parseDateRange(iso, undefined);
      expect(fromMs).toBe(Date.parse(iso));
    });

    it('parses a full ISO datetime for --to as-is', () => {
      const iso = '2023-06-15T10:30:00.000Z';
      const { toMs } = parseDateRange(undefined, iso);
      expect(toMs).toBe(Date.parse(iso));
    });
  });

  describe('validation', () => {
    it('throws when --from is after --to', () => {
      expect(() => parseDateRange('2023-06-16', '2023-06-15')).toThrow(
        '--from must be on or before --to',
      );
    });

    it('does not throw when --from equals --to', () => {
      expect(() => parseDateRange('2023-06-15', '2023-06-15')).not.toThrow();
    });

    it('throws a helpful error for an unparseable --from string', () => {
      expect(() => parseDateRange('not-a-date', undefined)).toThrow(
        /Invalid --from date: "not-a-date"/,
      );
    });

    it('throws a helpful error for an unparseable --to string', () => {
      expect(() => parseDateRange(undefined, 'garbage')).toThrow(
        /Invalid --to date: "garbage"/,
      );
    });
  });
});

describe('describeRange', () => {
  it('returns "all dates" when both bounds are unbounded', () => {
    const r = parseDateRange(undefined, undefined);
    expect(describeRange(r)).toBe('all dates');
  });

  it('returns "A → B" when both bounds are set', () => {
    const r = parseDateRange('2023-01-01', '2023-01-31');
    expect(describeRange(r)).toBe('2023-01-01 → 2023-01-31');
  });

  it('returns "on/after A" when only fromMs is set', () => {
    const r = parseDateRange('2023-01-01', undefined);
    expect(describeRange(r)).toBe('on/after 2023-01-01');
  });

  it('returns "on/before B" when only toMs is set', () => {
    const r = parseDateRange(undefined, '2023-01-31');
    expect(describeRange(r)).toBe('on/before 2023-01-31');
  });

  it('formats a full ISO datetime bound down to its local calendar day', () => {
    // describeRange formats via ymdLocal(), which only shows the day —
    // a datetime bound should round-trip to the same YYYY-MM-DD.
    const r = parseDateRange('2023-06-15T23:00:00.000', undefined);
    expect(describeRange(r)).toBe('on/after 2023-06-15');
  });
});
