import { BadRequestException } from '@nestjs/common';

import {
  assertSupportedTimeZone,
  civilPartsInZone,
  isSupportedTimeZone,
  startOfDayInZone,
  wallClockToUtc,
  zoneOffsetMs,
} from './zone.util';

describe('isSupportedTimeZone', () => {
  it('accepts UTC', () => {
    // Load-bearing: Intl.supportedValuesOf('timeZone') OMITS 'UTC' on Node 22,
    // so a naive `.includes()` would reject the single most common zone — and
    // `databaseBackup.timezone`'s own default value.
    expect(isSupportedTimeZone('UTC')).toBe(true);
  });

  it('accepts a real IANA zone', () => {
    expect(isSupportedTimeZone('America/Costa_Rica')).toBe(true);
    expect(isSupportedTimeZone('Pacific/Apia')).toBe(true);
  });

  it('rejects Etc/Unknown', () => {
    expect(isSupportedTimeZone('Etc/Unknown')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isSupportedTimeZone('')).toBe(false);
  });

  it('rejects a made-up zone', () => {
    expect(isSupportedTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('assertSupportedTimeZone', () => {
  it('passes for a known zone', () => {
    expect(() => assertSupportedTimeZone('UTC')).not.toThrow();
    expect(() => assertSupportedTimeZone('America/Costa_Rica')).not.toThrow();
  });

  it('throws BadRequestException for an unknown zone', () => {
    expect(() => assertSupportedTimeZone('Mars/Olympus')).toThrow(
      BadRequestException,
    );
    expect(() => assertSupportedTimeZone('Etc/Unknown')).toThrow(
      BadRequestException,
    );
  });
});

describe('civilPartsInZone', () => {
  it('reads the civil parts of an instant in a UTC-6 zone', () => {
    const parts = civilPartsInZone(
      new Date('2026-08-09T02:30:15.000Z'),
      'America/Costa_Rica',
    );
    // 02:30 UTC is 20:30 the PREVIOUS day at UTC-06:00.
    expect(parts).toEqual({
      year: 2026,
      month: 8,
      day: 8,
      hour: 20,
      minute: 30,
      second: 15,
    });
  });

  it('reads the civil parts of an instant in a UTC+13 zone', () => {
    const parts = civilPartsInZone(
      new Date('2026-01-01T22:00:00.000Z'),
      'Pacific/Apia',
    );
    // Apia is UTC+13 in January — 22:00 UTC is 11:00 the NEXT day.
    expect(parts).toEqual({
      year: 2026,
      month: 1,
      day: 2,
      hour: 11,
      minute: 0,
      second: 0,
    });
  });

  it('normalizes a midnight rendered as hour 24 to hour 0', () => {
    const parts = civilPartsInZone(new Date('2026-08-09T00:00:00.000Z'), 'UTC');
    expect(parts.hour).toBe(0);
    expect(parts.day).toBe(9);
  });
});

describe('zoneOffsetMs', () => {
  it('is zero for UTC', () => {
    expect(zoneOffsetMs(new Date('2026-08-09T12:00:00.000Z'), 'UTC')).toBe(0);
  });

  it('is negative six hours for a UTC-6 zone', () => {
    expect(
      zoneOffsetMs(new Date('2026-08-09T12:00:00.000Z'), 'America/Costa_Rica'),
    ).toBe(-6 * 3600 * 1000);
  });
});

describe('wallClockToUtc', () => {
  it('round-trips a UTC wall clock unchanged', () => {
    expect(wallClockToUtc(2026, 8, 9, 2, 0, 'UTC').toISOString()).toBe(
      '2026-08-09T02:00:00.000Z',
    );
  });

  it('resolves a wall clock in a fixed-offset zone', () => {
    // 02:00 at UTC-06:00 is 08:00 UTC.
    expect(
      wallClockToUtc(2026, 8, 9, 2, 0, 'America/Costa_Rica').toISOString(),
    ).toBe('2026-08-09T08:00:00.000Z');
  });

  it('picks the correct offset on each side of a DST spring-forward boundary', () => {
    // US DST 2026 begins 08 March at 02:00 local. New York is UTC-5 before,
    // UTC-4 after — the two-pass fixed point has to read the offset at the
    // CORRECTED instant, not at the naive guess, to get both of these right.
    expect(
      wallClockToUtc(2026, 3, 8, 1, 0, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T06:00:00.000Z'); // EST, UTC-5
    expect(
      wallClockToUtc(2026, 3, 8, 4, 0, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T08:00:00.000Z'); // EDT, UTC-4
  });

  it('resolves a nonexistent spring-forward wall clock to a real instant rather than throwing', () => {
    // 02:30 on 08 March 2026 does not exist in New York — the clock jumps
    // 02:00 EST -> 03:00 EDT. The two-pass fixed point cannot converge on a
    // time that has no instant, so it settles adjacent to the gap. That is the
    // documented, deliberate degradation (see wallClockToUtc's comment): an
    // approximate answer beats throwing.
    const resolved = wallClockToUtc(2026, 3, 8, 2, 30, 'America/New_York');
    expect(resolved.toISOString()).toBe('2026-03-08T06:30:00.000Z');

    // It is a REAL instant on the intended day, adjacent to the gap — here the
    // last EST half hour before it (01:30 local).
    const parts = civilPartsInZone(resolved, 'America/New_York');
    expect(parts.day).toBe(8);
    expect(Math.abs(resolved.getTime() - Date.UTC(2026, 2, 8, 7, 0, 0))).toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
  });

  it('resolves correctly across a fall-back boundary', () => {
    // US DST 2026 ends 01 November at 02:00 local; 00:30 is still EDT (UTC-4).
    expect(
      wallClockToUtc(2026, 11, 1, 0, 30, 'America/New_York').toISOString(),
    ).toBe('2026-11-01T04:30:00.000Z');
  });
});

describe('startOfDayInZone', () => {
  it('is the same instant for a UTC instant in UTC', () => {
    expect(
      startOfDayInZone(new Date('2026-08-09T13:45:00.000Z'), 'UTC').toISOString(),
    ).toBe('2026-08-09T00:00:00.000Z');
  });

  it('uses the civil day of a UTC-6 zone, not the UTC day', () => {
    // 02:30 UTC on the 9th is still the 8th in Costa Rica, whose day started at
    // 06:00 UTC on the 8th.
    expect(
      startOfDayInZone(
        new Date('2026-08-09T02:30:00.000Z'),
        'America/Costa_Rica',
      ).toISOString(),
    ).toBe('2026-08-08T06:00:00.000Z');
  });

  it('uses the civil day of a UTC+13 zone, not the UTC day', () => {
    // 22:00 UTC on 01 Jan is already the 2nd in Apia, whose day started at
    // 11:00 UTC on the 1st.
    expect(
      startOfDayInZone(
        new Date('2026-01-01T22:00:00.000Z'),
        'Pacific/Apia',
      ).toISOString(),
    ).toBe('2026-01-01T11:00:00.000Z');
  });

  it('is idempotent — the start of a day is in that same day', () => {
    const start = startOfDayInZone(
      new Date('2026-08-09T02:30:00.000Z'),
      'America/Costa_Rica',
    );
    expect(
      startOfDayInZone(start, 'America/Costa_Rica').toISOString(),
    ).toBe(start.toISOString());
  });

  it('handles a DST spring-forward day without throwing', () => {
    // New York's transition is at 02:00, so midnight itself exists here; the
    // guarantee under test is only that the result is a real instant on the day.
    const start = startOfDayInZone(
      new Date('2026-03-08T18:00:00.000Z'),
      'America/New_York',
    );
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(civilPartsInZone(start, 'America/New_York').day).toBe(8);
  });
});
