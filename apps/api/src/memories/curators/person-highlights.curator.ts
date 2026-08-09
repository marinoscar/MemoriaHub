// =============================================================================
// Memories — Person Highlights curator (epic #300, issue #305)
// =============================================================================
//
// "Best of Abuela, 2025" — one memory per eligible person per calendar year
// with enough material. The face-recognition payoff, and the memory type users
// most often go looking for deliberately rather than stumbling into.
//
// ONE MEMORY PER PERSON PER YEAR, NOT ONE PER PERSON. A decade of Abuela is not
// one story; it is ten. Per-year identity (`subjectKey = personId`,
// `periodKey = 'YYYY'`) is also what makes the per-user state and the tombstone
// useful at a sensible granularity — you can delete a year you would rather not
// be reminded of without losing the person. The all-time view of a person is a
// DIFFERENT memory type, `person_over_years`, which is why this curator never
// writes `periodKey = 'all'` even though the enum reserves it.
//
// GRACEFUL DEGRADATION IS THE DEFAULT PATH. A circle with face recognition off,
// or on but with nothing clustered into a named/favorited Person, produces zero
// eligible persons and returns an empty result. It does not throw, and per the
// epic's failure-mode matrix it must not disturb the other six curators.
//
// THE CASCADE IS THE CLEANUP. `Memory.personId` is a Cascade FK, so deleting a
// person — or merging them into another, which soft-deletes the source and
// therefore drops them out of `loadEligiblePersons` — takes their memories with
// it. This curator deliberately does not try to migrate or repair anything on a
// merge: the next run simply regenerates under the surviving person, whose face
// set now includes the merged-in faces.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { personHighlightsTitle } from '../curation/memory-title-templates';
import {
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
  emptyCuratorResult,
} from './memory-curator.interface';
import {
  EligiblePerson,
  groupYearCounts,
  loadEligiblePersons,
  loadPersonYearCounts,
  preferredPersonCover,
  withCover,
} from './person-candidates';
import { yearWindow } from './period-windows';

@Injectable()
export class PersonHighlightsCurator implements MemoryCurator {
  readonly name = 'person_highlights';

  private readonly logger = new Logger(PersonHighlightsCurator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly curation: MemoryCurationService,
  ) {}

  isEnabled(settings: MemoryCuratorContext['settings']): boolean {
    return settings.people.enabled;
  }

  async run(ctx: MemoryCuratorContext): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { favoritesOnly, minItems } = ctx.settings.people;

    const persons = await loadEligiblePersons(this.prisma, ctx.circleId, favoritesOnly);
    if (persons.length === 0) return result;

    const counts = await loadPersonYearCounts(
      this.prisma,
      ctx.circleId,
      persons.map((p) => p.id),
    );
    if (counts.length === 0) return result;
    const byPerson = groupYearCounts(counts);

    // Scheduled runs regenerate only the years a new upload can plausibly have
    // landed in — this year and last. Backfill takes every year with material.
    // ("Last year" matters into the following autumn: a December import lands in
    // the previous year's memory long after that year ended.)
    const currentYear = ctx.now.getUTCFullYear();
    const scopedYears = ctx.backfill ? null : new Set([currentYear, currentYear - 1]);

    for (const person of persons) {
      const years = byPerson.get(person.id);
      if (!years) continue;

      // Most recent first, so a run cut short by a job timeout has produced the
      // years users are most likely to be shown.
      for (const { year, count } of [...years].sort((a, b) => b.year - a.year)) {
        if (scopedYears && !scopedYears.has(year)) continue;
        // The raw census can only ever over-count relative to the curated set
        // (collapse and the video cap remove items, never add), so a year under
        // the floor here cannot clear it after curation.
        if (count < minItems) {
          result.skipped += 1;
          continue;
        }

        const outcome = await this.curateYear(ctx, person, year, minItems);
        result.created += outcome.created;
        result.refreshed += outcome.refreshed;
        result.skipped += outcome.skipped;
        result.tombstoned += outcome.tombstoned;
      }
    }

    this.logger.debug(
      `Person highlights for circle ${ctx.circleId}: ${persons.length} eligible person(s), ` +
        `${result.created} created / ${result.refreshed} refreshed / ` +
        `${result.skipped} skipped / ${result.tombstoned} tombstoned`,
    );

    return result;
  }

  private async curateYear(
    ctx: MemoryCuratorContext,
    person: EligiblePerson,
    year: number,
    minItems: number,
  ): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();
    const { start, endExclusive } = yearWindow(year);

    // The person predicate is handed to the ENGINE as part of the slice `where`
    // rather than resolved into an id list first: `curate()` then applies the
    // base filter, streams with constant memory, and collapses near-duplicates
    // exactly as it does for every other type. `hiddenAt: null` on the face
    // matches the census in person-candidates.ts.
    const selection = await this.curation.curate(
      ctx.circleId,
      {
        capturedAt: { gte: start, lt: endExclusive },
        faces: { some: { personId: person.id, hiddenAt: null } },
      },
      { maxItems: ctx.settings.maxItemsPerMemory },
    );

    if (selection.items.length < minItems) {
      result.skipped += 1;
      return result;
    }

    const cover = await preferredPersonCover(this.prisma, person.id, selection);
    const { title, subtitle } = personHighlightsTitle(person.name, year);

    const upsert = await this.curation.upsertMemory({
      circleId: ctx.circleId,
      type: MemoryType.person_highlights,
      periodKey: String(year),
      subjectKey: person.id,
      personId: person.id,
      title,
      subtitle,
      selection: withCover(selection, cover),
      // Person memories never expire — unlike on_this_day, they stay relevant.
      expiresAt: null,
      meta: { year, personName: person.name },
    });

    if (upsert.skippedTombstone) result.tombstoned += 1;
    else if (upsert.created) result.created += 1;
    else result.refreshed += 1;

    return result;
  }
}
