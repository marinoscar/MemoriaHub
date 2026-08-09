/**
 * Unit tests for the calendar period algebra (issue #305).
 *
 * Everything here is pure UTC date arithmetic, and almost all of it is about
 * one edge: northern-hemisphere winter spans a year boundary, so the "season
 * year" and the calendar year of a season's own photos legitimately disagree
 * for three months out of twelve. That is exactly the kind of rule that is
 * easier to get subtly wrong than to test, so it is tested directly rather than
 * through a database fixture.
 */

import {
  enumerateSeasons,
  monthBucket,
  mostRecentCompletedSeason,
  previousSeason,
  seasonFromOrdinal,
  seasonOf,
  seasonOrdinal,
  seasonPeriodKey,
  seasonWindow,
  utcYear,
  yearBucket,
  yearWindow,
} from './period-windows';

describe('yearWindow', () => {
  it('is a half-open [Jan 1, next Jan 1) UTC range', () => {
    const window = yearWindow(2025);
    expect(window.start.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(window.endExclusive.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('excludes the very first instant of the next year', () => {
    const { endExclusive } = yearWindow(2025);
    // The exclusivity is what keeps a New Year's Eve midnight photo out of the
    // wrong year's memory — an inclusive bound would put it in both.
    expect(utcYear(new Date(endExclusive.getTime() - 1))).toBe(2025);
    expect(utcYear(endExclusive)).toBe(2026);
  });
});

describe('bucket keys', () => {
  it('yearBucket is the UTC calendar year', () => {
    expect(yearBucket(new Date(Date.UTC(2016, 11, 31, 23, 59, 59)))).toBe(2016);
    expect(yearBucket(new Date(Date.UTC(2017, 0, 1, 0, 0, 0)))).toBe(2017);
  });

  it('monthBucket is year-qualified, so the same month of two years never merges', () => {
    const jan2024 = monthBucket(new Date(Date.UTC(2024, 0, 15)));
    const jan2025 = monthBucket(new Date(Date.UTC(2025, 0, 15)));
    expect(jan2024).not.toBe(jan2025);
    // Twelve buckets apart: consecutive months are consecutive keys, which is
    // what makes `countInWindow`'s range sum valid.
    expect(jan2025 - jan2024).toBe(12);
    expect(monthBucket(new Date(Date.UTC(2024, 1, 1))) - jan2024).toBe(1);
  });
});

describe('seasonOf', () => {
  it.each([
    ['2025-03-01', 2025, 'spring'],
    ['2025-05-31', 2025, 'spring'],
    ['2025-06-01', 2025, 'summer'],
    ['2025-08-31', 2025, 'summer'],
    ['2025-09-01', 2025, 'fall'],
    ['2025-11-30', 2025, 'fall'],
    ['2025-12-01', 2025, 'winter'],
  ])('maps %s to %s-%s', (iso, year, season) => {
    expect(seasonOf(new Date(`${iso}T12:00:00.000Z`))).toEqual({ year, season });
  });

  it('folds January and February back into the PREVIOUS December winter', () => {
    // The whole reason a season carries its own year: without this, "Winter
    // 2025" would be two disjoint memories — December 2025 and Jan/Feb 2025 —
    // neither of which is a winter.
    expect(seasonOf(new Date('2026-01-15T00:00:00.000Z'))).toEqual({
      year: 2025,
      season: 'winter',
    });
    expect(seasonOf(new Date('2026-02-28T23:59:59.000Z'))).toEqual({
      year: 2025,
      season: 'winter',
    });
  });
});

describe('seasonOrdinal / previousSeason', () => {
  it('orders seasons chronologically within a season year (spring first, winter last)', () => {
    const spring = seasonOrdinal({ year: 2025, season: 'spring' });
    const summer = seasonOrdinal({ year: 2025, season: 'summer' });
    const fall = seasonOrdinal({ year: 2025, season: 'fall' });
    const winter = seasonOrdinal({ year: 2025, season: 'winter' });
    expect([spring, summer, fall, winter]).toEqual([...[spring, summer, fall, winter]].sort((a, b) => a - b));
  });

  it('steps winter Y back to fall Y, not to fall Y-1', () => {
    // Winter 2025 starts in December 2025, so the season before it is fall
    // 2025 (Sep–Nov 2025). Ordering winter first inside its year would skip a
    // whole year here — the bug this ordinal exists to prevent.
    expect(previousSeason({ year: 2025, season: 'winter' })).toEqual({
      year: 2025,
      season: 'fall',
    });
  });

  it('steps spring Y back across the year boundary to winter Y-1', () => {
    expect(previousSeason({ year: 2026, season: 'spring' })).toEqual({
      year: 2025,
      season: 'winter',
    });
  });

  it('round-trips through seasonFromOrdinal', () => {
    for (const season of ['spring', 'summer', 'fall', 'winter'] as const) {
      const period = { year: 2025, season };
      expect(seasonFromOrdinal(seasonOrdinal(period))).toEqual(period);
    }
  });
});

describe('seasonWindow', () => {
  it('covers exactly three months', () => {
    expect(seasonWindow({ year: 2025, season: 'summer' })).toEqual({
      start: new Date('2025-06-01T00:00:00.000Z'),
      endExclusive: new Date('2025-09-01T00:00:00.000Z'),
    });
  });

  it('carries winter across the year boundary', () => {
    expect(seasonWindow({ year: 2025, season: 'winter' })).toEqual({
      start: new Date('2025-12-01T00:00:00.000Z'),
      endExclusive: new Date('2026-03-01T00:00:00.000Z'),
    });
  });

  it('agrees with seasonOf for every day it contains', () => {
    // The two are used at opposite ends of the curator (window selects the
    // items, seasonOf derives the period from a date), so a disagreement would
    // silently file photos under a season whose window excludes them.
    const period = { year: 2025, season: 'winter' } as const;
    const { start, endExclusive } = seasonWindow(period);
    for (let t = start.getTime(); t < endExclusive.getTime(); t += 86_400_000 * 7) {
      expect(seasonOf(new Date(t))).toEqual(period);
    }
  });
});

describe('mostRecentCompletedSeason', () => {
  it('excludes the season currently in progress', () => {
    // August 9 is inside summer 2026; the most recent COMPLETE season is the
    // spring that ended on May 31.
    expect(mostRecentCompletedSeason(new Date('2026-08-09T12:00:00.000Z'))).toEqual({
      year: 2026,
      season: 'spring',
    });
  });

  it('returns fall Y-1 in the middle of winter', () => {
    expect(mostRecentCompletedSeason(new Date('2026-01-15T00:00:00.000Z'))).toEqual({
      year: 2025,
      season: 'fall',
    });
  });

  it('returns fall the moment winter begins on December 1', () => {
    expect(mostRecentCompletedSeason(new Date('2025-12-01T00:00:00.000Z'))).toEqual({
      year: 2025,
      season: 'fall',
    });
  });
});

describe('enumerateSeasons', () => {
  it('is contiguous and chronological across a year boundary', () => {
    const seasons = enumerateSeasons(
      { year: 2024, season: 'fall' },
      { year: 2025, season: 'summer' },
    );
    expect(seasons.map(seasonPeriodKey)).toEqual([
      '2024-fall',
      '2024-winter',
      '2025-spring',
      '2025-summer',
    ]);
  });

  it('returns a single season when from equals to', () => {
    expect(
      enumerateSeasons({ year: 2025, season: 'summer' }, { year: 2025, season: 'summer' }),
    ).toEqual([{ year: 2025, season: 'summer' }]);
  });

  it('returns empty when the range is inverted', () => {
    // The circle whose only photos are inside the still-running season: its
    // earliest season is AFTER the most recently completed one, and it must
    // produce nothing rather than a backwards sweep.
    expect(
      enumerateSeasons({ year: 2026, season: 'summer' }, { year: 2026, season: 'spring' }),
    ).toEqual([]);
  });
});

describe('seasonPeriodKey', () => {
  it('is the year the season STARTS in, matching the MemoryType enum contract', () => {
    expect(seasonPeriodKey({ year: 2025, season: 'winter' })).toBe('2025-winter');
  });
});
