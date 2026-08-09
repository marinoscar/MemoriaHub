// =============================================================================
// Memories — Year in Review curator (epic #300, issue #305)
// =============================================================================
//
// "Your 2025 in review" — the biggest memory in the catalog, and the one with
// the narrowest window of relevance.
//
// GENERATED IN DECEMBER OF Y AND ALL OF JANUARY Y+1. December because the
// year-in-review is a December ritual and the memory has to EXIST before anyone
// looks for it (the digest and notification producers in #311 announce content
// that generation must already have produced). All of January because "your year
// in review" is exactly what people go looking for over New Year, and a memory
// that only ever appeared for 31 days in December would be gone by the time most
// of the circle noticed. Outside that window a scheduled run generates nothing —
// it is not a memory whose item set benefits from being recomputed in June.
//
// The December half of that window means a year-in-review IS generated for a
// year that has three weeks left to run, and the late-December uploads then land
// through refresh. That is the deliberate trade: an existing-but-slightly-early
// memory beats a missing one, and `upsertMemory`'s Jaccard rule keeps the
// refresh from churning the title unless the additions are material.
//
// BUCKETED BY MONTH, NOT BY EQUAL TIME SPANS. A year in review whose thirty
// photos all come from one two-week holiday is not a year in review. The engine's
// default `selectDiverse` divides the SPAN into equal buckets, which is the same
// thing for a full year — but only if the year's material is spread across it;
// a library with a six-month gap would collapse into two dense clusters. Passing
// `bucketBy: { key: monthBucket }` states the intent structurally: every month
// with material gets a turn before any month gets a second item.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { yearInReviewTitle } from '../curation/memory-title-templates';
import {
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
  emptyCuratorResult,
} from './memory-curator.interface';
import {
  MonthCounts,
  censusBounds,
  countInWindow,
  loadMonthCounts,
  monthBucketStart,
} from './circle-month-counts';
import { monthBucket, utcYear, yearWindow } from './period-windows';

/** 0-based month index of December, the month a year's review becomes eligible. */
const DECEMBER = 11;

/**
 * Which year a scheduled run generates for, or null outside the window.
 *
 * Pure — exported for unit testing, because "December of Y and all of January
 * Y+1" is exactly the kind of boundary rule that is easier to get wrong than to
 * test.
 */
export function scheduledReviewYear(now: Date): number | null {
  const month = now.getUTCMonth();
  if (month === DECEMBER) return now.getUTCFullYear();
  if (month === 0) return now.getUTCFullYear() - 1;
  return null;
}

/**
 * Is `year` eligible to have a review generated as of `now`?
 *
 * Any year strictly in the past always is. The CURRENT year is only eligible
 * once December has arrived — the same completeness rule the scheduled window
 * encodes, applied to backfill so a mid-year backfill does not mint a
 * three-month "Your 2026 in review" that then churns for the rest of the year.
 */
export function isReviewYearEligible(year: number, now: Date): boolean {
  const currentYear = now.getUTCFullYear();
  if (year < currentYear) return true;
  return year === currentYear && now.getUTCMonth() === DECEMBER;
}

@Injectable()
export class YearInReviewCurator implements MemoryCurator {
  readonly name = 'year_in_review';

  private readonly logger = new Logger(YearInReviewCurator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly curation: MemoryCurationService,
  ) {}

  isEnabled(settings: MemoryCuratorContext['settings']): boolean {
    return settings.yearInReview.enabled;
  }

  async run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();

    const years = this.resolveYearsCheaply(ctx);
    // Outside the December/January window a scheduled run has nothing to do, and
    // says so without touching the database at all.
    if (years !== null && years.length === 0) return result;

    const counts = await loadMonthCounts(this.prisma, ctx.circleId);
    if (counts.size === 0) return result;

    for (const year of years ?? this.backfillYears(ctx, counts)) {
      const outcome = await this.curateYear(ctx, year, counts);
      result.created += outcome.created;
      result.refreshed += outcome.refreshed;
      result.skipped += outcome.skipped;
      result.tombstoned += outcome.tombstoned;
    }

    this.logger.debug(
      `Year in review for circle ${ctx.circleId}: ${result.created} created / ` +
        `${result.refreshed} refreshed / ${result.skipped} skipped / ` +
        `${result.tombstoned} tombstoned`,
    );

    return result;
  }

  /** Scheduled years, or null when the caller must derive them from the census. */
  private resolveYearsCheaply(ctx: MemoryCuratorContext): number[] | null {
    if (ctx.backfill) return null;
    const year = scheduledReviewYear(ctx.now);
    return year === null ? [] : [year];
  }

  /** Every eligible year the circle has material in, newest first. */
  private backfillYears(ctx: MemoryCuratorContext, counts: MonthCounts): number[] {
    const bounds = censusBounds(counts);
    if (!bounds) return [];

    const first = utcYear(monthBucketStart(bounds.first));
    const last = utcYear(monthBucketStart(bounds.last));
    const years: number[] = [];
    for (let year = last; year >= first; year -= 1) {
      if (isReviewYearEligible(year, ctx.now)) years.push(year);
    }
    return years;
  }

  private async curateYear(
    ctx: MemoryCuratorContext,
    year: number,
    counts: MonthCounts,
  ): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { minItems } = ctx.settings.yearInReview;

    // A scheduled run reaches this with a year it did not read off the census,
    // so re-check eligibility here too rather than trusting the caller.
    if (!isReviewYearEligible(year, ctx.now)) {
      result.skipped += 1;
      return result;
    }

    const window = yearWindow(year);
    if (countInWindow(counts, window.start, window.endExclusive) < minItems) {
      result.skipped += 1;
      return result;
    }

    const selection = await this.curation.curate(
      ctx.circleId,
      { capturedAt: { gte: window.start, lt: window.endExclusive } },
      {
        maxItems: ctx.settings.maxItemsPerMemory,
        // No per-bucket cap: with twelve buckets and a 30-item budget the
        // round-robin already yields two to three items a month, and a year
        // whose material is genuinely concentrated in four months should be
        // allowed to fill its slots from those four.
        bucketBy: { key: (candidate) => monthBucket(candidate.capturedAt) },
      },
    );
    if (selection.items.length < minItems) {
      result.skipped += 1;
      return result;
    }

    const monthsCovered = new Set(
      // Recomputed from the census window rather than from item dates, which
      // the selection does not carry: months that HAVE material, bounded by the
      // year. Reported as context in `meta`, never as a gate.
      [...counts.keys()].filter(
        (bucket) =>
          bucket >= monthBucket(window.start) && bucket < monthBucket(window.endExclusive),
      ),
    ).size;

    const { title, subtitle } = yearInReviewTitle(year, selection.items.length);
    const upsert = await this.curation.upsertMemory({
      circleId: ctx.circleId,
      // #306: the run-wide AI-titling budget/circuit breaker.
      titling: ctx.titling,
      type: MemoryType.year_in_review,
      periodKey: String(year),
      // No subject — one per circle per year. '' is the schema default and is
      // never NULL; see the Memory model comment in schema.prisma.
      subjectKey: '',
      title,
      subtitle,
      selection,
      expiresAt: null,
      meta: { year, monthsCovered },
    });

    if (upsert.skippedTombstone) result.tombstoned += 1;
    else if (upsert.created) result.created += 1;
    else result.refreshed += 1;

    return result;
  }
}
