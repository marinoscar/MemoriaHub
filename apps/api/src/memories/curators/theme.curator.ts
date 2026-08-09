// =============================================================================
// Memories — Theme curator (epic #300, issue #305)
// =============================================================================
//
// "Golden Sunsets", "Beach", "Pets" — memories built from the AI auto-tagging
// vocabulary. The auto-tagging payoff, and the only curator whose subject is a
// piece of admin-controlled configuration rather than something the library
// derived on its own.
//
// WHY THE TAG VOCABULARY AND NOT UNSUPERVISED CLUSTERING. CLIP-embedding
// clustering would find themes nobody named, but its output is unexplainable
// ("here are 40 photos that are near each other in a 512-d space") and
// untunable. Tag themes are explainable, already computed, free, and — because
// `tag_labels` is admin-managed — an admin who does not want "Food" memories
// simply disables the label. Epic #300 defers clustering explicitly.
//
// THREE FILTERS DECIDE WHICH TAGS BECOME MEMORIES
// -----------------------------------------------
//
// 1. `media_tags.source = 'ai'`. A manually applied tag is a filing decision,
//    not a claim about content, and a user who tagged 200 photos "Taxes" did not
//    ask for a memory about it. The distinction exists in the schema precisely
//    because AI and manual tag instances are governed by different rules (see
//    CLAUDE.md's `MediaTagSource` note).
//
// 2. The label must still be ENABLED in `tag_labels`. Disabling a label is how
//    an admin retires a concept; a retired concept must stop producing memories
//    without anyone having to hunt down the rows it already generated.
//
// 3. THEME_TAG_DENYLIST. A handful of vocabulary entries describe a document,
//    not a moment. They score well (they are sharp, and screenshots are often
//    favorited for reference) and would produce genuinely bad memories.
//
// RANKING IS BY DISTINCT QUALIFYING ITEMS, NOT BY TOTAL TAG INSTANCES, and the
// item set that a memory is finally built from is CURATED — favorites-weighted,
// near-duplicate collapsed. So "the top themes" means the themes with the most
// material, but each memory is that theme's best photos rather than all of them.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MediaTagSource, MemoryType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { themeTitle } from '../curation/memory-title-templates';
import {
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
  emptyCuratorResult,
} from './memory-curator.interface';
import { yearWindow } from './period-windows';

/**
 * Vocabulary entries that never become a theme memory.
 *
 * Deliberately tiny and hand-maintained rather than heuristic: these are the
 * concepts whose photos are artifacts rather than moments. Compared
 * case-insensitively against the tag name. Documented in
 * docs/specs/memories.md §4.10.
 */
export const THEME_TAG_DENYLIST: ReadonlySet<string> = new Set([
  'screenshot',
  'screenshots',
  'document',
  'documents',
  'text',
  'whiteboard',
]);

/** The `periodKey` for a theme spanning the circle's whole history. */
export const THEME_ALL_PERIOD_KEY = 'all';

/**
 * Ceiling on curation attempts per period, as a multiple of `maxPerPeriod`.
 *
 * The rule is "the top N tags that produce at least `minItems` CURATED items",
 * which cannot be evaluated without curating — a tag can clear the raw census
 * and then fall short once near-duplicates collapse. Walking further down the
 * ranking when that happens is right (the point is N good themes, not N
 * attempts), but it has to stop somewhere: a circle with 200 sparse tags must
 * not turn one period into 200 curation passes.
 */
const THEME_ATTEMPT_MULTIPLIER = 3;

/** One period this curator generates for. */
interface ThemePeriod {
  periodKey: string;
  /** null for the all-history period. */
  year: number | null;
}

/** Census row: distinct qualifying items for one `(tag, year)`. */
interface TagYearCount {
  tag: string;
  year: number;
  count: number;
}

@Injectable()
export class ThemeCurator implements MemoryCurator {
  readonly name = 'theme';

  private readonly logger = new Logger(ThemeCurator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly curation: MemoryCurationService,
  ) {}

  isEnabled(settings: MemoryCuratorContext['settings']): boolean {
    return settings.themes.enabled;
  }

  async run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();

    const census = await this.loadTagYearCounts(ctx.circleId);
    if (census.length === 0) {
      // THE GRACEFUL-DEGRADATION PATH: auto-tagging never ran, produced nothing,
      // or every label it used has since been disabled. Not an error — a
      // supported configuration, and the other curators are unaffected.
      return result;
    }

    for (const period of this.resolvePeriods(ctx, census)) {
      const outcome = await this.curatePeriod(ctx, period, census);
      result.created += outcome.created;
      result.refreshed += outcome.refreshed;
      result.skipped += outcome.skipped;
      result.tombstoned += outcome.tombstoned;
    }

    this.logger.debug(
      `Themes for circle ${ctx.circleId}: ${result.created} created / ` +
        `${result.refreshed} refreshed / ${result.skipped} skipped / ` +
        `${result.tombstoned} tombstoned`,
    );

    return result;
  }

  /**
   * Scheduled: the current year only — the only period a new upload can change,
   * and the one a user is most likely to be shown.
   *
   * Backfill: every year with material, plus the all-history period. The
   * all-history themes are what make a young library interesting: a circle whose
   * photos are spread thin across eight years may have no single year clearing
   * `minItems` for "Sunsets" while having plenty overall.
   */
  private resolvePeriods(ctx: MemoryCuratorContext, census: TagYearCount[]): ThemePeriod[] {
    if (!ctx.backfill) {
      const year = ctx.now.getUTCFullYear();
      return [{ periodKey: String(year), year }];
    }

    const years = [...new Set(census.map((row) => row.year))].sort((a, b) => b - a);
    return [
      ...years.map((year) => ({ periodKey: String(year), year })),
      { periodKey: THEME_ALL_PERIOD_KEY, year: null },
    ];
  }

  private async curatePeriod(
    ctx: MemoryCuratorContext,
    period: ThemePeriod,
    census: TagYearCount[],
  ): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { minItems, maxPerPeriod } = ctx.settings.themes;

    const ranked = rankTagsForPeriod(census, period.year, minItems);
    if (ranked.length === 0) return result;

    const window = period.year === null ? null : yearWindow(period.year);
    const maxAttempts = maxPerPeriod * THEME_ATTEMPT_MULTIPLIER;

    let produced = 0;
    let attempts = 0;

    for (const { tag } of ranked) {
      if (produced >= maxPerPeriod || attempts >= maxAttempts) break;
      attempts += 1;

      const selection = await this.curation.curate(
        ctx.circleId,
        {
          ...(window ? { capturedAt: { gte: window.start, lt: window.endExclusive } } : {}),
          // The tag is matched case-insensitively because the census groups on
          // `LOWER(name)` — one circle can hold "Sunset" and "sunset" as
          // separate Tag rows, and they are one theme.
          mediaTags: {
            some: {
              source: MediaTagSource.ai,
              tag: { circleId: ctx.circleId, name: { equals: tag, mode: 'insensitive' } },
            },
          },
        },
        { maxItems: ctx.settings.maxItemsPerMemory },
      );

      if (selection.items.length < minItems) {
        result.skipped += 1;
        continue;
      }

      const { title, subtitle } = themeTitle(tag, selection.items.length);
      const upsert = await this.curation.upsertMemory({
        circleId: ctx.circleId,
        // #306: the run-wide AI-titling budget/circuit breaker.
        titling: ctx.titling,
        type: MemoryType.theme,
        periodKey: period.periodKey,
        subjectKey: tag,
        title,
        subtitle,
        selection,
        expiresAt: null,
        meta: { tag, year: period.year },
      });

      // A tombstoned theme still consumes a slot: the user deleted THAT theme
      // for this period, and quietly promoting the next tag into its place would
      // read as the delete having done nothing.
      produced += 1;
      if (upsert.skippedTombstone) result.tombstoned += 1;
      else if (upsert.created) result.created += 1;
      else result.refreshed += 1;
    }

    return result;
  }

  /**
   * Distinct qualifying items per `(lowercased tag, year)` — one grouped query
   * for the whole circle, mirroring `circle-month-counts.ts`'s rationale.
   *
   * `COUNT(DISTINCT m.id)` rather than `COUNT(*)`: the `(tag_id, media_item_id)`
   * unique index already prevents a duplicate instance for one Tag row, but two
   * Tag rows differing only in case fold into one theme here and would otherwise
   * double-count the items they share.
   *
   * Joining `tag_labels` on `LOWER(name)` is what enforces "the label is still
   * part of the vocabulary AND still enabled" — a tag instance whose label was
   * deleted outright leaves `media_tags` rows behind for manual instances (see
   * `DELETE /api/tag-labels/:id`), and those must not resurrect a retired theme.
   *
   * The `media_items` predicates are the curation base filter, hand-written for
   * raw SQL — see `circle-month-counts.ts` for why that duplication is accepted.
   */
  private async loadTagYearCounts(circleId: string): Promise<TagYearCount[]> {
    const rows = await this.prisma.$queryRaw<TagYearCount[]>(Prisma.sql`
      SELECT
        LOWER(t."name") AS "tag",
        EXTRACT(YEAR FROM (m."captured_at" AT TIME ZONE 'UTC'))::int AS "year",
        COUNT(DISTINCT m."id")::int AS "count"
      FROM "media_tags" mt
      JOIN "tags" t ON t."id" = mt."tag_id"
      JOIN "tag_labels" tl ON LOWER(tl."name") = LOWER(t."name")
      JOIN "media_items" m ON m."id" = mt."media_item_id"
      WHERE t."circle_id" = ${circleId}::uuid
        AND mt."source" = ${MediaTagSource.ai}::"MediaTagSource"
        AND tl."enabled" = TRUE
        AND m."circle_id" = ${circleId}::uuid
        AND m."captured_at" IS NOT NULL
        AND m."deleted_at" IS NULL
        AND m."archived_at" IS NULL
        AND m."social_media_source" IS NULL
      GROUP BY 1, 2
    `);

    return rows.filter((row) => !THEME_TAG_DENYLIST.has(row.tag));
  }
}

/**
 * Rank a period's tags by how much material they have, densest first.
 *
 * `year === null` sums every year, which is exact rather than an approximation:
 * a media item has exactly one `capturedAt` and therefore contributes to exactly
 * one year's distinct count, so the per-year counts of one tag partition its
 * all-history set with no overlap to correct for.
 *
 * Pure — exported for unit testing.
 */
export function rankTagsForPeriod(
  census: TagYearCount[],
  year: number | null,
  minItems: number,
): Array<{ tag: string; count: number }> {
  const totals = new Map<string, number>();
  for (const row of census) {
    if (year !== null && row.year !== year) continue;
    totals.set(row.tag, (totals.get(row.tag) ?? 0) + row.count);
  }

  return [...totals.entries()]
    .filter(([, count]) => count >= minItems)
    .map(([tag, count]) => ({ tag, count }))
    // Name is the tiebreak so the ranking — and therefore which themes exist —
    // is stable across runs over an unchanged library.
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.tag.localeCompare(b.tag)));
}
