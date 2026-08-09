/**
 * Guard for the curator registry (issue #305).
 *
 * The registry is the one place a new memory type has to be listed, and
 * forgetting the entry fails SILENTLY: the curator provider still resolves, the
 * generation job still succeeds, and the type simply never produces a memory.
 * Nothing else in the suite would notice — every curator spec instantiates its
 * curator directly. So the factory is exercised here with stubs, asserting both
 * that all seven types are wired and that the declared execution order (which
 * decides what a timed-out job has produced) is the intended one.
 */

import { MEMORY_CURATORS } from './memory-curator.interface';
import { memoryCuratorsProvider } from './memory-curators.provider';
import { OnThisDayCurator } from './on-this-day.curator';
import { PersonHighlightsCurator } from './person-highlights.curator';
import { PersonOverYearsCurator } from './person-over-years.curator';
import { SeasonalCurator } from './seasonal.curator';
import { ThemeCurator } from './theme.curator';
import { TripCurator } from './trip.curator';
import { YearInReviewCurator } from './year-in-review.curator';

/** A stand-in carrying only the `name` the assertions read. */
function stub(name: string): { name: string } {
  return { name };
}

describe('memoryCuratorsProvider', () => {
  it('registers every MemoryType curator, cheapest-first', () => {
    const curators = memoryCuratorsProvider.useFactory(
      stub('on_this_day') as never,
      stub('trip') as never,
      stub('person_highlights') as never,
      stub('person_over_years') as never,
      stub('theme') as never,
      stub('seasonal') as never,
      stub('year_in_review') as never,
    );

    expect(curators.map((c) => c.name)).toEqual([
      'on_this_day',
      'trip',
      'person_highlights',
      'person_over_years',
      'theme',
      'seasonal',
      'year_in_review',
    ]);
  });

  it('injects the curator classes positionally in the same order the factory reads them', () => {
    // A mismatch here would hand each curator its neighbour's instance — which
    // type-checks (they share the MemoryCurator interface) and would only show
    // up as the wrong memory type being generated at runtime.
    expect(memoryCuratorsProvider.inject).toEqual([
      OnThisDayCurator,
      TripCurator,
      PersonHighlightsCurator,
      PersonOverYearsCurator,
      ThemeCurator,
      SeasonalCurator,
      YearInReviewCurator,
    ]);
    expect(memoryCuratorsProvider.provide).toBe(MEMORY_CURATORS);
  });
});
