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
// =============================================================================

import { MEMORY_CURATORS, MemoryCurator } from './memory-curator.interface';
import { OnThisDayCurator } from './on-this-day.curator';
import { TripCurator } from './trip.curator';

export const memoryCuratorsProvider = {
  provide: MEMORY_CURATORS,
  useFactory: (onThisDay: OnThisDayCurator, trip: TripCurator): MemoryCurator[] => [
    onThisDay,
    trip,
  ],
  inject: [OnThisDayCurator, TripCurator],
};
