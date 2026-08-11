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
import {
  PhotoAlbum as AlbumIcon,
  Groups as GroupsIcon,
  Public as PublicIcon,
  AutoAwesomeMotion as AutoAwesomeMotionIcon,
  Map as MapIcon,
  Star as StarIcon,
  Archive as ArchiveIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';

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
