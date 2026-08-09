// =============================================================================
// Memories — Seasonal curator (epic #300, issue #305)
// =============================================================================
//
// "Summer 2025" — the whole-library payoff at a granularity between a trip and a
// year. No subject, no clustering, no AI signal required: a season is a date
// range, and everything interesting about this curator is WHICH range and WHEN.
//
// ONLY COMPLETED SEASONS. A "Summer 2026" memory generated in July would be a
// partial summer, and every subsequent generation run would rewrite it as more
// photos landed — churning the item set and, from #306, re-paying for an AI
// title, daily, for three months. Waiting until the season has fully elapsed
// makes the memory stable the moment it is created. `mostRecentCompletedSeason`
// owns that rule (see period-windows.ts).
//
// THE SEASON YEAR IS THE YEAR THE SEASON STARTS. Northern-hemisphere winter runs
// December Y → February Y+1, so `2025-winter` contains January 2026 photos and
// its `periodKey` legitimately disagrees with a naive `getUTCFullYear()` of its
// own contents. That reconciliation is centralized in `seasonOf()` rather than
// re-derived here, and `SEASON_LABELS`/`seasonForMonth` in the title templates
// hold the hemisphere assumption in one place for a future locale setting.
//
// SCHEDULED RUNS DO ONE SEASON. There is exactly one season that can newly
// qualify between two runs, and refreshing older ones is what backfill is for —
// so the daily job costs one census query plus at most one curation pass.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { seasonalTitle } from '../curation/memory-title-templates';
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
import {
  SeasonPeriod,
  enumerateSeasons,
  mostRecentCompletedSeason,
  seasonOf,
  seasonOrdinal,
  seasonPeriodKey,
  seasonWindow,
} from './period-windows';

@Injectable()
export class SeasonalCurator implements MemoryCurator {
  readonly name = 'seasonal';

  private readonly logger = new Logger(SeasonalCurator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly curation: MemoryCurationService,
  ) {}

  isEnabled(settings: MemoryCuratorContext['settings']): boolean {
    return settings.seasonal.enabled;
  }

  async run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();

    const counts = await loadMonthCounts(this.prisma, ctx.circleId);
    if (counts.size === 0) return result;

    for (const period of this.resolvePeriods(ctx, counts)) {
      const outcome = await this.curateSeason(ctx, period, counts);
      result.created += outcome.created;
      result.refreshed += outcome.refreshed;
      result.skipped += outcome.skipped;
      result.tombstoned += outcome.tombstoned;
    }

    this.logger.debug(
      `Seasonal for circle ${ctx.circleId}: ${result.created} created / ` +
        `${result.refreshed} refreshed / ${result.skipped} skipped / ` +
        `${result.tombstoned} tombstoned`,
    );

    return result;
  }

  /**
   * Scheduled: the most recently completed season, and only that one.
   *
   * Backfill: every completed season from the circle's oldest material forward.
   * Enumerated from the census bounds rather than from distinct season keys so
   * the list is contiguous — a gap year is cheap (its raw count is zero and it
   * is skipped before any query) and contiguity keeps the ordering trivially
   * chronological.
   */
  private resolvePeriods(ctx: MemoryCuratorContext, counts: MonthCounts): SeasonPeriod[] {
    const latest = mostRecentCompletedSeason(ctx.now);
    if (!ctx.backfill) return [latest];

    const bounds = censusBounds(counts);
    if (!bounds) return [];

    const earliest = seasonOf(monthBucketStart(bounds.first));
    // A circle whose only photos are inside the still-running season has nothing
    // completed to generate — `enumerateSeasons` returns empty for that.
    return enumerateSeasons(earliest, latest);
  }

  private async curateSeason(
    ctx: MemoryCuratorContext,
    period: SeasonPeriod,
    counts: MonthCounts,
  ): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { minItems } = ctx.settings.seasonal;

    const window = seasonWindow(period);
    // The census can only over-count relative to curation (collapse and the
    // video cap remove items, never add), so a season under the floor here
    // cannot clear it afterwards — and this costs no query at all.
    if (countInWindow(counts, window.start, window.endExclusive) < minItems) {
      result.skipped += 1;
      return result;
    }

    const selection = await this.curation.curate(
      ctx.circleId,
      { capturedAt: { gte: window.start, lt: window.endExclusive } },
      { maxItems: ctx.settings.maxItemsPerMemory },
    );
    if (selection.items.length < minItems) {
      result.skipped += 1;
      return result;
    }

    const { title, subtitle } = seasonalTitle(period.season, period.year);
    const upsert = await this.curation.upsertMemory({
      circleId: ctx.circleId,
      type: MemoryType.seasonal,
      periodKey: seasonPeriodKey(period),
      // Seasonal memories have no subject — one per circle per season. '' is
      // the schema's default and is never NULL; see the Memory model comment.
      subjectKey: '',
      title,
      subtitle,
      selection,
      // Seasons never expire: unlike on_this_day, "Summer 2025" stays
      // interesting long after the season ends.
      expiresAt: null,
      meta: {
        season: period.season,
        seasonYear: period.year,
        seasonOrdinal: seasonOrdinal(period),
      },
    });

    if (upsert.skippedTombstone) result.tombstoned += 1;
    else if (upsert.created) result.created += 1;
    else result.refreshed += 1;

    return result;
  }
}
