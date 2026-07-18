/**
 * Unit tests for the 5-field cron validator used to gate `trigger='scheduled'`
 * workflows (issue #139), plus Phase 4's pure date-math helpers (issue #142):
 * `nextCronDate` (next fire strictly after a given instant) and
 * `cronMinIntervalMinutes` (minimum gap between consecutive fires, used to
 * enforce `workflows.scheduleMinIntervalMinutes`). All pure functions, no I/O.
 */
import { cronMinIntervalMinutes, isValidCron, nextCronDate } from './cron.util';

describe('isValidCron', () => {
  describe('valid expressions', () => {
    it('accepts every-field wildcard "* * * * *"', () => {
      expect(isValidCron('* * * * *')).toBe(true);
    });

    it('accepts midnight daily "0 0 * * *"', () => {
      expect(isValidCron('0 0 * * *')).toBe(true);
    });

    it('accepts a step expression "*/5 * * * *"', () => {
      expect(isValidCron('*/5 * * * *')).toBe(true);
    });

    it('accepts a range expression "0 9-17 * * *"', () => {
      expect(isValidCron('0 9-17 * * *')).toBe(true);
    });

    it('accepts a comma list "0,30 8-17 * * 1-5"', () => {
      expect(isValidCron('0,30 8-17 * * 1-5')).toBe(true);
    });

    it('accepts a stepped range "0 0 1-30/5 * *"', () => {
      expect(isValidCron('0 0 1-30/5 * *')).toBe(true);
    });

    it('accepts day-of-week 0 and 7 (both mean Sunday)', () => {
      expect(isValidCron('0 0 * * 0')).toBe(true);
      expect(isValidCron('0 0 * * 7')).toBe(true);
    });

    it('accepts boundary values for every field', () => {
      // minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-7
      expect(isValidCron('59 23 31 12 7')).toBe(true);
      expect(isValidCron('0 0 1 1 0')).toBe(true);
    });

    it('tolerates extra internal whitespace between fields', () => {
      expect(isValidCron('0   0  *  *   *')).toBe(true);
    });

    it('tolerates leading/trailing whitespace', () => {
      expect(isValidCron('  0 0 * * *  ')).toBe(true);
    });
  });

  describe('malformed expressions', () => {
    it('rejects too few fields', () => {
      expect(isValidCron('0 0 * *')).toBe(false);
    });

    it('rejects too many fields', () => {
      expect(isValidCron('0 0 * * * *')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isValidCron('')).toBe(false);
    });

    it('rejects a non-string input', () => {
      expect(isValidCron(null as unknown as string)).toBe(false);
      expect(isValidCron(undefined as unknown as string)).toBe(false);
      expect(isValidCron(42 as unknown as string)).toBe(false);
    });

    it('rejects an out-of-range minute (60)', () => {
      expect(isValidCron('60 0 * * *')).toBe(false);
    });

    it('rejects an out-of-range hour (24)', () => {
      expect(isValidCron('0 24 * * *')).toBe(false);
    });

    it('rejects an out-of-range day-of-month (0)', () => {
      expect(isValidCron('0 0 0 * *')).toBe(false);
    });

    it('rejects an out-of-range day-of-month (32)', () => {
      expect(isValidCron('0 0 32 * *')).toBe(false);
    });

    it('rejects an out-of-range month (0)', () => {
      expect(isValidCron('0 0 * 0 *')).toBe(false);
    });

    it('rejects an out-of-range month (13)', () => {
      expect(isValidCron('0 0 * 13 *')).toBe(false);
    });

    it('rejects an out-of-range day-of-week (8)', () => {
      expect(isValidCron('0 0 * * 8')).toBe(false);
    });

    it('rejects a non-numeric token', () => {
      expect(isValidCron('a 0 * * *')).toBe(false);
    });

    it('rejects a malformed range (inverted lo > hi)', () => {
      expect(isValidCron('0 17-9 * * *')).toBe(false);
    });

    it('rejects a step of zero', () => {
      expect(isValidCron('*/0 * * * *')).toBe(false);
    });

    it('rejects a negative step', () => {
      expect(isValidCron('*/-5 * * * *')).toBe(false);
    });

    it('rejects an empty comma-list segment', () => {
      expect(isValidCron('0,,30 * * * *')).toBe(false);
    });

    it('rejects a non-numeric step', () => {
      expect(isValidCron('*/x * * * *')).toBe(false);
    });
  });
});

describe('nextCronDate', () => {
  // "0 0 * * *" fires at LOCAL midnight (nextCronDate resolves cron fields
  // against the process's system timezone -- see the "Timezone: server-local"
  // note in the Phase 4 issue). `from`/the expected fire are built from LOCAL
  // date components (`new Date(y, m, d, ...)`), not literal UTC ISO strings,
  // so this assertion holds on any host timezone rather than only on a
  // UTC-configured one.
  it('returns the next daily fire strictly after "from" (exact-match instant advances to the FOLLOWING day)', () => {
    const from = new Date(2026, 0, 1, 0, 0, 0, 0); // local midnight, Jan 1 2026
    const next = nextCronDate('0 0 * * *', from);
    const expected = new Date(2026, 0, 2, 0, 0, 0, 0); // local midnight, Jan 2 2026
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('returns the next daily fire when "from" is one second past the previous fire', () => {
    const from = new Date(2026, 0, 1, 0, 0, 1, 0); // one second past local midnight, Jan 1
    const next = nextCronDate('0 0 * * *', from);
    const expected = new Date(2026, 0, 2, 0, 0, 0, 0); // local midnight, Jan 2 2026
    expect(next.getTime()).toBe(expected.getTime());
  });

  it('resolves the next fire of a step expression', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const next = nextCronDate('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });

  it('resolves the next fire of a comma-list expression', () => {
    const from = new Date('2026-01-01T00:10:00.000Z');
    const next = nextCronDate('0,30 * * * *', from);
    expect(next.toISOString()).toBe('2026-01-01T00:30:00.000Z');
  });

  it('always returns a Date strictly after "from" (never equal, never before)', () => {
    const from = new Date('2026-03-15T12:34:56.000Z');
    const next = nextCronDate('* * * * *', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('cronMinIntervalMinutes', () => {
  it('reports 5 minutes for a "*/5 * * * *" step expression', () => {
    expect(cronMinIntervalMinutes('*/5 * * * *')).toBe(5);
  });

  it('reports 60 minutes for an hourly expression', () => {
    expect(cronMinIntervalMinutes('0 * * * *')).toBe(60);
  });

  it('reports 1440 minutes (24h) for a once-daily expression', () => {
    expect(cronMinIntervalMinutes('0 0 * * *')).toBe(1440);
  });

  it('catches a dense comma-list gap even though most gaps in the day are large', () => {
    // "0,30 * * * *" fires at :00 and :30 every hour: the tight 30-minute gap
    // must win over the (also-present) same-hour-to-next-hour gaps.
    expect(cronMinIntervalMinutes('0,30 * * * *')).toBe(30);
  });

  it('reports 60 minutes for a business-hours-only hourly schedule (large overnight gap does not win)', () => {
    // "0 9-17 * * *" fires hourly 9am-5pm then jumps ~16h overnight; the
    // minimum (not average) gap must be the 60-minute intra-window gap.
    expect(cronMinIntervalMinutes('0 9-17 * * *')).toBe(60);
  });
});
