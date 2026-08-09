// =============================================================================
// Memories — Person Over Years curator (epic #300, issue #305)
// =============================================================================
//
// "Camila through the years" — ONE memory per person, spanning their whole
// history, deliberately thin per year so the chronological playback reads as
// someone growing up rather than as a 2019 photo dump with a 2024 postscript.
//
// WHY THIS NEEDS A DIFFERENT DIVERSITY POLICY. The engine's default
// `selectDiverse` divides the memory's TIME SPAN into equal buckets. For a
// person photographed heavily in 2016 and again in 2025 with a quiet stretch
// between, equal thirds of nine elapsed years put two buckets inside the same
// busy period and none in the quiet middle. The whole promise of this type is
// "every year appears", which is a statement about the calendar, not about
// elapsed time — so it passes `bucketBy: { key: yearBucket }` to `curate()`
// (see `selectByBuckets`, added to the engine by this issue) and caps any one
// year at PERSON_OVER_YEARS_MAX_PER_YEAR.
//
// THE >=3-YEAR FLOOR is what separates this type from `person_highlights`. Two
// years is not "through the years"; it is two years, and the per-year highlight
// memories already tell that story better. The floor is checked on the CENSUS
// (years the person has any material in) rather than on the curated set, so a
// person whose middle year loses its slots to the item cap still qualifies.
//
// SHARED ELIGIBILITY. Persons come from the same `loadEligiblePersons` the
// highlights curator uses — see `person-candidates.ts` for why per-user hidden
// people are deliberately NOT applied at generation time.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoryCurationService } from '../curation/memory-curation.service';
import { personOverYearsTitle } from '../curation/memory-title-templates';
import {
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
  emptyCuratorResult,
} from './memory-curator.interface';
import {
  EligiblePerson,
  PERSON_OVER_YEARS_MAX_PER_YEAR,
  PERSON_OVER_YEARS_MIN_YEARS,
  groupYearCounts,
  loadEligiblePersons,
  loadPersonYearCounts,
  preferredPersonCover,
  withCover,
} from './person-candidates';
import { utcYear, yearBucket } from './period-windows';

/**
 * The `periodKey` for every memory of this type. There is exactly one
 * `person_over_years` memory per person, so the period carries no information
 * and the subject (`personId`) is the whole identity — see the `MemoryType`
 * enum comment in schema.prisma.
 */
export const PERSON_OVER_YEARS_PERIOD_KEY = 'all';

@Injectable()
export class PersonOverYearsCurator implements MemoryCurator {
  readonly name = 'person_over_years';

  private readonly logger = new Logger(PersonOverYearsCurator.name);

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

    // Scheduled and backfill runs do exactly the same work here: the period is
    // always 'all', so there is no narrower "what changed recently" window to
    // exploit. The cost is bounded by the eligible-person count either way.
    for (const person of persons) {
      const years = byPerson.get(person.id);
      if (!years || years.length < PERSON_OVER_YEARS_MIN_YEARS) {
        result.skipped += 1;
        continue;
      }

      const total = years.reduce((sum, y) => sum + y.count, 0);
      if (total < minItems) {
        result.skipped += 1;
        continue;
      }

      const outcome = await this.curatePerson(ctx, person, years, minItems);
      result.created += outcome.created;
      result.refreshed += outcome.refreshed;
      result.skipped += outcome.skipped;
      result.tombstoned += outcome.tombstoned;
    }

    this.logger.debug(
      `Person over years for circle ${ctx.circleId}: ${persons.length} eligible person(s), ` +
        `${result.created} created / ${result.refreshed} refreshed / ` +
        `${result.skipped} skipped / ${result.tombstoned} tombstoned`,
    );

    return result;
  }

  private async curatePerson(
    ctx: MemoryCuratorContext,
    person: EligiblePerson,
    years: Array<{ year: number; count: number }>,
    minItems: number,
  ): Promise<MemoryCuratorResult> {
    const result = emptyCuratorResult();

    // No date range: the slice is the person's ENTIRE history, and the year
    // bucketing is what keeps that from becoming a pile.
    const selection = await this.curation.curate(
      ctx.circleId,
      { faces: { some: { personId: person.id, hiddenAt: null } } },
      {
        maxItems: ctx.settings.maxItemsPerMemory,
        bucketBy: {
          key: (candidate) => yearBucket(candidate.capturedAt),
          maxPerBucket: PERSON_OVER_YEARS_MAX_PER_YEAR,
        },
      },
    );

    if (selection.items.length < minItems) {
      result.skipped += 1;
      return result;
    }

    // Derived from the SELECTION rather than from the census, so the rendered
    // subtitle ("2016–2025") always names the range the memory actually
    // contains. `periodStart`/`periodEnd` are non-null whenever items exist.
    const firstYear = utcYear(selection.periodStart!);
    const lastYear = utcYear(selection.periodEnd!);
    const yearCount = years.filter((y) => y.year >= firstYear && y.year <= lastYear).length;

    const cover = await preferredPersonCover(this.prisma, person.id, selection);
    const { title, subtitle } = personOverYearsTitle(person.name, firstYear, lastYear);

    const upsert = await this.curation.upsertMemory({
      circleId: ctx.circleId,
      type: MemoryType.person_over_years,
      periodKey: PERSON_OVER_YEARS_PERIOD_KEY,
      subjectKey: person.id,
      personId: person.id,
      title,
      subtitle,
      selection: withCover(selection, cover),
      expiresAt: null,
      meta: { firstYear, lastYear, yearCount, personName: person.name },
    });

    if (upsert.skippedTombstone) result.tombstoned += 1;
    else if (upsert.created) result.created += 1;
    else result.refreshed += 1;

    return result;
  }
}
