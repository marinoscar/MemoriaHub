// =============================================================================
// Memories — Trips: home inference and away-day clustering (epic #300, #304)
// =============================================================================
//
// Every decision the Trips curator makes, as pure functions over plain data:
// no Prisma, no Nest, no clock. The curator (trip.curator.ts) does the I/O —
// streams rows into `DayAggregate`s, then hands them here and writes whatever
// comes back. That split is what makes the interesting behavior (gap tolerance,
// the 30% home-share floor, overlap-based refresh matching) testable with object
// literals instead of a seeded database.
//
// WHY DAY RUNS AND NOT GEO-CLUSTERING. A DBSCAN/HDBSCAN pass over coordinates
// would be the textbook answer and is the wrong one here: it clusters *places*,
// while a trip is a contiguous stretch of *time* spent away — two separate
// visits to the same beach a year apart are two trips, and one road trip across
// four towns is one. Day-run merging models that directly, is explainable to a
// user ("you were away from March 12 to March 17"), matches how Apple's Trips
// behave, and adds no dependency. See docs/specs/memories.md §4.8.
// =============================================================================

import { haversineKm } from '../../common/geo/haversine.util';

export const MS_PER_DAY = 86_400_000;

/**
 * Fixed 24-month window for home inference, deliberately NOT a setting.
 *
 * Home is a slow-moving fact about a family, and `memories.trips.lookbackMonths`
 * (default 18) answers a different question — "how far back do we look for
 * trips?". Tying home to it would mean an admin narrowing the trip window to 3
 * months silently re-infers home from one quarter's photos, which is exactly
 * when a long vacation can outvote the house. Two years is long enough that no
 * single trip can be modal and short enough to follow a real relocation.
 */
export const HOME_WINDOW_MONTHS = 24;

/**
 * Minimum share of geocoded items the modal place must hold to count as home.
 *
 * Below this the library has no center of gravity (a travel-only archive, a
 * shared circle spanning three countries), and *every* day would read as "away
 * from" a place that is not home — producing a wall of bogus trips. Skipping
 * the circle entirely is the correct answer, and it is the epic's stated
 * failure-mode behavior for "no geo data".
 */
export const HOME_MIN_SHARE = 0.3;

/** Minimum candidate photos on a day before it can be classified at all. */
export const MIN_DAY_PHOTOS = 3;

/**
 * Gap days tolerated inside one trip. A single photo-less (or unclassifiable)
 * day in the middle of a week away is a day you did not take pictures, not the
 * end of the trip.
 */
export const MAX_GAP_DAYS = 1;

/**
 * Day-range overlap at or above which a re-detected trip is considered THE SAME
 * trip as an existing memory. See `dayRangeOverlapRatio` for the denominator
 * choice, which is the load-bearing part.
 */
export const TRIP_OVERLAP_MATCH_RATIO = 0.5;

/** Title place-name of last resort, when a trip has coordinates but no geocode. */
export const UNKNOWN_TRIP_PLACE = 'a new place';

// ---------------------------------------------------------------------------
// Day aggregation
// ---------------------------------------------------------------------------

/**
 * Everything one calendar day contributes, accumulated as rows stream past.
 *
 * Media-item IDs are deliberately NOT retained: the curator re-selects a trip's
 * items through `MemoryCurationService.curate()` with a date-range `where` once
 * the run has qualified, so holding tens of thousands of ids through the scan
 * would be memory spent on a set that is thrown away for every day that turns
 * out to be at home.
 */
export interface DayAggregate {
  /** `YYYY-MM-DD`, UTC. */
  dayKey: string;
  /** Whole days since the epoch — the integer the run merger actually walks. */
  dayIndex: number;
  /** Candidate photos/videos captured on this day (with or without coordinates). */
  photoCount: number;
  /** Latitudes of this day's coordinate-bearing items. */
  lats: number[];
  /** Longitudes, index-aligned with `lats`. */
  lngs: number[];
  localityCounts: Map<string, number>;
  admin1Counts: Map<string, number>;
  countryCounts: Map<string, number>;
}

/** UTC midnight day index (days since epoch) for an instant. */
export function toDayIndex(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

/** `YYYY-MM-DD` for a day index. */
export function dayIndexToKey(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}

/** UTC midnight `Date` for a day index. */
export function dayIndexToDate(dayIndex: number): Date {
  return new Date(dayIndex * MS_PER_DAY);
}

export function createDayAggregate(dayIndex: number): DayAggregate {
  return {
    dayKey: dayIndexToKey(dayIndex),
    dayIndex,
    photoCount: 0,
    lats: [],
    lngs: [],
    localityCounts: new Map(),
    admin1Counts: new Map(),
    countryCounts: new Map(),
  };
}

/** Increment a string tally, ignoring null/blank values. */
export function tally(counts: Map<string, number>, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
}

/** The most frequent key, ties broken alphabetically so runs are reproducible. */
export function modalKey(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Sum several tallies into one (used to fold a run's days together). */
export function mergeCounts(sources: Iterable<Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const source of sources) {
    for (const [key, count] of source) out.set(key, (out.get(key) ?? 0) + count);
  }
  return out;
}

/**
 * Median of a numeric sample. Even-length samples take the lower of the two
 * middle values rather than their mean — a coordinate that an item actually
 * reported is a better representative than an average of two, which can land in
 * the sea between two islands.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

// ---------------------------------------------------------------------------
// Home inference
// ---------------------------------------------------------------------------

/** Running totals for one candidate home place. */
export interface HomePlaceStats {
  count: number;
  latSum: number;
  lngSum: number;
}

/** Everything the 24-month scan accumulates for home inference. */
export interface HomeStats {
  /** Geocoded (coordinate-bearing) items seen in the window. */
  geocodedCount: number;
  byLocality: Map<string, HomePlaceStats>;
  byAdmin1: Map<string, HomePlaceStats>;
  /** Modal admin1 observed for each locality — the home admin1 for the fallback. */
  admin1ByLocality: Map<string, Map<string, number>>;
}

export function createHomeStats(): HomeStats {
  return {
    geocodedCount: 0,
    byLocality: new Map(),
    byAdmin1: new Map(),
    admin1ByLocality: new Map(),
  };
}

function accumulatePlace(
  map: Map<string, HomePlaceStats>,
  key: string | null | undefined,
  lat: number,
  lng: number,
): void {
  const trimmed = key?.trim();
  if (!trimmed) return;
  const stats = map.get(trimmed) ?? { count: 0, latSum: 0, lngSum: 0 };
  stats.count += 1;
  stats.latSum += lat;
  stats.lngSum += lng;
  map.set(trimmed, stats);
}

/** Fold one coordinate-bearing item into the home statistics. */
export function accumulateHomeSample(
  stats: HomeStats,
  sample: {
    lat: number;
    lng: number;
    geoLocality: string | null;
    geoAdmin1: string | null;
  },
): void {
  stats.geocodedCount += 1;
  accumulatePlace(stats.byLocality, sample.geoLocality, sample.lat, sample.lng);
  accumulatePlace(stats.byAdmin1, sample.geoAdmin1, sample.lat, sample.lng);

  const locality = sample.geoLocality?.trim();
  if (locality) {
    const admin1s = stats.admin1ByLocality.get(locality) ?? new Map<string, number>();
    tally(admin1s, sample.geoAdmin1);
    stats.admin1ByLocality.set(locality, admin1s);
  }
}

/** The inferred home of a circle. */
export interface HomeLocation {
  /** Which column the inference landed on. */
  level: 'locality' | 'admin1';
  /** The place name itself (`geoLocality` or `geoAdmin1` value). */
  label: string;
  /** Home's admin1, used by the no-coordinate metadata fallback. Null when unknown. */
  admin1: string | null;
  /** Centroid — mean lat/lng of the items in the modal place. */
  lat: number;
  lng: number;
  /** Share of geocoded items the modal place holds, in [0,1]. */
  share: number;
  /** Items backing the centroid. */
  sampleCount: number;
}

/**
 * Infer a circle's home, or return null when the library has no center of
 * gravity.
 *
 * Locality first, admin1 as the fallback: `geoLocality` is the level a person
 * would name ("Escazú"), but it is also the level most likely to be sparse —
 * offline reverse geocoding can resolve a region and not a town, and a rural
 * library may have `geoAdmin1` on nearly everything and `geoLocality` on almost
 * nothing. Trying locality alone would then report "home unknown" for a circle
 * whose home is perfectly obvious one level up.
 *
 * The admin1 fallback intentionally reuses the SAME share floor rather than a
 * looser one: a coarser geography is easier to be modal in, so if it cannot even
 * clear 30% there is genuinely no home here.
 */
export function inferHome(stats: HomeStats, minShare = HOME_MIN_SHARE): HomeLocation | null {
  if (stats.geocodedCount === 0) return null;

  const pick = (
    map: Map<string, HomePlaceStats>,
    level: 'locality' | 'admin1',
  ): HomeLocation | null => {
    let bestKey: string | null = null;
    let best: HomePlaceStats | null = null;
    for (const [key, place] of map) {
      if (
        best === null ||
        place.count > best.count ||
        (place.count === best.count && bestKey !== null && key < bestKey)
      ) {
        bestKey = key;
        best = place;
      }
    }
    if (!bestKey || !best) return null;

    const share = best.count / stats.geocodedCount;
    if (share < minShare) return null;

    return {
      level,
      label: bestKey,
      admin1:
        level === 'admin1'
          ? bestKey
          : modalKey(stats.admin1ByLocality.get(bestKey) ?? new Map<string, number>()),
      lat: best.latSum / best.count,
      lng: best.lngSum / best.count,
      share,
      sampleCount: best.count,
    };
  };

  return pick(stats.byLocality, 'locality') ?? pick(stats.byAdmin1, 'admin1');
}

// ---------------------------------------------------------------------------
// Away-day classification
// ---------------------------------------------------------------------------

/**
 * - `away`    — evidence the circle was away from home this day.
 * - `home`    — evidence it was at home. TERMINATES a run outright; it is not a
 *               gap, it is a contradiction.
 * - `neutral` — not enough evidence either way. Consumes gap budget but never
 *               splits a trip on its own.
 */
export type DayClass = 'away' | 'home' | 'neutral';

export interface ClassifiedDay extends DayAggregate {
  dayClass: DayClass;
  /** Distance from home to this day's median coordinate; null with no coordinates. */
  distanceKm: number | null;
}

/**
 * Classify one day against the inferred home.
 *
 * The median (not the mean) of the day's coordinates is the representative
 * point: a single mis-geotagged frame — an iPhone that cached a stale fix, a
 * scanned photo with a manual coordinate — would drag a mean hundreds of
 * kilometers and invent a trip. The median ignores it.
 *
 * Latitude and longitude are taken independently (a "marginal median"), which is
 * not the geometric median but is O(n log n), dependency-free, and identical for
 * the compact same-day clusters this actually sees.
 *
 * KNOWN GAP: a day whose photos straddle the ±180° antimeridian gets a
 * meaningless median longitude. Documented rather than solved — see
 * docs/specs/memories.md §4.8.
 */
export function classifyDay(
  day: DayAggregate,
  home: HomeLocation,
  minDistanceKm: number,
): ClassifiedDay {
  const lat = median(day.lats);
  const lng = median(day.lngs);

  if (lat !== null && lng !== null) {
    const distanceKm = haversineKm(home.lat, home.lng, lat, lng);
    // A day too thin to be evidence stays neutral even when it is far away: one
    // photo from an airport layover should not open a trip, and one photo taken
    // at home mid-vacation should not close one.
    if (day.photoCount < MIN_DAY_PHOTOS) {
      return { ...day, dayClass: 'neutral', distanceKm };
    }
    return {
      ...day,
      dayClass: distanceKm > minDistanceKm ? 'away' : 'home',
      distanceKm,
    };
  }

  // METADATA FALLBACK — no coordinates at all today. The only signal left is the
  // reverse-geocoded region, and it can only ever ADD an away day: a matching
  // admin1 is weak evidence of home (adjacent regions are minutes apart) while a
  // differing one is strong evidence of away. So a mismatch classifies `away`
  // and everything else stays neutral, never `home`.
  if (day.photoCount >= MIN_DAY_PHOTOS && home.admin1) {
    const admin1 = modalKey(day.admin1Counts);
    if (admin1 && admin1 !== home.admin1) {
      return { ...day, dayClass: 'away', distanceKm: null };
    }
  }
  return { ...day, dayClass: 'neutral', distanceKm: null };
}

// ---------------------------------------------------------------------------
// Run assembly
// ---------------------------------------------------------------------------

/** One contiguous stretch away from home, before it is checked against minDays. */
export interface AwayRun {
  startDayIndex: number;
  endDayIndex: number;
  /** Calendar days spanned, inclusive of both ends. */
  spanDays: number;
  /** Every day in `[start, end]` that produced candidates, away or not. */
  days: ClassifiedDay[];
  /** Largest per-day distance from home across the run. Null if none had coordinates. */
  maxDistanceKm: number | null;
  /** Candidates captured across the run's days — the pre-curation floor check. */
  photoCount: number;
}

/**
 * Merge away days into runs, tolerating `maxGapDays` consecutive non-away days.
 *
 * A run is anchored on away days at BOTH ends: neutral days at the edges are
 * trimmed, so a trip never reports a start date on which nothing said "away".
 * A `home` day inside the tolerance window still terminates the run — it is
 * positive evidence that the trip ended, not merely an absence of evidence, and
 * treating it as a gap would fuse a weekend away, a week at home with one quiet
 * day, and the next weekend away into one eleven-day "trip".
 */
export function mergeAwayRuns(
  classified: ClassifiedDay[],
  maxGapDays = MAX_GAP_DAYS,
): AwayRun[] {
  const byIndex = new Map<number, ClassifiedDay>();
  for (const day of classified) byIndex.set(day.dayIndex, day);

  const awayIndices = classified
    .filter((d) => d.dayClass === 'away')
    .map((d) => d.dayIndex)
    .sort((a, b) => a - b);

  const runs: AwayRun[] = [];
  let start: number | null = null;
  let previous: number | null = null;

  const flush = (): void => {
    if (start === null || previous === null) return;
    const days: ClassifiedDay[] = [];
    for (let i = start; i <= previous; i += 1) {
      const day = byIndex.get(i);
      if (day) days.push(day);
    }
    const distances = days
      .map((d) => d.distanceKm)
      .filter((d): d is number => d !== null && Number.isFinite(d));
    runs.push({
      startDayIndex: start,
      endDayIndex: previous,
      spanDays: previous - start + 1,
      days,
      maxDistanceKm: distances.length > 0 ? Math.max(...distances) : null,
      photoCount: days.reduce((sum, d) => sum + d.photoCount, 0),
    });
    start = null;
    previous = null;
  };

  /** True when nothing between two away days contradicts them being one trip. */
  const bridgeable = (from: number, to: number): boolean => {
    const gap = to - from - 1;
    if (gap > maxGapDays) return false;
    for (let i = from + 1; i < to; i += 1) {
      if (byIndex.get(i)?.dayClass === 'home') return false;
    }
    return true;
  };

  for (const index of awayIndices) {
    if (start === null) {
      start = index;
      previous = index;
      continue;
    }
    if (bridgeable(previous!, index)) {
      previous = index;
      continue;
    }
    flush();
    start = index;
    previous = index;
  }
  flush();

  return runs;
}

/** Resolve a run's display place: locality → admin1 → country, else null. */
export function dominantPlace(run: AwayRun): {
  locality: string | null;
  admin1: string | null;
  country: string | null;
  place: string | null;
} {
  const locality = modalKey(mergeCounts(run.days.map((d) => d.localityCounts)));
  const admin1 = modalKey(mergeCounts(run.days.map((d) => d.admin1Counts)));
  const country = modalKey(mergeCounts(run.days.map((d) => d.countryCounts)));
  return { locality, admin1, country, place: locality ?? admin1 ?? country };
}

/**
 * ASCII-folded, dash-separated slug for `subjectKey`.
 *
 * NFD-decompose then strip combining marks, so "Guanacaste"/"Cartago"/"Zürich"
 * all land on stable ASCII — a subjectKey is an identity, and one that changes
 * when a reverse-geocoding provider starts returning a differently-accented
 * spelling of the same town would silently create a duplicate memory.
 */
export function slugifyPlace(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// Refresh matching
// ---------------------------------------------------------------------------

/** An inclusive day-index range. */
export interface DayRange {
  startDayIndex: number;
  endDayIndex: number;
}

/**
 * Overlap between two day ranges as a fraction of the SHORTER range.
 *
 * The denominator is the whole point. New uploads legitimately extend a trip's
 * detected boundaries — a 3-day trip becomes a 10-day one once the second
 * camera's photos are imported — and that is the same trip, refreshed, not a new
 * one. Jaccard (`overlap / union`) scores that case 3/10 = 0.30 and would create
 * a duplicate; `overlap / min(span)` scores it 1.0 and refreshes in place.
 *
 * The trade is that a short range fully contained in a much longer one always
 * matches. That is accepted: a 2-day run inside an existing 30-day trip really
 * is part of that trip.
 */
export function dayRangeOverlapRatio(a: DayRange, b: DayRange): number {
  const start = Math.max(a.startDayIndex, b.startDayIndex);
  const end = Math.min(a.endDayIndex, b.endDayIndex);
  const overlap = end - start + 1;
  if (overlap <= 0) return 0;
  const spanA = a.endDayIndex - a.startDayIndex + 1;
  const spanB = b.endDayIndex - b.startDayIndex + 1;
  const shorter = Math.min(spanA, spanB);
  return shorter <= 0 ? 0 : overlap / shorter;
}

/** An existing `trip` memory, reduced to what overlap matching needs. */
export interface ExistingTrip extends DayRange {
  id: string;
  periodKey: string;
  subjectKey: string;
  tombstoned: boolean;
}

/**
 * Greedily pair detected runs with existing trip memories by best overlap.
 *
 * Both sides are matched at most once. Pairs are considered in descending
 * overlap order rather than run order, so when boundary drift makes two runs
 * both plausible matches for one memory, the better fit wins instead of whoever
 * happened to be chronologically first.
 */
export function matchRunsToExisting<T extends DayRange>(
  runs: T[],
  existing: ExistingTrip[],
  minRatio = TRIP_OVERLAP_MATCH_RATIO,
): Map<T, ExistingTrip> {
  const pairs: Array<{ run: T; trip: ExistingTrip; ratio: number }> = [];
  for (const run of runs) {
    for (const trip of existing) {
      const ratio = dayRangeOverlapRatio(run, trip);
      if (ratio >= minRatio) pairs.push({ run, trip, ratio });
    }
  }
  // Deterministic: ratio desc, then earliest run, then memory id.
  pairs.sort(
    (x, y) =>
      y.ratio - x.ratio ||
      x.run.startDayIndex - y.run.startDayIndex ||
      (x.trip.id < y.trip.id ? -1 : x.trip.id > y.trip.id ? 1 : 0),
  );

  const matched = new Map<T, ExistingTrip>();
  const claimedRuns = new Set<T>();
  const claimedTrips = new Set<string>();
  for (const pair of pairs) {
    if (claimedRuns.has(pair.run) || claimedTrips.has(pair.trip.id)) continue;
    claimedRuns.add(pair.run);
    claimedTrips.add(pair.trip.id);
    matched.set(pair.run, pair.trip);
  }
  return matched;
}
