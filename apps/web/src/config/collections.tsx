/**
 * The Collections registry — ONE declaration, two surfaces.
 *
 * Spec §4.6. Collections has the same two-surface shape as the Review inbox and
 * must resolve it identically, or the two hubs drift into different interaction
 * models for no reason:
 *
 *   phone / tablet  →  the rich CARD GRID (`CollectionsHubPage`)
 *   desktop (≥ lg)  →  the context pane lists these, and `/collections`
 *                      resolves straight into Albums in the main area
 *
 * On desktop `/collections` deliberately does NOT render the card grid: the
 * pane already gives the overview with live counts, so a grid beside it is a
 * menu next to a menu. Landing directly in Albums puts photos on screen in zero
 * clicks — mirroring `/review` → first queue exactly.
 *
 * **This is also what makes the §6.1 trade-off coherent.** The extra tap
 * Collections introduces exists ONLY on phone and tablet; desktop has the pane
 * and pays no tap at all. So the expensive cover-art requirement applies
 * precisely where the cost it offsets is real — and nowhere else. Do not build
 * cover art for a breakpoint that does not need it.
 *
 * Ordering and grouping here are authoritative for BOTH surfaces: the primary
 * five, then a divider, then Favorites / Archive / Trash. The secondary three
 * are lower-frequency, and Trash in particular should never read as a primary
 * browse target.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import AlbumIcon from '@mui/icons-material/PhotoAlbum';
import GroupsIcon from '@mui/icons-material/Groups';
import PublicIcon from '@mui/icons-material/Public';
import AutoAwesomeMotionIcon from '@mui/icons-material/AutoAwesomeMotion';
import MapIcon from '@mui/icons-material/Map';
import StarIcon from '@mui/icons-material/Star';
import ArchiveIcon from '@mui/icons-material/Archive';
import DeleteIcon from '@mui/icons-material/Delete';

/** Stable identifiers. These are also the `pinned` keys in `user_settings.navigation`. */
export type CollectionKey =
  | 'albums'
  | 'people'
  | 'places'
  | 'memories'
  | 'map'
  | 'favorites'
  | 'archive'
  | 'trash';

/** Which cover/count source a card draws on, or `null` for an icon-only entry. */
export type CollectionSource = 'albums' | 'people' | 'places' | 'memories' | null;

export type CollectionFlag = 'memories' | null;

export interface CollectionDef {
  key: CollectionKey;
  label: string;
  Icon: SvgIconComponent;
  path: string;
  /**
   * Where this card's cover imagery and live count come from. Every one of
   * these already has an endpoint — **do not add an API for this hub.**
   *   albums   → GET /api/media/albums          (coverThumbnailUrl, itemCount)
   *   people   → GET /api/people                (coverFace, meta.totalItems)
   *   places   → GET /api/media/explore/locations (coverThumbnailUrl, count)
   *   memories → GET /api/memories/feed         (up to 4 thumbnails per card)
   */
  source: CollectionSource;
  flag: CollectionFlag;
  /** `primary` renders as a cover card; `secondary` sits below the divider. */
  group: 'primary' | 'secondary';
}

export const COLLECTIONS: readonly CollectionDef[] = [
  {
    key: 'albums',
    label: 'Albums',
    Icon: AlbumIcon,
    path: '/albums',
    source: 'albums',
    flag: null,
    group: 'primary',
  },
  {
    key: 'people',
    label: 'People',
    Icon: GroupsIcon,
    path: '/people',
    source: 'people',
    flag: null,
    group: 'primary',
  },
  {
    key: 'places',
    label: 'Places',
    Icon: PublicIcon,
    path: '/places',
    source: 'places',
    flag: null,
    group: 'primary',
  },
  {
    key: 'memories',
    label: 'Memories',
    Icon: AutoAwesomeMotionIcon,
    path: '/memories',
    source: 'memories',
    flag: 'memories',
    group: 'primary',
  },
  {
    key: 'map',
    label: 'Map',
    Icon: MapIcon,
    path: '/map',
    source: null,
    flag: null,
    group: 'primary',
  },
  {
    key: 'favorites',
    label: 'Favorites',
    Icon: StarIcon,
    // `favorite=1`, NOT `favorite=true`. MediaLibraryPage reads the param as the
    // literal string '1' (`searchParams.get('favorite') === '1'`), so
    // `favorite=true` does not error — it renders an UNFILTERED library that
    // looks like a working Favorites view containing every photo. That failure
    // mode passes a click-through review and is wrong in the product. The
    // neighbouring params follow the same convention (`missingGeo=1`,
    // `noFaces=1`), so any card added here must use `=1` too.
    //
    // KNOWN GAP (issue #392), recorded rather than fixed: `/media` is owned by
    // the `photos` destination in `config/destinations.ts` — spec §3.5's
    // explicit table — and `resolveActiveDestination` only ever sees a
    // PATHNAME, never the query string. So navigating to Favorites resolves the
    // active destination to `photos`, and the desktop context pane (which
    // renders only for Collections and Review) closes instead of staying open
    // with this row selected. Every other entry in this registry keeps the pane
    // open; this one does not.
    //
    // It is left alone deliberately. Re-pointing `/media` at `collections`
    // would contradict §3.5 and break the "no route is claimed by two
    // destinations" test, since the same prefix carries the unfiltered
    // timeline. A real fix needs either a dedicated `/favorites` route or
    // query-aware route ownership, and both are IA changes well outside this
    // issue. Nothing is unreachable in the meantime — Favorites still
    // navigates and still filters correctly.
    path: '/media?favorite=1',
    source: null,
    flag: null,
    group: 'secondary',
  },
  {
    key: 'archive',
    label: 'Archive',
    Icon: ArchiveIcon,
    path: '/archive',
    source: null,
    flag: null,
    group: 'secondary',
  },
  {
    key: 'trash',
    label: 'Trash',
    Icon: DeleteIcon,
    path: '/trash',
    source: null,
    flag: null,
    group: 'secondary',
  },
];
