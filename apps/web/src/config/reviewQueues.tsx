/**
 * The Review inbox registry — ONE declaration, several consumers.
 *
 * Spec §4.5. Review is **an inbox, not six parallel views**, and that
 * distinction picks the component: the user's job is "clear the badge", not
 * "visit Duplicates". So this is a list of queues with counts, at every
 * breakpoint — never tabs. Three facts make tabs actively wrong here:
 *
 *  - Counts change as the user works; that IS the content. A tab bar buries it
 *    in labels nobody is reading.
 *  - It is 4 + 2, not 6 — four draining queues plus two entries that are not
 *    queues at all (Insights is analytics, Automations is configuration).
 *  - The entry count is VARIABLE, 1 to 6, depending on feature flags. A tab bar
 *    whose width swings with configuration is the same spatial-memory failure
 *    a horizontal scroll strip has; a list absorbs variable length natively.
 *
 * `ReviewQueueList` renders this on phone and tablet as the hub body, and issue
 * #392 mounts the same component as the desktop context pane — which is why the
 * registry is data rather than JSX baked into a page.
 *
 * **Order is FIXED and must never be sorted by count** (spec §4.5 requirement
 * 2): rows that jump between visits are exactly the spatial-memory failure the
 * list exists to avoid. The counts move; the rows do not.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import BurstModeIcon from '@mui/icons-material/BurstMode';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import InsightsIcon from '@mui/icons-material/Insights';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import type { ReviewCountsResponse } from '../types/media';

/** Stable identifiers — also the `:queue` segment of `/review/:queue`. */
export type ReviewQueueKey =
  | 'bursts'
  | 'duplicates'
  | 'locations'
  | 'enhancements'
  | 'insights'
  | 'automations';

/**
 * Which feature flag gates an entry.
 *
 * `null` means always available. These are resolved by `useReviewQueues`, which
 * reads the SAME hooks `Sidebar` already uses — no new request is issued for
 * this registry.
 */
export type ReviewQueueFlag =
  | 'burstDetection'
  | 'duplicateDetection'
  | 'locationInference'
  | 'pictureEnhancement'
  | 'workflows'
  | null;

export interface ReviewQueueDef {
  key: ReviewQueueKey;
  label: string;
  Icon: SvgIconComponent;
  /** The pre-existing standalone route this entry wraps. Never redirected. */
  path: string;
  /**
   * Which of `GET /api/media/review-counts`' four integers this entry drains,
   * or `null` for the two entries that are not queues and carry no count.
   */
  countKey: keyof ReviewCountsResponse | null;
  flag: ReviewQueueFlag;
  /**
   * `queue` entries drain and carry a count; `secondary` entries sit below a
   * divider and are unaffected by an empty inbox.
   */
  group: 'queue' | 'secondary';
}

export const REVIEW_QUEUES: readonly ReviewQueueDef[] = [
  {
    key: 'bursts',
    label: 'Bursts',
    Icon: BurstModeIcon,
    path: '/bursts',
    countKey: 'pendingBurstGroups',
    flag: 'burstDetection',
    group: 'queue',
  },
  {
    key: 'duplicates',
    label: 'Duplicates',
    Icon: ContentCopyIcon,
    path: '/duplicates',
    countKey: 'pendingDuplicateGroups',
    flag: 'duplicateDetection',
    group: 'queue',
  },
  {
    key: 'locations',
    label: 'Locations',
    Icon: MyLocationIcon,
    path: '/location-suggestions',
    countKey: 'pendingLocationSuggestions',
    flag: 'locationInference',
    group: 'queue',
  },
  {
    key: 'enhancements',
    label: 'Enhancements',
    Icon: AutoFixHighIcon,
    path: '/enhancements',
    countKey: 'pendingEnhancements',
    flag: 'pictureEnhancement',
    group: 'queue',
  },
  {
    key: 'insights',
    label: 'Insights',
    Icon: InsightsIcon,
    path: '/review-insights',
    countKey: null,
    flag: null,
    group: 'secondary',
  },
  {
    key: 'automations',
    label: 'Automations',
    Icon: AccountTreeIcon,
    path: '/workflows',
    countKey: null,
    flag: 'workflows',
    group: 'secondary',
  },
];

/** Look an entry up by its `/review/:queue` segment. */
export function findReviewQueue(key: string | undefined): ReviewQueueDef | null {
  if (!key) return null;
  return REVIEW_QUEUES.find((q) => q.key === key) ?? null;
}
