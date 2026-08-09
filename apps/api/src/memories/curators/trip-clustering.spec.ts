// =============================================================================
// Memories — Trips clustering algebra (epic #300, issue #304)
// =============================================================================
//
// Pure unit tests: no database, no Nest, no clock. Everything here is a
// statement about the ALGORITHM — the 30% home-share floor, median-based day
// classification, gap tolerance, and the overlap denominator that keeps a
// boundary-shifted trip from becoming a duplicate memory.
//
// The DB-backed half (does a seeded away cluster actually become one `trip` row,
// does the tombstone hold when boundaries shift) lives in
// test/memories/memories-trips.integration.spec.ts, because those are statements
// about rows and SQL that a mock could only restate.
// =============================================================================

import {
  ClassifiedDay,
  DayAggregate,
  HOME_MIN_SHARE,
  MS_PER_DAY,
  accumulateHomeSample,
  classifyDay,
  createDayAggregate,
  createHomeStats,
  dayIndexToKey,
  dayRangeOverlapRatio,
  dominantPlace,
  inferHome,
  matchRunsToExisting,
  median,
  mergeAwayRuns,
  modalKey,
  slugifyPlace,
  tally,
  toDayIndex,
} from './trip-clustering';

/** San José, Costa Rica — "home" for every fixture below. */
const HOME = { lat: 9.9281, lng: -84.0907 };
/** Tamarindo, Guanacaste — ~180 km away, comfortably past the 50 km default. */
const AWAY = { lat: 10.2993, lng: -85.8371 };

const DAY0 = toDayIndex(new Date(Date.UTC(2023, 2, 12)));

function day(
  offset: number,
  options: {
    coords?: Array<{ lat: number; lng: number }>;
    photoCount?: number;
    locality?: string;
    admin1?: string;
    country?: string;
  } = {},
): DayAggregate {
  const agg = createDayAggregate(DAY0 + offset);
  const coords = options.coords ?? [];
  for (const c of coords) {
    agg.lats.push(c.lat);
    agg.lngs.push(c.lng);
  }
  agg.photoCount = options.photoCount ?? Math.max(coords.length, 0);
  for (let i = 0; i < Math.max(agg.photoCount, 1); i += 1) {
    tally(agg.localityCounts, options.locality);
    tally(agg.admin1Counts, options.admin1);
    tally(agg.countryCounts, options.country);
  }
  return agg;
}

/** N photos at one place, enough to clear MIN_DAY_PHOTOS. */
function at(point: { lat: number; lng: number }, count = 4): Array<{ lat: number; lng: number }> {
  return Array.from({ length: count }, () => ({ ...point }));
}

function classifyAll(days: DayAggregate[], minDistanceKm = 50): ClassifiedDay[] {
  const home = { level: 'locality' as const, label: 'San José', admin1: 'San José', ...HOME, share: 1, sampleCount: 100 };
  return days.map((d) => classifyDay(d, home, minDistanceKm));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

describe('day index helpers', () => {
  it('maps an instant to its UTC calendar day and back', () => {
    expect(dayIndexToKey(toDayIndex(new Date(Date.UTC(2023, 2, 12, 23, 59, 59))))).toBe('2023-03-12');
    expect(dayIndexToKey(toDayIndex(new Date(Date.UTC(2023, 2, 13, 0, 0, 0))))).toBe('2023-03-13');
  });

  it('is exactly one index per calendar day', () => {
    const a = toDayIndex(new Date(Date.UTC(2023, 2, 12, 5)));
    const b = toDayIndex(new Date(Date.UTC(2023, 2, 15, 5)));
    expect(b - a).toBe(3);
    expect(b * MS_PER_DAY - a * MS_PER_DAY).toBe(3 * MS_PER_DAY);
  });
});

describe('median', () => {
  it('returns null for an empty sample', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle value of an odd sample', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('takes the LOWER middle of an even sample rather than the mean', () => {
    // A value an item actually reported beats an average that may sit in the
    // sea between two islands.
    expect(median([10, 20])).toBe(10);
  });

  it('ignores a single wild outlier', () => {
    expect(median([9.9, 9.9, 9.9, 9.9, -70])).toBe(9.9);
  });
});

describe('modalKey', () => {
  it('returns null for an empty tally', () => {
    expect(modalKey(new Map())).toBeNull();
  });

  it('breaks ties alphabetically so a run is reproducible', () => {
    expect(modalKey(new Map([['Zurich', 2], ['Aarau', 2]]))).toBe('Aarau');
  });
});

describe('slugifyPlace', () => {
  it('ASCII-folds accents so a re-geocode cannot mint a duplicate identity', () => {
    expect(slugifyPlace('San José')).toBe('san-jose');
    expect(slugifyPlace('Zürich')).toBe('zurich');
  });

  it('collapses punctuation and trims dashes', () => {
    expect(slugifyPlace('  Playa   Tamarindo, CR ')).toBe('playa-tamarindo-cr');
  });

  it('maps an absent place to the empty subjectKey', () => {
    expect(slugifyPlace(null)).toBe('');
    expect(slugifyPlace('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Home inference
// ---------------------------------------------------------------------------

describe('inferHome', () => {
  function stats(samples: Array<{ lat: number; lng: number; locality: string | null; admin1: string | null }>) {
    const s = createHomeStats();
    for (const sample of samples) {
      accumulateHomeSample(s, {
        lat: sample.lat,
        lng: sample.lng,
        geoLocality: sample.locality,
        geoAdmin1: sample.admin1,
      });
    }
    return s;
  }

  it('returns null when the circle has no geocoded items at all', () => {
    expect(inferHome(createHomeStats())).toBeNull();
  });

  it('picks the modal locality and its centroid', () => {
    const s = stats([
      ...Array.from({ length: 7 }, () => ({ ...HOME, locality: 'San José', admin1: 'San José' })),
      ...Array.from({ length: 3 }, () => ({ ...AWAY, locality: 'Tamarindo', admin1: 'Guanacaste' })),
    ]);

    const home = inferHome(s);

    expect(home).not.toBeNull();
    expect(home!.level).toBe('locality');
    expect(home!.label).toBe('San José');
    expect(home!.admin1).toBe('San José');
    expect(home!.share).toBeCloseTo(0.7, 5);
    expect(home!.lat).toBeCloseTo(HOME.lat, 5);
    expect(home!.lng).toBeCloseTo(HOME.lng, 5);
  });

  it('refuses to name a home when the modal locality is below the 30% share floor', () => {
    // A travel-only archive: nowhere is a center of gravity, and calling the
    // biggest minority "home" would report every other day as a trip.
    const s = stats([
      ...Array.from({ length: 3 }, () => ({ ...HOME, locality: 'A', admin1: 'RA' })),
      ...Array.from({ length: 3 }, () => ({ ...AWAY, locality: 'B', admin1: 'RB' })),
      ...Array.from({ length: 3 }, () => ({ ...AWAY, locality: 'C', admin1: 'RC' })),
      ...Array.from({ length: 2 }, () => ({ ...AWAY, locality: 'D', admin1: 'RD' })),
    ]);

    expect(inferHome(s)).toBeNull();
  });

  it('falls back to admin1 when localities are sparse but the region is obvious', () => {
    // Offline reverse geocoding often resolves a region and not a town: home is
    // unmistakable one level up, so reporting "unknown" would be wrong.
    const s = stats([
      ...Array.from({ length: 8 }, () => ({ ...HOME, locality: null, admin1: 'San José' })),
      ...Array.from({ length: 2 }, () => ({ ...AWAY, locality: null, admin1: 'Guanacaste' })),
    ]);

    const home = inferHome(s);

    expect(home!.level).toBe('admin1');
    expect(home!.label).toBe('San José');
    expect(home!.admin1).toBe('San José');
  });

  it('applies the SAME floor to the admin1 fallback', () => {
    const s = stats([
      ...Array.from({ length: 2 }, () => ({ ...HOME, locality: null, admin1: 'A' })),
      ...Array.from({ length: 2 }, () => ({ ...AWAY, locality: null, admin1: 'B' })),
      ...Array.from({ length: 2 }, () => ({ ...AWAY, locality: null, admin1: 'C' })),
      ...Array.from({ length: 2 }, () => ({ ...AWAY, locality: null, admin1: 'D' })),
      ...Array.from({ length: 1 }, () => ({ ...AWAY, locality: null, admin1: 'E' })),
    ]);

    expect(inferHome(s, HOME_MIN_SHARE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Day classification
// ---------------------------------------------------------------------------

describe('classifyDay', () => {
  it('classifies a far-away day with enough photos as away', () => {
    const [d] = classifyAll([day(0, { coords: at(AWAY) })]);
    expect(d!.dayClass).toBe('away');
    expect(d!.distanceKm).toBeGreaterThan(150);
  });

  it('classifies a nearby day with enough photos as home', () => {
    const [d] = classifyAll([day(0, { coords: at(HOME) })]);
    expect(d!.dayClass).toBe('home');
    expect(d!.distanceKm).toBeLessThan(1);
  });

  it('leaves a thin day neutral even when it is far away', () => {
    // One airport-layover photo must not open a trip.
    const [d] = classifyAll([day(0, { coords: at(AWAY, 1) })]);
    expect(d!.dayClass).toBe('neutral');
    expect(d!.distanceKm).toBeGreaterThan(150);
  });

  it('leaves a thin day neutral even when it is at home, so it cannot close a trip', () => {
    const [d] = classifyAll([day(0, { coords: at(HOME, 2) })]);
    expect(d!.dayClass).toBe('neutral');
  });

  it('honours minDistanceKm', () => {
    const days = [day(0, { coords: at(AWAY) })];
    expect(classifyAll(days, 50)[0]!.dayClass).toBe('away');
    // Raise the threshold past the actual distance and the same day is home.
    expect(classifyAll(days, 500)[0]!.dayClass).toBe('home');
  });

  it('uses the metadata fallback when a day has no coordinates but a differing admin1', () => {
    const [d] = classifyAll([day(0, { photoCount: 5, admin1: 'Guanacaste' })]);
    expect(d!.dayClass).toBe('away');
    expect(d!.distanceKm).toBeNull();
  });

  it('never classifies a coordinate-less day as home — only away or neutral', () => {
    // A matching region is weak evidence (adjacent regions are minutes apart),
    // so the fallback can only ever ADD an away day.
    const [same] = classifyAll([day(0, { photoCount: 5, admin1: 'San José' })]);
    expect(same!.dayClass).toBe('neutral');

    const [none] = classifyAll([day(0, { photoCount: 5 })]);
    expect(none!.dayClass).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Run assembly
// ---------------------------------------------------------------------------

describe('mergeAwayRuns', () => {
  it('merges consecutive away days into one run', () => {
    const runs = mergeAwayRuns(
      classifyAll([0, 1, 2, 3, 4].map((i) => day(i, { coords: at(AWAY) }))),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.startDayIndex).toBe(DAY0);
    expect(runs[0]!.endDayIndex).toBe(DAY0 + 4);
    expect(runs[0]!.spanDays).toBe(5);
    expect(runs[0]!.photoCount).toBe(20);
    expect(runs[0]!.maxDistanceKm).toBeGreaterThan(150);
  });

  it('a one-day photo gap mid-trip does NOT split the trip', () => {
    // Day 2 simply has no photos — a day you did not take pictures, not the end.
    const runs = mergeAwayRuns(
      classifyAll([0, 1, 3, 4].map((i) => day(i, { coords: at(AWAY) }))),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.spanDays).toBe(5);
  });

  it('a two-day gap DOES split the trip', () => {
    const runs = mergeAwayRuns(
      classifyAll([0, 1, 4, 5].map((i) => day(i, { coords: at(AWAY) }))),
    );

    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.spanDays)).toEqual([2, 2]);
  });

  it('a neutral day inside the tolerance bridges, a home day terminates', () => {
    const bridged = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY) }),
        day(1, { coords: at(AWAY, 1) }), // thin ⇒ neutral
        day(2, { coords: at(AWAY) }),
      ]),
    );
    expect(bridged).toHaveLength(1);

    const split = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY) }),
        day(1, { coords: at(HOME) }), // positive evidence the trip ended
        day(2, { coords: at(AWAY) }),
      ]),
    );
    expect(split).toHaveLength(2);
  });

  it('trims neutral edges: a run starts and ends on an away day', () => {
    const runs = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY, 1) }), // neutral
        day(1, { coords: at(AWAY) }),
        day(2, { coords: at(AWAY) }),
        day(3, { coords: at(AWAY, 1) }), // neutral
      ]),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.startDayIndex).toBe(DAY0 + 1);
    expect(runs[0]!.endDayIndex).toBe(DAY0 + 2);
  });

  it('keeps two trips three weeks apart separate', () => {
    const runs = mergeAwayRuns(
      classifyAll([0, 1, 2, 21, 22, 23].map((i) => day(i, { coords: at(AWAY) }))),
    );

    expect(runs).toHaveLength(2);
    expect(runs[0]!.startDayIndex).toBe(DAY0);
    expect(runs[1]!.startDayIndex).toBe(DAY0 + 21);
  });

  it('produces nothing when the circle never left home', () => {
    expect(mergeAwayRuns(classifyAll([0, 1, 2, 3].map((i) => day(i, { coords: at(HOME) }))))).toEqual(
      [],
    );
  });

  it("includes a bridged gap day's own photos in the run's counts", () => {
    const runs = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY) }),
        day(1, { coords: at(AWAY, 1) }), // neutral, but still 1 candidate
        day(2, { coords: at(AWAY) }),
      ]),
    );

    expect(runs[0]!.days).toHaveLength(3);
    expect(runs[0]!.photoCount).toBe(9);
  });
});

describe('dominantPlace', () => {
  it('prefers locality, then admin1, then country', () => {
    const withLocality = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY), locality: 'Tamarindo', admin1: 'Guanacaste', country: 'Costa Rica' }),
        day(1, { coords: at(AWAY), locality: 'Nosara', admin1: 'Guanacaste', country: 'Costa Rica' }),
        day(2, { coords: at(AWAY), locality: 'Tamarindo', admin1: 'Guanacaste', country: 'Costa Rica' }),
      ]),
    )[0]!;
    expect(dominantPlace(withLocality).place).toBe('Tamarindo');

    const admin1Only = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY), admin1: 'Guanacaste', country: 'Costa Rica' }),
        day(1, { coords: at(AWAY), admin1: 'Guanacaste', country: 'Costa Rica' }),
      ]),
    )[0]!;
    expect(dominantPlace(admin1Only).place).toBe('Guanacaste');

    const countryOnly = mergeAwayRuns(
      classifyAll([
        day(0, { coords: at(AWAY), country: 'Costa Rica' }),
        day(1, { coords: at(AWAY), country: 'Costa Rica' }),
      ]),
    )[0]!;
    expect(dominantPlace(countryOnly).place).toBe('Costa Rica');
  });

  it('reports a null place when nothing was reverse-geocoded', () => {
    const run = mergeAwayRuns(classifyAll([day(0, { coords: at(AWAY) }), day(1, { coords: at(AWAY) })]))[0]!;
    expect(dominantPlace(run).place).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refresh matching
// ---------------------------------------------------------------------------

describe('dayRangeOverlapRatio', () => {
  const range = (start: number, end: number) => ({ startDayIndex: start, endDayIndex: end });

  it('is 0 for disjoint ranges', () => {
    expect(dayRangeOverlapRatio(range(0, 2), range(10, 12))).toBe(0);
  });

  it('is 0 for adjacent-but-not-overlapping ranges', () => {
    expect(dayRangeOverlapRatio(range(0, 2), range(3, 5))).toBe(0);
  });

  it('is 1 for identical ranges', () => {
    expect(dayRangeOverlapRatio(range(0, 4), range(0, 4))).toBe(1);
  });

  it('scores a boundary EXTENSION as a full match — the whole point of the denominator', () => {
    // Late uploads grow a 3-day trip into a 10-day one. Jaccard would score this
    // 3/10 = 0.3 and mint a duplicate memory; min-span scores 1.0 and refreshes.
    expect(dayRangeOverlapRatio(range(0, 2), range(0, 9))).toBe(1);
  });

  it('scores a half-shifted window at exactly the match threshold', () => {
    // [0..3] vs [2..5]: overlap 2 days, shorter span 4 ⇒ 0.5.
    expect(dayRangeOverlapRatio(range(0, 3), range(2, 5))).toBe(0.5);
  });

  it('falls below the threshold when only one day of four lines up', () => {
    expect(dayRangeOverlapRatio(range(0, 3), range(3, 6))).toBeCloseTo(0.25, 5);
  });
});

describe('matchRunsToExisting', () => {
  const run = (start: number, end: number) => ({ startDayIndex: start, endDayIndex: end });
  const trip = (id: string, start: number, end: number, tombstoned = false) => ({
    id,
    periodKey: dayIndexToKey(start),
    subjectKey: 'somewhere',
    startDayIndex: start,
    endDayIndex: end,
    tombstoned,
  });

  it('matches a shifted run to its existing memory', () => {
    const r = run(100, 106);
    const existing = trip('m1', 102, 108);

    expect(matchRunsToExisting([r], [existing]).get(r)).toBe(existing);
  });

  it('leaves a genuinely new trip unmatched', () => {
    const r = run(200, 204);
    expect(matchRunsToExisting([r], [trip('m1', 100, 104)]).size).toBe(0);
  });

  it('matches a TOMBSTONED memory too, so a deleted trip stays deleted when boundaries shift', () => {
    const r = run(100, 106);
    const dead = trip('m1', 101, 105, true);

    expect(matchRunsToExisting([r], [dead]).get(r)).toBe(dead);
  });

  it('never pairs one memory with two runs, or one run with two memories', () => {
    const near = run(100, 109);
    const far = run(104, 113);
    const existing = trip('m1', 100, 109);

    const matched = matchRunsToExisting([near, far], [existing]);

    expect(matched.size).toBe(1);
    // The better fit (a perfect overlap) wins over chronological order.
    expect(matched.get(near)).toBe(existing);
    expect(matched.has(far)).toBe(false);
  });

  it('is deterministic when two memories fit a run equally well', () => {
    const r = run(100, 103);
    const a = trip('aaaa', 100, 103);
    const b = trip('bbbb', 100, 103);

    expect(matchRunsToExisting([r], [a, b]).get(r)).toBe(a);
    expect(matchRunsToExisting([r], [b, a]).get(r)).toBe(a);
  });
});
