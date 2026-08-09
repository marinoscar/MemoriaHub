// =============================================================================
// Memories — the curator registry (epic #300, issues #303 + #304)
// =============================================================================
//
// The ordered array injected under MEMORY_CURATORS. Adding a memory type is a
// provider plus one entry here; MemoryGenerationHandler iterates whatever this
// factory returns and needs no edit.
//
// It lives in its own file (rather than beside the first curator, where #303
// put it) now that there is more than one curator: the registry importing every
// curator means a file that also DEFINES a curator ends up importing its
// siblings, which is a needless coupling and an easy way to introduce an import
// cycle as the list grows.
//
// ORDER IS EXECUTION ORDER, and it is cheapest-first: On This Day runs two
// bounded functional-index queries, while Trips streams the circle's whole geo
// history. A generation job cut short by a timeout has then produced the daily
// content users actually see on Home.
//
// The #305 curators slot in after those two, ordered by how much of the library
// each one has to walk: the people and theme curators answer a cheap grouped
// census first and only curate the periods that can actually clear their
// `minItems` floor, while seasonal and year-in-review each curate a full
// calendar period. `person_over_years` follows `person_highlights` because the
// two share a census-shaped query and the per-year memories are the ones that
// change most often.
// =============================================================================

import { MEMORY_CURATORS, MemoryCurator } from './memory-curator.interface';
import { OnThisDayCurator } from './on-this-day.curator';
import { PersonHighlightsCurator } from './person-highlights.curator';
import { PersonOverYearsCurator } from './person-over-years.curator';
import { TripCurator } from './trip.curator';

export const memoryCuratorsProvider = {
  provide: MEMORY_CURATORS,
  useFactory: (
    onThisDay: OnThisDayCurator,
    trip: TripCurator,
    personHighlights: PersonHighlightsCurator,
    personOverYears: PersonOverYearsCurator,
  ): MemoryCurator[] => [onThisDay, trip, personHighlights, personOverYears],
  inject: [OnThisDayCurator, TripCurator, PersonHighlightsCurator, PersonOverYearsCurator],
};
