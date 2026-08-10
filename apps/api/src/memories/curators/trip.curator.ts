// =============================================================================
// Memories — Trips curator (epic #300, issue #304)
// =============================================================================
//
// "Trip to Guanacaste, March 2023" — the only memory type that requires real
// clustering, and the one users care about most.
//
// The library already knows where every photo was taken; what it has never had
// is a notion of HOME. Everything here follows from inferring that one fact and
// then asking, day by day, "were we away?". The decision algebra —
// home inference, median-based day classification, gap-tolerant run merging,
// overlap-based refresh matching — is pure and lives in `trip-clustering.ts`;
// this file is the I/O half: one streaming scan in, curated memories out.
//
// THREE THINGS THIS FILE IS RESPONSIBLE FOR
// -----------------------------------------
//
// 1. ONE SCAN, AGGREGATED AS IT STREAMS. A circle's whole geo history is read
//    once via keyset pagination and folded immediately into per-day aggregates
//    and home tallies. Media-item IDs are never retained: a trip's items are
//    re-selected through `MemoryCurationService.curate()` with a date-range
//    `where` only AFTER the run qualifies, so the 95% of days spent at home cost
//    two floats each instead of a resident id list. This is what keeps backfill
//    over a 70k-item library flat in memory (epic requirement).
//
// 2. GRACEFUL DEGRADATION IS THE DEFAULT PATH, NOT AN ERROR PATH. A circle with
//    no coordinates, or no place holding a >=30% share, produces zero trips and
//    returns normally — it does not throw, and it does not disturb the other six
//    curators. The epic's failure-mode matrix requires exactly this.
//
// 3. REFRESH MATCHES BY OVERLAP, NOT BY KEY. A trip's detected boundaries move
//    when new uploads land — the identity keys (`periodKey` = start date,
//    `subjectKey` = locality slug) move with them. Matching on key equality
//    would therefore mint a duplicate memory every time a late import extended a
//    trip by a day. A re-detected run is paired with the existing memory it
//    overlaps by >=50% (of the SHORTER span) and that row is re-keyed in place.
//    Tombstoned trips take part in matching too, which is what keeps a deleted
//    trip deleted when its boundaries shift.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MemoryCurationService,
  memoryCandidateBaseWhere,
} from '../curation/memory-curation.service';
import { tripTitle } from '../curation/memory-title-templates';
import {
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
  emptyCuratorResult,
} from './memory-curator.interface';
import {
  AwayRun,
  ClassifiedDay,
  DayAggregate,
  ExistingTrip,
  HOME_WINDOW_MONTHS,
  HomeLocation,
  HomeStats,
  UNKNOWN_TRIP_PLACE,
  accumulateHomeSample,
  classifyDay,
  createDayAggregate,
  createHomeStats,
  dayIndexToDate,
  dayIndexToKey,
  dominantPlace,
  inferHome,
  matchRunsToExisting,
  mergeAwayRuns,
  slugifyPlace,
  tally,
  toDayIndex,
} from './trip-clustering';

/** Rows per keyset page while streaming the geo scan. */
const SCAN_PAGE_SIZE = 1_000;

/**
 * Defensive ceiling on rows folded into one circle's scan.
 *
 * The aggregates themselves are bounded by the number of distinct days, but the
 * per-day coordinate samples that back each median are not — so the total row
 * count is the honest bound to cap. At two floats plus a handful of tallies per
 * row this is single-digit megabytes; a circle dense enough to hit it has
 * decades of history and its oldest days simply fall outside the scan.
 */
const MAX_SCAN_ROWS = 500_000;

/**
 * Ceiling on existing `trip` memories loaded for overlap matching. A circle
 * accumulates roughly one row per trip ever taken — hundreds, not thousands —
 * so this is a crash guard, and hitting it is worth a warning because matching
 * would silently degrade to "create a duplicate" for the rows left out.
 */
const MAX_EXISTING_TRIPS = 10_000;

/**
 * Exactly the columns the scan selects.
 *
 * Location Grouping (issue #374): both the canonical and the raw column are
 * selected, and every place tally below reads `canonical ?? raw`. A trip
 * spanning "Conroe", "Shenandoah" and "The Woodlands" therefore gets ONE modal
 * place and reads "The Woodlands" instead of splitting three ways and picking
 * whichever suburb happened to have the most photos.
 */
interface ScanRow {
  capturedAt: Date | null;
  takenLat: number | null;
  takenLng: number | null;
  geoLocality: string | null;
  geoAdmin1: string | null;
  geoCountry: string | null;
  geoCanonicalLocality: string | null;
  geoCanonicalAdmin1: string | null;
  geoCanonicalCountry: string | null;
  id: string;
}

/** What one streaming scan produced. */
interface ScanResult {
  home: HomeStats;
  /** Per-calendar-day aggregates inside the TRIP window (may be wider than home's). */
  days: DayAggregate[];
  truncated: boolean;
}

/** UTC instant `months` before `from`. */
export function subtractMonthsUtc(from: Date, months: number): Date {
  return new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() - months,
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

@Injectable()
export class TripCurator implements MemoryCurator {
  readonly name = 'trip';

  private readonly logger = new Logger(TripCurator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly curation: MemoryCurationService,
  ) {}

  isEnabled(settings: MemoryCuratorContext['settings']): boolean {
    return settings.trips.enabled;
  }

  async run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { minDays, minItems, minDistanceKm, lookbackMonths } = ctx.settings.trips;

    // Home is always inferred over a fixed 24 months (see HOME_WINDOW_MONTHS),
    // independent of the trip lookback. In BACKFILL mode the trip window opens
    // to all of history, so the scan starts at the earlier of the two.
    const homeWindowStart = subtractMonthsUtc(ctx.now, HOME_WINDOW_MONTHS);
    const tripWindowStart = ctx.backfill ? null : subtractMonthsUtc(ctx.now, lookbackMonths);
    const scanStart = ctx.backfill
      ? null
      : new Date(Math.min(homeWindowStart.getTime(), tripWindowStart!.getTime()));

    const scan = await this.scan(ctx.circleId, scanStart, homeWindowStart, tripWindowStart);

    const home = inferHome(scan.home);
    if (!home) {
      // THE GRACEFUL-DEGRADATION PATH. No coordinates at all, or no place with a
      // >=30% share — a travel-only archive, a circle spanning three countries,
      // or simply a library that was never reverse-geocoded. Every day would
      // read as "away from" a place that is not home, so the honest answer is
      // no trips. Debug, not warn: this is a supported configuration.
      this.logger.debug(
        `No home could be inferred for circle ${ctx.circleId} ` +
          `(${scan.home.geocodedCount} geocoded item(s) in the last ${HOME_WINDOW_MONTHS} months); ` +
          'skipping trips',
      );
      return result;
    }

    const classified: ClassifiedDay[] = scan.days.map((day) =>
      classifyDay(day, home, minDistanceKm),
    );
    const runs = mergeAwayRuns(classified);
    if (runs.length === 0) return result;

    const existing = await this.loadExistingTrips(ctx.circleId);
    const matches = matchRunsToExisting(runs, existing);

    // Chronological, so a run cut short by a job timeout has produced the oldest
    // trips consistently rather than an arbitrary subset.
    for (const run of runs) {
      // Two cheap floors before any query: a run that cannot span enough days,
      // or does not have enough raw candidates to clear `minItems` even before
      // near-duplicate collapse, is not worth curating.
      if (run.spanDays < minDays || run.photoCount < minItems) {
        result.skipped += 1;
        continue;
      }

      const outcome = await this.curateRun({
        ctx,
        run,
        home,
        match: matches.get(run) ?? null,
        existing,
      });
      result.created += outcome.created;
      result.refreshed += outcome.refreshed;
      result.skipped += outcome.skipped;
      result.tombstoned += outcome.tombstoned;
    }

    this.logger.debug(
      `Trips for circle ${ctx.circleId}: home=${home.label} (${home.level}, ` +
        `${(home.share * 100).toFixed(0)}%), ${runs.length} away run(s), ` +
        `${result.created} created / ${result.refreshed} refreshed / ` +
        `${result.skipped} skipped / ${result.tombstoned} tombstoned`,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  /**
   * One keyset-paginated pass over the circle's candidates, folded as it goes
   * into home tallies (coordinate-bearing rows in the home window) and per-day
   * aggregates (every row in the trip window).
   *
   * Both windows are served by the SAME scan because they overlap almost
   * entirely — 24 months of home against a default 18 months of trips — and two
   * passes would double the I/O to compute two projections of the same rows.
   *
   * Ordering is `(capturedAt ASC, id ASC)`, a total order under the base filter
   * (`capturedAt IS NOT NULL`), so the cursor never skips or repeats a row.
   *
   * NO NEW INDEX IS NEEDED, verified with EXPLAIN ANALYZE over a seeded 30k-item
   * circle: the existing `media_items_gallery_idx` — `(circle_id, captured_at
   * DESC, id DESC) WHERE deleted_at IS NULL AND archived_at IS NULL` — serves
   * this as an `Index Scan Backward` with NO sort node (a btree scans either
   * direction, so its DESC declaration costs nothing here), leaving only
   * `social_media_source IS NULL` as a cheap filter. See docs/specs/memories.md
   * §4.8 for the plan and for the one known cost: Prisma's OR-form keyset
   * predicate lands as a Filter rather than an Index Cond, so page N re-walks
   * the pages before it. That is inherited from `loadCandidates`, is bounded
   * (~2.5M index-entry visits over a 70k-item circle, low seconds in a daily
   * background job), and is not worth diverging into raw SQL to avoid.
   */
  private async scan(
    circleId: string,
    scanStart: Date | null,
    homeWindowStart: Date,
    tripWindowStart: Date | null,
  ): Promise<ScanResult> {
    const base = memoryCandidateBaseWhere(circleId);
    const window: Prisma.MediaItemWhereInput = scanStart
      ? { capturedAt: { gte: scanStart } }
      : {};

    const home = createHomeStats();
    const byDay = new Map<number, DayAggregate>();

    let scanned = 0;
    let truncated = false;
    let cursor: { capturedAt: Date; id: string } | null = null;

    for (;;) {
      const cursorPredicate: Prisma.MediaItemWhereInput | null = cursor
        ? {
            OR: [
              { capturedAt: { gt: cursor.capturedAt } },
              { capturedAt: cursor.capturedAt, id: { gt: cursor.id } },
            ],
          }
        : null;

      // Explicitly annotated for the same reason loadCandidates is: the page
      // `where` is built from `cursor`, which is assigned from this result — a
      // self-reference the inferencer reports as TS7022.
      const rows: ScanRow[] = await this.prisma.mediaItem.findMany({
        where: cursorPredicate
          ? { AND: [base, window, cursorPredicate] }
          : { AND: [base, window] },
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
        take: SCAN_PAGE_SIZE,
        select: {
          id: true,
          capturedAt: true,
          takenLat: true,
          takenLng: true,
          geoLocality: true,
          geoAdmin1: true,
          geoCountry: true,
          geoCanonicalLocality: true,
          geoCanonicalAdmin1: true,
          geoCanonicalCountry: true,
        },
      });
      if (rows.length === 0) break;

      const last = rows[rows.length - 1]!;
      cursor = { capturedAt: last.capturedAt as Date, id: last.id };

      for (const row of rows) {
        if (scanned >= MAX_SCAN_ROWS) {
          truncated = true;
          break;
        }
        scanned += 1;

        const capturedAt = row.capturedAt as Date;
        const hasCoords = row.takenLat != null && row.takenLng != null;

        // Canonical names throughout — see the ScanRow doc. `?? raw` is
        // belt-and-braces: the canonical column is populated whenever the raw
        // one is.
        const locality = row.geoCanonicalLocality ?? row.geoLocality;
        const admin1 = row.geoCanonicalAdmin1 ?? row.geoAdmin1;
        const country = row.geoCanonicalCountry ?? row.geoCountry;

        if (hasCoords && capturedAt >= homeWindowStart) {
          accumulateHomeSample(home, {
            lat: row.takenLat!,
            lng: row.takenLng!,
            geoLocality: locality,
            geoAdmin1: admin1,
          });
        }

        if (tripWindowStart && capturedAt < tripWindowStart) continue;

        const dayIndex = toDayIndex(capturedAt);
        let day = byDay.get(dayIndex);
        if (!day) {
          day = createDayAggregate(dayIndex);
          byDay.set(dayIndex, day);
        }
        day.photoCount += 1;
        if (hasCoords) {
          day.lats.push(row.takenLat!);
          day.lngs.push(row.takenLng!);
        }
        tally(day.localityCounts, locality);
        tally(day.admin1Counts, admin1);
        tally(day.countryCounts, country);
      }

      if (truncated) {
        this.logger.warn(
          `Trip scan for circle ${circleId} hit the ${MAX_SCAN_ROWS}-row cap; ` +
            'the tail of the history was not considered',
        );
        break;
      }
      if (rows.length < SCAN_PAGE_SIZE) break;
    }

    const days = [...byDay.values()].sort((a, b) => a.dayIndex - b.dayIndex);
    return { home, days, truncated };
  }

  // -------------------------------------------------------------------------
  // Refresh matching
  // -------------------------------------------------------------------------

  /**
   * Every `trip` memory in the circle — LIVE AND TOMBSTONED — reduced to the day
   * range overlap matching needs.
   *
   * Tombstoned rows are loaded deliberately: a user-deleted trip must keep
   * refusing regeneration even after new uploads shift its detected boundaries
   * (and therefore its would-be `periodKey`), which key-based tombstone checking
   * alone cannot guarantee.
   *
   * The day range is read from `meta.startDate`/`meta.endDate` — the DETECTED
   * range — rather than `periodStart`/`periodEnd`, which describe the curated
   * item set and can be narrower (the first and last day of a trip are often the
   * ones that lose their photos to the diversity cap). Rows written before those
   * meta keys existed fall back to the period columns.
   */
  private async loadExistingTrips(circleId: string): Promise<ExistingTrip[]> {
    const rows = await this.prisma.memory.findMany({
      where: { circleId, type: MemoryType.trip },
      select: {
        id: true,
        periodKey: true,
        subjectKey: true,
        deletedAt: true,
        periodStart: true,
        periodEnd: true,
        meta: true,
      },
      orderBy: [{ periodKey: 'desc' }, { id: 'asc' }],
      take: MAX_EXISTING_TRIPS,
    });

    if (rows.length === MAX_EXISTING_TRIPS) {
      this.logger.warn(
        `Circle ${circleId} has at least ${MAX_EXISTING_TRIPS} trip memories; ` +
          'overlap matching considered only the most recent ones',
      );
    }

    return rows.map((row) => {
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      const startDate = typeof meta['startDate'] === 'string' ? meta['startDate'] : null;
      const endDate = typeof meta['endDate'] === 'string' ? meta['endDate'] : null;
      const start = startDate ? Date.parse(`${startDate}T00:00:00.000Z`) : NaN;
      const end = endDate ? Date.parse(`${endDate}T00:00:00.000Z`) : NaN;

      const startDayIndex = Number.isNaN(start)
        ? toDayIndex(row.periodStart)
        : toDayIndex(new Date(start));
      const endDayIndex = Number.isNaN(end) ? toDayIndex(row.periodEnd) : toDayIndex(new Date(end));

      return {
        id: row.id,
        periodKey: row.periodKey,
        subjectKey: row.subjectKey,
        tombstoned: row.deletedAt !== null,
        startDayIndex,
        // Defensive: a hand-edited or legacy row with end < start would make
        // every overlap ratio zero, silently duplicating instead of refreshing.
        endDayIndex: Math.max(startDayIndex, endDayIndex),
      };
    });
  }

  // -------------------------------------------------------------------------
  // One run
  // -------------------------------------------------------------------------

  private async curateRun(args: {
    ctx: MemoryCuratorContext;
    run: AwayRun;
    home: HomeLocation;
    match: ExistingTrip | null;
    existing: ExistingTrip[];
  }): Promise<MemoryCuratorResult> {
    const { ctx, run, home, match, existing } = args;
    const result = emptyCuratorResult();

    // A tombstoned match ends it here: the user deleted this trip, and a shifted
    // boundary does not make it a different one. Note this is checked BEFORE any
    // curation work, and independently of upsertMemory's own key-based tombstone
    // check — that one would not fire, because the shifted run carries new keys.
    if (match?.tombstoned) {
      this.logger.debug(
        `Trip ${dayIndexToKey(run.startDayIndex)}..${dayIndexToKey(run.endDayIndex)} in circle ` +
          `${ctx.circleId} overlaps tombstoned memory ${match.id}; not regenerated`,
      );
      result.tombstoned += 1;
      return result;
    }

    const rangeStart = dayIndexToDate(run.startDayIndex);
    const rangeEndExclusive = dayIndexToDate(run.endDayIndex + 1);

    const selection = await this.curation.curate(
      ctx.circleId,
      { capturedAt: { gte: rangeStart, lt: rangeEndExclusive } },
      { maxItems: ctx.settings.maxItemsPerMemory },
    );
    if (selection.items.length < ctx.settings.trips.minItems) {
      result.skipped += 1;
      return result;
    }

    const place = dominantPlace(run);
    // The place is resolved from the run's DAY AGGREGATES (every candidate in
    // range) rather than from the curated items: a 30-item selection is a
    // quality sample, not a geographic one, and naming the trip after whichever
    // town happened to contribute the sharpest photos would be arbitrary.
    const { title, subtitle } = tripTitle(
      place.place ?? UNKNOWN_TRIP_PLACE,
      rangeStart,
      dayIndexToDate(run.endDayIndex),
    );

    const identity = await this.resolveIdentity({
      circleId: ctx.circleId,
      run,
      subjectKey: slugifyPlace(place.place),
      match,
      existing,
    });

    const upsert = await this.curation.upsertMemory({
      circleId: ctx.circleId,
      // #306: the run-wide AI-titling budget/circuit breaker.
      titling: ctx.titling,
      type: MemoryType.trip,
      periodKey: identity.periodKey,
      subjectKey: identity.subjectKey,
      title,
      subtitle,
      selection,
      // Trips never expire — unlike on_this_day, a trip stays interesting.
      expiresAt: null,
      // The trip is still the same trip, but it is no longer named after the
      // same town, so the stored title has been falsified rather than merely
      // aged. See UpsertMemoryInput.retitle for why that is distinct from a
      // material membership change.
      retitle: identity.subjectChanged,
      meta: {
        locality: place.locality,
        admin1: place.admin1,
        country: place.country,
        distanceKm: run.maxDistanceKm,
        dayCount: run.spanDays,
        // The DETECTED day range, which is what overlap matching reads back on
        // the next run — see loadExistingTrips.
        startDate: dayIndexToKey(run.startDayIndex),
        endDate: dayIndexToKey(run.endDayIndex),
        homePlace: home.label,
        homeLevel: home.level,
      },
    });

    if (upsert.skippedTombstone) result.tombstoned += 1;
    else if (upsert.created) result.created += 1;
    else result.refreshed += 1;

    return result;
  }

  /**
   * Decide which `(periodKey, subjectKey)` this run should be written under.
   *
   * With no overlap match, the run's own keys are used and `upsertMemory` does
   * the rest (including its key-based tombstone check).
   *
   * With a match whose keys have DRIFTED — a boundary shift moved the start
   * date, or a better reverse-geocode changed the dominant locality — the
   * existing row is re-keyed in place first, so the subsequent upsert finds it
   * by its new identity and refreshes rather than inserting a second row. The
   * unique index permits this: it is an UPDATE of the row that already owns the
   * old slot, not a competing insert.
   */
  private async resolveIdentity(args: {
    circleId: string;
    run: AwayRun;
    subjectKey: string;
    match: ExistingTrip | null;
    existing: ExistingTrip[];
  }): Promise<{ periodKey: string; subjectKey: string; subjectChanged: boolean }> {
    const { circleId, run, subjectKey, match, existing } = args;
    const periodKey = dayIndexToKey(run.startDayIndex);

    if (!match) return { periodKey, subjectKey, subjectChanged: false };
    if (match.periodKey === periodKey && match.subjectKey === subjectKey) {
      return { periodKey, subjectKey, subjectChanged: false };
    }

    // Another memory already occupies the slot we would move into. Rather than
    // fight over it (the update would fail the unique index, and deleting the
    // squatter could destroy a memory a user favorited), keep this row's current
    // identity and refresh it there. The keys are an identity, not data — a
    // stale-but-stable one beats a duplicate row.
    const conflict = existing.find(
      (t) => t.id !== match.id && t.periodKey === periodKey && t.subjectKey === subjectKey,
    );
    if (conflict) {
      this.logger.debug(
        `Trip memory ${match.id} in circle ${circleId} would re-key to ` +
          `${periodKey}/${subjectKey}, which memory ${conflict.id} already holds; ` +
          'refreshing under its existing keys instead',
      );
      return { periodKey: match.periodKey, subjectKey: match.subjectKey, subjectChanged: false };
    }

    const subjectChanged = match.subjectKey !== subjectKey;
    await this.prisma.memory.update({
      where: { id: match.id },
      data: { periodKey, subjectKey },
    });
    // Keep the in-memory view honest for the remaining runs' conflict checks.
    match.periodKey = periodKey;
    match.subjectKey = subjectKey;

    return { periodKey, subjectKey, subjectChanged };
  }
}
