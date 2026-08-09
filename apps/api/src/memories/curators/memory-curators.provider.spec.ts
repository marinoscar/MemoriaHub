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

import { MEMORY_BACKFILL_SHARDS } from '../admin/memory-backfill.shards';
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

  // #315: the backfill shard plan names curators as STRINGS in a job payload,
  // and the handler treats an unknown name as a no-op (a payload from another
  // release must not poison the queue). That safety valve is also a silent
  // failure: renaming a curator would leave its shard enqueuing a job that
  // curates nothing, forever, with only a log line to show for it. Pinning the
  // two together here is the only place that would notice.
  it('covers every registered curator exactly once across the backfill shard plan', () => {
    const registered = memoryCuratorsProvider
      .useFactory(
        stub('on_this_day') as never,
        stub('trip') as never,
        stub('person_highlights') as never,
        stub('person_over_years') as never,
        stub('theme') as never,
        stub('seasonal') as never,
        stub('year_in_review') as never,
      )
      .map((c) => c.name);

    const sharded = MEMORY_BACKFILL_SHARDS.flatMap((shard) => [...shard.curators]);

    // Every curator is reachable from a backfill...
    expect(new Set(sharded)).toEqual(new Set(registered));
    // ...and no shard names a curator that does not exist.
    for (const name of sharded) {
      expect(registered).toContain(name);
    }
    // On This Day is the only type split across shards (by calendar month);
    // every other type appears exactly once.
    const counts = sharded.reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['on_this_day']).toBe(12);
    for (const name of registered.filter((n) => n !== 'on_this_day')) {
      expect(counts[name]).toBe(1);
    }
  });
});
