// =============================================================================
// Memories — On This Day curator (epic #300, issue #303)
// =============================================================================
//
// Resurfaces, for a given calendar day, one memory PER PAST YEAR that has
// enough photos on that day: "On this day — 6 years ago".
//
// WHY TODAY *AND* TOMORROW. Generation is a background job on an interval
// (default 24h); notifications and the email digest (#311) fire in the morning.
// If a circle only ever generated for "today", a digest sent at 08:00 UTC would
// race the generation job that produces the content it is supposed to announce.
// Pre-generating tomorrow means the content for any given morning already
// exists the evening before, whatever order the two jobs happen to run in.
//
// WHY A MEMORY PER YEAR, NOT ONE PER DAY. "On this day" across ten years is ten
// separate stories, not one 300-photo pile. Per-year memories also give each
// year its own stable identity (`subjectKey`), which is what makes per-user
// seen/hidden/favorite state and the tombstone meaningful — you can delete
// 2014's awkward party without losing 2019's beach trip.
//
// THE DAY MATCH IS A FUNCTIONAL-INDEX QUERY. Matching "same month and day, any
// year" cannot be expressed as a range, so it goes through raw SQL against
// `EXTRACT(MONTH/DAY FROM (captured_at AT TIME ZONE 'UTC'))` — the same
// expression as `MediaService.getDashboard`'s On This Day query, and the same
// UTC pin (the cast makes EXTRACT IMMUTABLE, which is what allows an index on
// it at all; see 20260615000000_media_oncethisday_index). This curator is
// circle-scoped and excludes archived items, which that original index does not
// cover, so migration 20260809140000_memories_on_this_day_index adds a widened
// `(circle_id, month, day)` partial functional index for it. ONE query per
// anchor date covers every lookback year at once — 2 queries per circle per
// scheduled run, not 2 × lookbackYears.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { onThisDayTitle } from '../curation/memory-title-templates';
import {
  MEMORY_CURATORS,
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
  emptyCuratorResult,
} from './memory-curator.interface';

const MS_PER_DAY = 86_400_000;

/**
 * How long an `on_this_day` memory survives past its anchor day before the
 * generation job's purge tail hard-deletes it — TOMBSTONED OR NOT.
 *
 * Ignoring the tombstone here is deliberate and safe: the tombstone's job is
 * "do not recreate this memory", and once the anchor day is a month gone the
 * curator has no reason to generate that periodKey again until the date comes
 * back around a year later — by which point the underlying library has changed
 * and the memory is legitimately a new one. Keeping tombstones forever would
 * mean an unbounded row per (day × year) accumulating for the life of the
 * deployment, for content nobody can ever see again.
 */
export const ON_THIS_DAY_RETENTION_DAYS = 30;

/** Rows deleted per statement in the purge tail (lock-safe batching). */
const PURGE_BATCH_SIZE = 5_000;

/**
 * Defensive ceiling on ids pulled for one anchor across ALL lookback years.
 * Ordered `captured_at ASC` so the cut is deterministic; a circle dense enough
 * to hit this has far more than enough material for a good memory anyway.
 */
const MAX_ANCHOR_ROWS = 20_000;

/** Farthest ahead `nextAnchorOccurrence` will look — covers Feb 29's 8-year gap. */
const MAX_ANCHOR_LOOKAHEAD_YEARS = 8;

/** UTC midnight of the day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `2026-08-09` — the `periodKey` form for an anchor day. */
export function toIsoDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The next occurrence of (month, day) at or after `now`, at UTC midnight.
 *
 * Feb 29 is the whole reason this is a loop rather than arithmetic:
 * `Date.UTC(2027, 1, 29)` silently rolls over to March 1, so a naive
 * implementation would generate a "February 29" memory keyed to March 1 in
 * three years out of four. The round-trip check rejects the rollover and the
 * loop walks forward to the next leap year.
 */
export function nextAnchorOccurrence(now: Date, month: number, day: number): Date | null {
  const today = startOfUtcDay(now).getTime();
  const startYear = now.getUTCFullYear();
  for (let year = startYear; year <= startYear + MAX_ANCHOR_LOOKAHEAD_YEARS; year += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) continue;
    if (candidate.getTime() >= today) return candidate;
  }
  return null;
}

@Injectable()
export class OnThisDayCurator implements MemoryCurator {
  readonly name = 'on_this_day';

  private readonly logger = new Logger(OnThisDayCurator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly curation: MemoryCurationService,
  ) {}

  isEnabled(settings: MemoryCuratorContext['settings']): boolean {
    return settings.onThisDay.enabled;
  }

  async run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const anchors = await this.resolveAnchors(ctx);

    for (const anchor of anchors) {
      const anchorResult = await this.curateAnchor(ctx, anchor);
      result.created += anchorResult.created;
      result.refreshed += anchorResult.refreshed;
      result.skipped += anchorResult.skipped;
      result.tombstoned += anchorResult.tombstoned;
    }

    return result;
  }

  /**
   * Which calendar days to generate for.
   *
   * Scheduled: today + tomorrow (UTC). Backfill (#315): every (month, day) the
   * circle actually has photos on, each mapped to its NEXT occurrence — so a
   * backfilled memory's `periodKey` and `expiresAt` describe a day that is still
   * ahead, rather than a day that has already passed (which would make the row
   * born expired and immediately purge-eligible).
   */
  private async resolveAnchors(ctx: MemoryCuratorContext): Promise<Date[]> {
    if (!ctx.backfill) {
      const today = startOfUtcDay(ctx.now);
      return [today, new Date(today.getTime() + MS_PER_DAY)];
    }

    // At most 366 rows — one per calendar day the circle has any candidate on.
    const pairs = await this.prisma.$queryRaw<Array<{ month: number; day: number }>>(Prisma.sql`
      SELECT DISTINCT
        EXTRACT(MONTH FROM ("captured_at" AT TIME ZONE 'UTC'))::int AS month,
        EXTRACT(DAY   FROM ("captured_at" AT TIME ZONE 'UTC'))::int AS day
      FROM "media_items"
      WHERE "circle_id" = ${ctx.circleId}::uuid
        AND "deleted_at" IS NULL
        AND "archived_at" IS NULL
        AND "captured_at" IS NOT NULL
        AND "social_media_source" IS NULL
    `);

    const byKey = new Map<string, Date>();
    for (const { month, day } of pairs) {
      const anchor = nextAnchorOccurrence(ctx.now, month, day);
      if (anchor) byKey.set(toIsoDateKey(anchor), anchor);
    }
    return [...byKey.values()].sort((a, b) => a.getTime() - b.getTime());
  }

  /** Generate/refresh every qualifying past year for one anchor day. */
  private async curateAnchor(
    ctx: MemoryCuratorContext,
    anchor: Date,
  ): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { lookbackYears, minItems } = ctx.settings.onThisDay;
    const maxItems = ctx.settings.maxItemsPerMemory;

    const anchorYear = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + 1;
    const day = anchor.getUTCDate();

    // Half-open [floor, ceil): every year strictly BEFORE the anchor year, back
    // `lookbackYears`. Excluding the anchor year itself is what makes every
    // memory "N years ago" with N >= 1 — today's own photos are not a memory yet.
    const floor = new Date(Date.UTC(anchorYear - lookbackYears, 0, 1));
    const ceil = new Date(Date.UTC(anchorYear, 0, 1));

    const rows = await this.prisma.$queryRaw<Array<{ id: string; year: number }>>(Prisma.sql`
      SELECT "id",
             EXTRACT(YEAR FROM ("captured_at" AT TIME ZONE 'UTC'))::int AS year
      FROM "media_items"
      WHERE "circle_id" = ${ctx.circleId}::uuid
        AND "deleted_at" IS NULL
        AND "archived_at" IS NULL
        AND "captured_at" IS NOT NULL
        AND "social_media_source" IS NULL
        AND "captured_at" >= ${floor}
        AND "captured_at" < ${ceil}
        AND EXTRACT(MONTH FROM ("captured_at" AT TIME ZONE 'UTC')) = ${month}
        AND EXTRACT(DAY   FROM ("captured_at" AT TIME ZONE 'UTC')) = ${day}
      ORDER BY "captured_at" ASC, "id" ASC
      LIMIT ${MAX_ANCHOR_ROWS}
    `);

    if (rows.length === 0) return result;

    const idsByYear = new Map<number, string[]>();
    for (const row of rows) {
      const bucket = idsByYear.get(row.year);
      if (bucket) bucket.push(row.id);
      else idsByYear.set(row.year, [row.id]);
    }

    const periodKey = toIsoDateKey(anchor);
    // Active until the anchor day is over. `Memory.expiresAt` is compared with
    // `expiresAt > now()`, so start-of-next-day is the correct exclusive bound.
    const expiresAt = new Date(anchor.getTime() + MS_PER_DAY);

    // Descending: most recent year first, so a run that is cut short by a job
    // timeout has produced the years users are most likely to care about.
    const years = [...idsByYear.keys()].sort((a, b) => b - a);

    for (const sourceYear of years) {
      const ids = idsByYear.get(sourceYear)!;
      // A year that cannot possibly clear `minItems` even before collapse and
      // the video cap is not worth a curation pass.
      if (ids.length < minItems) {
        result.skipped += 1;
        continue;
      }

      const selection = await this.curation.curate(
        ctx.circleId,
        { id: { in: ids } },
        { maxItems },
      );
      if (selection.items.length < minItems) {
        result.skipped += 1;
        continue;
      }

      const yearsAgo = anchorYear - sourceYear;
      // The exact source day, constructed rather than taken from the first
      // item's timestamp: both name the same UTC calendar day (the EXTRACT
      // filter guarantees it) and the constructed one cannot drift.
      const sourceDate = new Date(Date.UTC(sourceYear, month - 1, day));
      const { title, subtitle } = onThisDayTitle(yearsAgo, sourceDate);

      const upsert = await this.curation.upsertMemory({
        circleId: ctx.circleId,
        type: MemoryType.on_this_day,
        periodKey,
        subjectKey: String(sourceYear),
        title,
        subtitle,
        selection,
        expiresAt,
        meta: { yearsAgo, sourceYear, anchorMonth: month, anchorDay: day },
      });

      if (upsert.skippedTombstone) result.tombstoned += 1;
      else if (upsert.created) result.created += 1;
      else result.refreshed += 1;
    }

    return result;
  }

  /**
   * Retention tail: hard-delete this circle's `on_this_day` memories whose
   * anchor day is more than ON_THIS_DAY_RETENTION_DAYS past.
   *
   * Runs at the end of every generation job rather than on its own cron: the
   * work is proportional to what generation just produced, it must not run on a
   * deployment with the feature off, and a separate cron would be a second
   * schedule to reason about for a single `deleteMany`.
   *
   * Batched despite the small expected cardinality because a backfilled circle
   * can hold up to `366 × lookbackYears` rows of this type, and a single
   * unbounded delete over that set is a needlessly long-held lock.
   */
  async purge(ctx: MemoryCuratorContext): Promise<number> {
    const cutoff = new Date(ctx.now.getTime() - ON_THIS_DAY_RETENTION_DAYS * MS_PER_DAY);
    let deleted = 0;

    for (;;) {
      const batch = await this.prisma.memory.findMany({
        where: {
          circleId: ctx.circleId,
          type: MemoryType.on_this_day,
          expiresAt: { not: null, lt: cutoff },
        },
        select: { id: true },
        take: PURGE_BATCH_SIZE,
      });
      if (batch.length === 0) break;

      const removed = await this.prisma.memory.deleteMany({
        where: { id: { in: batch.map((m) => m.id) } },
      });
      deleted += removed.count;
      if (batch.length < PURGE_BATCH_SIZE) break;
    }

    if (deleted > 0) {
      this.logger.debug(
        `Purged ${deleted} expired on_this_day memor${deleted === 1 ? 'y' : 'ies'} ` +
          `from circle ${ctx.circleId}`,
      );
    }
    return deleted;
  }
}

/**
 * Registry factory for the curator array. Later issues append their curators
 * here; ordering is the execution order inside a generation job.
 */
export const memoryCuratorsProvider = {
  provide: MEMORY_CURATORS,
  useFactory: (onThisDay: OnThisDayCurator): MemoryCurator[] => [onThisDay],
  inject: [OnThisDayCurator],
};
