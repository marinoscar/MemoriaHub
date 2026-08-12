import type { ReactElement } from 'react';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import FaceIcon from '@mui/icons-material/Face';
import FlightTakeoffIcon from '@mui/icons-material/FlightTakeoff';
import HistoryIcon from '@mui/icons-material/History';
import StarsIcon from '@mui/icons-material/Stars';
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import type { MemoryType } from '../../types/memories';

/**
 * Per-type presentation for the seven curated memory kinds (epic #300).
 *
 * One table, consumed by the card badge, the hub's filter chips and the
 * screen-reader label, so a type can never be labelled one way in the filter
 * bar and another on the card it filters to.
 *
 * `filterLabel` is the short plural used in the filter chips ("Trips"); `label`
 * is the singular badge text on a card ("Trip"). `emptyLabel` completes the
 * filtered-empty sentence "No {emptyLabel} memories yet."
 */
export interface MemoryTypeMeta {
  label: string;
  filterLabel: string;
  emptyLabel: string;
  icon: () => ReactElement;
}

export const MEMORY_TYPE_META: Record<MemoryType, MemoryTypeMeta> = {
  on_this_day: {
    label: 'On this day',
    filterLabel: 'On This Day',
    emptyLabel: 'On This Day',
    icon: () => <HistoryIcon fontSize="inherit" />,
  },
  trip: {
    label: 'Trip',
    filterLabel: 'Trips',
    emptyLabel: 'trip',
    icon: () => <FlightTakeoffIcon fontSize="inherit" />,
  },
  person_highlights: {
    label: 'People',
    filterLabel: 'People',
    emptyLabel: 'people',
    icon: () => <FaceIcon fontSize="inherit" />,
  },
  person_over_years: {
    label: 'Through the years',
    filterLabel: 'People',
    emptyLabel: 'people',
    icon: () => <FaceIcon fontSize="inherit" />,
  },
  theme: {
    label: 'Theme',
    filterLabel: 'Themes',
    emptyLabel: 'theme',
    icon: () => <AutoAwesomeIcon fontSize="inherit" />,
  },
  seasonal: {
    label: 'Season',
    filterLabel: 'Seasons',
    emptyLabel: 'seasonal',
    icon: () => <WbSunnyIcon fontSize="inherit" />,
  },
  year_in_review: {
    label: 'Year in review',
    filterLabel: 'Years',
    emptyLabel: 'year in review',
    icon: () => <StarsIcon fontSize="inherit" />,
  },
};

/**
 * Fallback so a memory kind the API ships before the web app knows about it
 * still renders — with a generic badge rather than a crash on an undefined
 * lookup. The API's enum is the source of truth and it CAN move first.
 */
const UNKNOWN_TYPE_META: MemoryTypeMeta = {
  label: 'Memory',
  filterLabel: 'Memory',
  emptyLabel: 'matching',
  icon: () => <AutoAwesomeIcon fontSize="inherit" />,
};

export function memoryTypeMeta(type: MemoryType): MemoryTypeMeta {
  return MEMORY_TYPE_META[type] ?? UNKNOWN_TYPE_META;
}

/**
 * Filter chips for the hub, in the order issue #309 specifies. `person_*` is
 * deliberately ONE chip in the UI but two enum values, so the chip carries the
 * value it filters by (`person_highlights`) and the other kind simply is not
 * reachable from the bar — the alternative, an OR filter, is not something the
 * API's single-valued `type` query supports.
 */
export const MEMORY_FILTER_TYPES: MemoryType[] = [
  'on_this_day',
  'trip',
  'person_highlights',
  'theme',
  'seasonal',
  'year_in_review',
];
