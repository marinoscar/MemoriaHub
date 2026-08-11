/**
 * Cover imagery and live counts for the Collections hub (issue #391, spec §4.6).
 *
 * WHY THIS HOOK EXISTS AT ALL — spec §6.1 is blunt about it: Collections costs
 * one extra tap, and "if Collections ships as a text list, this proposal makes
 * the app worse". Real cover art and real counts are therefore requirements,
 * not polish, and this hook is where they come from.
 *
 * **It adds NO API.** Every count and every cover on this hub already has an
 * endpoint serving some other surface:
 *
 *   albums   → GET /api/media/albums            coverThumbnailUrl + meta.totalItems
 *   people   → GET /api/people                  cover faces + meta.totalItems
 *   places   → GET /api/media/explore/locations  per-tier coverThumbnailUrl + count
 *   memories → GET /api/memories/feed            up to 4 thumbnails per card
 *
 * THE LOAD-BEARING DESIGN DECISION is that the four requests are independent in
 * every sense: fired in parallel, stored in four separate state slots, and
 * resolved (or failed) one at a time. A `Promise.all` into one state update
 * would be far shorter and would break the hub's stated requirement — the
 * layout must be on screen immediately with covers filling in progressively,
 * never a full-page spinner, and a slow People request must not hold the Albums
 * cover hostage. So: one slot per source, one `setState` per source, always.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getExploreLocations, listAlbums } from '../services/media';
import type { ExploreLocationItem } from '../services/media';
import { listPeople } from '../services/face';
import type { PersonListItem } from '../services/face';
import { listMemories } from '../services/memories';
import { COLLECTIONS } from '../config/collections';
import type { CollectionDef, CollectionFlag, CollectionSource } from '../config/collections';
import { useCircle } from './useCircle';
import { useIsMounted } from './useIsMounted';
import { useMemoriesEnabled } from './useMemoriesEnabled';

/** The four sources that actually fetch. `null`-source entries (Map, Favorites, Archive, Trash) never appear here. */
export type CollectionSummarySource = Exclude<CollectionSource, null>;

/** How many covers a card wants. Four fills a 2x2 mosaic exactly. */
const COVER_TARGET = 4;

/**
 * How many memories to ask for. Large enough that most libraries answer
 * exactly, small enough to stay one cheap keyset page — `GET /api/memories` has
 * no `COUNT(*)`, so this is a page fetch, not a count query.
 */
const MEMORIES_PAGE_SIZE = 50;

/**
 * A count a card can show.
 *
 * `approximate` exists because one source can only bound its total: the
 * memories endpoint is keyset-paginated and returns `meta.hasMore` rather than
 * a total, so a full page means "at least this many". Modelling that as a flag
 * beside the number — rather than letting a `"50+"` string into a numeric field
 * — keeps every consumer able to render the visible label AND the accessible
 * name ("50 or more items") from the same value, which is what stops the two
 * from drifting apart.
 */
export interface CollectionCount {
  value: number;
  /** True when `value` is a floor, not an exact total. */
  approximate: boolean;
}

export interface CollectionSummary {
  /**
   * `loading` → render the card's skeleton cover, no count.
   * `ready`   → render covers (which may still be empty: an empty library has
   *             nothing to show, and that is not an error).
   * `error`   → render the card's own icon and OMIT the count. One failed
   *             request degrades exactly one card.
   */
  status: 'loading' | 'ready' | 'error';
  /** Signed thumbnail URLs, newest/richest first. Empty for `people` — see below. */
  coverUrls: string[];
  /**
   * People are rendered through `PersonAvatar` (face crop, profile-picture
   * override, video frame-thumbnail fallback) rather than a plain `<img>`, so
   * the People card needs the person RECORDS, not URLs. Populated only for the
   * `people` source; empty everywhere else.
   */
  people: PersonListItem[];
  /** `null` means "no count to show" — either not loaded, failed, or genuinely unavailable. */
  count: CollectionCount | null;
}

export interface UseCollectionSummariesResult {
  /**
   * The flag-filtered collection registry, in `COLLECTIONS` order.
   *
   * Exposed so the card grid and `CollectionsList` gate from ONE check: the two
   * surfaces are the same list at two sizes (spec §4.6), and two independent
   * flag reads is exactly how they would drift.
   */
  entries: CollectionDef[];
  summaries: Record<CollectionSummarySource, CollectionSummary>;
}

const LOADING: CollectionSummary = {
  status: 'loading',
  coverUrls: [],
  people: [],
  count: null,
};

/** A source that will not be fetched at all (feature off / no circle) rests here, not at `loading`. */
const UNAVAILABLE: CollectionSummary = {
  status: 'ready',
  coverUrls: [],
  people: [],
  count: null,
};

function initialState(): Record<CollectionSummarySource, CollectionSummary> {
  return { albums: LOADING, people: LOADING, places: LOADING, memories: LOADING };
}

// ---------------------------------------------------------------------------
// Per-source loaders. Each returns a complete summary or throws; the caller
// turns a throw into that ONE card's `error` state.
// ---------------------------------------------------------------------------

async function loadAlbums(circleId: string): Promise<CollectionSummary> {
  const res = await listAlbums({ circleId, pageSize: COVER_TARGET });
  return {
    status: 'ready',
    // `coverThumbnailUrl` already resolves the chosen cover, else the most
    // recent member's thumbnail — so an album with no explicit cover still
    // contributes real imagery.
    coverUrls: res.items
      .map((album) => album.coverThumbnailUrl ?? null)
      .filter((url): url is string => Boolean(url)),
    people: [],
    // Offset-paginated, so this is a real `COUNT(*)` total.
    count: { value: res.meta.totalItems, approximate: false },
  };
}

async function loadPeople(circleId: string): Promise<CollectionSummary> {
  const res = await listPeople(circleId, { pageSize: COVER_TARGET });
  return {
    status: 'ready',
    coverUrls: [],
    people: res.items,
    count: { value: res.meta.totalItems, approximate: false },
  };
}

/**
 * Places: one request returns all three tiers, each already carrying a cover
 * and a count.
 *
 * **Which tier is "the count"?** Cities — the finest tier, and the one a person
 * actually means by "a place" ("38 places" reads as 38 towns, not 3 countries).
 * But a library geocoded only to country level has zero cities while `/places`
 * itself renders a full countries row, and a card reading "0" beside a page
 * full of content is a lie of the same class as `favorite=true`. So the rule is
 * **the finest tier that actually has data**: cities, else regions, else
 * countries. That can never contradict what the page behind the card shows.
 *
 * Covers come from the same tier for coherence, topped up from the coarser
 * tiers only when that tier cannot fill the mosaic — better a full 2x2 of real
 * photos than one stretched thumbnail.
 */
async function loadPlaces(circleId: string): Promise<CollectionSummary> {
  const res = await getExploreLocations(circleId);
  const tiers: ExploreLocationItem[][] = [res.cities, res.regions, res.countries];
  const primary = tiers.find((tier) => tier.length > 0) ?? [];

  const coverUrls: string[] = [];
  for (const tier of [primary, ...tiers]) {
    for (const entry of tier) {
      if (!entry.coverThumbnailUrl) continue;
      if (coverUrls.includes(entry.coverThumbnailUrl)) continue;
      coverUrls.push(entry.coverThumbnailUrl);
      if (coverUrls.length >= COVER_TARGET) break;
    }
    if (coverUrls.length >= COVER_TARGET) break;
  }

  return {
    status: 'ready',
    coverUrls,
    people: [],
    // Distinct places at the chosen tier. `primary.length`, not a sum of the
    // item counts — the card names how many places there are, not how many
    // photos are in them. The endpoint returns the whole tier, so it is exact.
    count: { value: primary.length, approximate: false },
  };
}

/**
 * Memories: one keyset page of `GET /api/memories` supplies BOTH the covers and
 * the count.
 *
 * **Deliberately `listMemories`, not `getMemoriesFeed`.** The feed is capped
 * server-side at 10 cards and carries no total, so counting its items would
 * print "10" for a library with two hundred memories — plausible, wrong, and it
 * would survive a click-through review. The list endpoint has no `COUNT(*)`
 * either (it is keyset-paginated), but it does report `meta.hasMore`, which is
 * enough to state the truth precisely:
 *
 *   hasMore === false → the page IS the whole set; the count is exact.
 *   hasMore === true  → the page is a floor; the count is approximate, and the
 *                       consumers render it as "50+" / "50 or more items".
 *
 * `items.length` rather than the requested page size, so a server that returns
 * fewer than asked can never inflate the floor.
 */
async function loadMemories(circleId: string): Promise<CollectionSummary> {
  const res = await listMemories({ circleId, pageSize: MEMORIES_PAGE_SIZE });
  const coverUrls: string[] = [];

  for (const card of res.items) {
    const url = card.coverThumbnailUrl;
    if (!url || coverUrls.includes(url)) continue;
    coverUrls.push(url);
    if (coverUrls.length >= COVER_TARGET) break;
  }

  return {
    status: 'ready',
    coverUrls,
    people: [],
    count: { value: res.items.length, approximate: res.meta.hasMore },
  };
}

const LOADERS: Record<CollectionSummarySource, (circleId: string) => Promise<CollectionSummary>> = {
  albums: loadAlbums,
  people: loadPeople,
  places: loadPlaces,
  memories: loadMemories,
};

export function useCollectionSummaries(): UseCollectionSummariesResult {
  const { activeCircleId } = useCircle();
  const memoriesEnabled = useMemoriesEnabled();
  const isMounted = useIsMounted();

  const [summaries, setSummaries] =
    useState<Record<CollectionSummarySource, CollectionSummary>>(initialState);

  // Bumped on every (re)fetch. A response from the previous circle resolving
  // after the user has already switched must be dropped, or the Albums card
  // shows the old circle's covers under the new circle's name.
  const generationRef = useRef(0);

  // `=== true`, never a truthy check — the convention Sidebar and
  // `useReviewQueues` both document. `null` (flags still in flight, or a flags
  // outage, which resolves to null rather than throwing) HIDES the entry rather
  // than guessing it on.
  const isFlagEnabled = useCallback(
    (flag: CollectionFlag): boolean => (flag === null ? true : memoriesEnabled === true),
    [memoriesEnabled],
  );

  const entries = useMemo(
    () => COLLECTIONS.filter((def) => isFlagEnabled(def.flag)),
    [isFlagEnabled],
  );

  useEffect(() => {
    const generation = ++generationRef.current;

    // No circle selected: issue nothing. There is no query to make, and firing
    // four requests that must 400 is worse than showing four empty cards.
    if (!activeCircleId) {
      setSummaries({
        albums: UNAVAILABLE,
        people: UNAVAILABLE,
        places: UNAVAILABLE,
        memories: UNAVAILABLE,
      });
      return;
    }

    // Memories off (or its flag not resolved yet): no request for a feature
    // that is not on screen. Its entry is filtered out of `entries` too, so
    // nothing reads this slot.
    const sources: CollectionSummarySource[] = (
      ['albums', 'people', 'places', 'memories'] as const
    ).filter((source) => source !== 'memories' || memoriesEnabled === true);

    setSummaries({
      albums: LOADING,
      people: LOADING,
      places: LOADING,
      memories: memoriesEnabled === true ? LOADING : UNAVAILABLE,
    });

    // Fired together, settled apart. Each `.then`/`.catch` writes exactly its
    // own key through the functional updater, so four in-flight requests cannot
    // clobber each other's slots regardless of the order they land in — and one
    // card's failure leaves the other three untouched.
    for (const source of sources) {
      void LOADERS[source](activeCircleId)
        .then((summary) => {
          if (!isMounted() || generationRef.current !== generation) return;
          setSummaries((prev) => ({ ...prev, [source]: summary }));
        })
        .catch(() => {
          if (!isMounted() || generationRef.current !== generation) return;
          setSummaries((prev) => ({
            ...prev,
            [source]: { status: 'error', coverUrls: [], people: [], count: null },
          }));
        });
    }
  }, [activeCircleId, memoriesEnabled, isMounted]);

  return { entries, summaries };
}
