import { defineHostSlot } from '../../core/ui/index.js';
import { SEARCH_PEOPLE_EXPLORE_SLOT } from '../headless/slot-names.js';

// =============================================================================
// Slots: the components of slices that have not moved into this package yet
// =============================================================================
//
// The search page's explore view opens with the people carousel, which belongs to
// the people slice. The host registers it under the name below (`slots` of
// `MemoriahubWebHost`); a host that registers none renders the explore view
// without it. The slot is deleted when the people slice moves into the package.
// =============================================================================

/**
 * Props of the people carousel of the explore view the host supplies.
 *
 * @stability experimental
 */
export interface SearchPeopleExploreSlotProps {
  /** The owner scope id whose people are shown. */
  circleId: string;
}

/** The people carousel of the explore view, from the host. @stability experimental */
export const SearchPeopleExploreSlot = defineHostSlot<SearchPeopleExploreSlotProps>(SEARCH_PEOPLE_EXPLORE_SLOT);
