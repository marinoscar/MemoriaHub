# Tiered Places Browsing — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [API Endpoints](#2-api-endpoints)
3. [Grouping and Efficiency](#3-grouping-and-efficiency)
4. [Archived-Item Exclusion Rationale](#4-archived-item-exclusion-rationale)
5. [Cover Thumbnail Signing](#5-cover-thumbnail-signing)
6. [`geoCountryCode` vs `geoCountry` Indexing Decision](#6-geocountrycode-vs-geocountry-indexing-decision)
7. [Frontend Routes](#7-frontend-routes)
8. [Tile → Media-Filter Deep-Linking](#8-tile--media-filter-deep-linking)
9. [Relationship to `facets/locations`](#9-relationship-to-facetslocations)

---

## 1. Overview and Goals

Tiered Places Browsing gives users a way to explore their photo library by location without needing to already know a place name. Before this feature, the only location browsing surface was a single flat "Places" row in the Explore view (`explore/places`, grouped by `geoPlaceName`) — useful once a user has a specific place in mind, but poor for open-ended discovery ("what countries have we visited?").

This feature adds a second, hierarchical view — Country → Region → City — surfaced through a dedicated `/places` hub and reachable from the Explore view's "See all places" link (which previously read "View all in map" and pointed at `/map`).

### Goals

- Let users browse by geographic tier (countries, regions, cities) with counts and cover images, independent of the existing flat `geoPlaceName` grouping.
- Keep the overview cheap: a single `groupBy` query answers all three tiers in one round trip, with cover thumbnails fetched only for the handful of groups that survive the top-12 cap.
- Reuse the same tile → deep-link pattern already used by the tag tiles, so filtering the media library by location requires no new query-building logic on the frontend.

### Non-Goals

- No new database columns or migrations. The feature reads existing `geoCountry`, `geoCountryCode`, `geoAdmin1`, and `geoLocality` columns populated by the geocoding pipeline (see [geocoding.md](geocoding.md)).
- This is not a replacement for `GET /api/media/explore/places` (flat `geoPlaceName` grouping) or `GET /api/media/facets/locations` (cascading Country → Region → Locality facets used by `SearchPanel`). All three endpoints coexist; see [§9](#9-relationship-to-facetslocations).
- No map view is involved. `/places*` renders grid/carousel tiles only.

---

## 2. API Endpoints

Both endpoints live in `MediaController` (`apps/api/src/media/media.controller.ts`) and `MediaService` (`apps/api/src/media/media.service.ts`), mounted under `/api/media/explore/locations`. Both require `media:read` plus per-circle `viewer` role (or the `media:read_any` admin bypass).

### 2.1 Tiered Overview

`GET /api/media/explore/locations?circleId=<uuid>`

Returns the top 12 entries per tier, each sorted by item count descending:

```json
{
  "countries": [
    { "name": "Costa Rica", "countryCode": "CR", "count": 214, "coverThumbnailUrl": "https://..." }
  ],
  "regions": [
    { "name": "San José Province", "count": 98, "coverThumbnailUrl": "https://..." }
  ],
  "cities": [
    { "name": "San José", "count": 51, "coverThumbnailUrl": "https://..." }
  ]
}
```

Only `countries` entries carry `countryCode`; `regions` and `cities` entries do not (region/city names are not guaranteed globally unique across countries, but disambiguation by country was judged unnecessary for a top-12 overview — see [§6](#6-geocountrycode-vs-geocountry-indexing-decision)).

### 2.2 Full List for One Tier

`GET /api/media/explore/locations/:level?circleId=<uuid>`

- `level` path param must be one of `countries`, `regions`, `cities`; any other value returns `400 Bad Request`.
- Response: `Array<{ name, countryCode?, count, coverThumbnailUrl }>`, sorted by count descending, capped at 500 entries.
- Route is deliberately nested under `explore/locations/:level` (not a sibling top-level route) so it can never collide with or be shadowed by the `:id` media-item route.

Powers the `/places/countries`, `/places/regions`, and `/places/cities` full-list grid pages, which show every location tier entry rather than the top-12 preview.

---

## 3. Grouping and Efficiency

Both endpoints share a single private helper, `MediaService.fetchGeoGroupRows`, which runs one Prisma `groupBy` over all four geo columns at once:

```typescript
this.prisma.mediaItem.groupBy({
  by: ['geoCountry', 'geoCountryCode', 'geoAdmin1', 'geoLocality'],
  where: { circleId, deletedAt: null, archivedAt: null, geoCountry: { not: null } },
  _count: { _all: true },
});
```

`buildLocationLevel` then folds those rows into a per-tier map (summing counts for rows that share the same country/region/city key), sorts by count descending, and slices to the requested cap (12 for the overview, 500 for the full-list endpoint).

**Cover thumbnails are not part of the `groupBy`.** They are fetched afterward with one bounded `findFirst` per *surviving* group (i.e. at most 12, or up to 500 for the full-list endpoint), run in parallel via `Promise.all`, ordered by `capturedAt desc`. This means:

- The `groupBy` itself scans the circle's geo columns once, regardless of how many distinct countries/regions/cities exist.
- Cover-image work scales with the number of groups actually returned to the client, never with the total item count — unlike `explorePlaces`, which performs a broader per-place metadata scan.

This is the efficiency property referenced in the CLAUDE.md endpoint bullets: "counts come from a single groupBy and covers from bounded per-group lookups rather than a full metadata scan."

---

## 4. Archived-Item Exclusion Rationale

`fetchGeoGroupRows` filters on both `deletedAt: null` and `archivedAt: null`. This aligns tiered location browsing with the other browse surfaces — Home, the circle dashboard, Albums, People, and Map all exclude archived items (see [archive-trash.md §4](archive-trash.md#4-search-inclusion-asymmetry)).

This is a deliberate divergence from `GET /api/media/facets/locations`, which does **not** filter on `archivedAt` because it feeds `SearchPanel`, and search includes archived items by default. Tiered Places Browsing is a *browse* surface, not a *search* surface, so it follows the browse convention instead.

---

## 5. Cover Thumbnail Signing

Cover images are resolved from the `metadata` column of the single item returned by each group's `findFirst` lookup (most-recently-captured item in the group), then passed through the same `signThumb` helper used elsewhere in `MediaService` to produce a signed, time-limited thumbnail URL. If a group's cover item has no thumbnail metadata (e.g. still processing), `coverThumbnailUrl` is `null` and the frontend renders a `PlaceIcon` fallback tile instead of an image.

---

## 6. `geoCountryCode` vs `geoCountry` Indexing Decision

Countries are grouped and re-queried by `geoCountryCode` (e.g. `"CR"`) rather than by the display name `geoCountry` (e.g. `"Costa Rica"`) whenever the code is present, because `geoCountryCode` is the indexed column used elsewhere for country-scoped queries (see [search-audit.md §4](../audits/search-audit.md#facets-endpoint-response-shape) and the existing `(circle_id, geo_country_code)`-style access patterns). The display name is still returned to the client (`name: "Costa Rica"`) for rendering; only the grouping/lookup key changes.

When `geoCountryCode` is null (which can happen for older or offline-geocoded items — see [geocoding.md §2.3](geocoding.md#offline-provider)), the code falls back to grouping and re-querying by the raw `geoCountry` string.

**No migration was added for this feature.** `geoCountryCode` already existed and was already indexed prior to this work; Tiered Places Browsing only changes which column the application-level grouping keys off of, not the schema.

---

## 7. Frontend Routes

| Route | Component | Purpose |
|---|---|---|
| `/places` | `apps/web/src/pages/Places/PlacesOverviewPage.tsx` | Overview hub — three `ExploreCarousel` rows (Countries / Regions / Cities), each showing up to 10 tiles with a "Show all" link to the corresponding full-list page |
| `/places/countries` | `apps/web/src/pages/Places/LevelBrowsePage.tsx` (`level="countries"`) | Full responsive grid of all countries (up to 500) |
| `/places/regions` | `apps/web/src/pages/Places/LevelBrowsePage.tsx` (`level="regions"`) | Full responsive grid of all regions |
| `/places/cities` | `apps/web/src/pages/Places/LevelBrowsePage.tsx` (`level="cities"`) | Full responsive grid of all cities |

Routes are registered lazily in `apps/web/src/App.tsx`. `PlacesOverviewPage` calls `getExploreLocations(circleId)` (`apps/web/src/services/media.ts`); `LevelBrowsePage` calls the corresponding full-list endpoint for its `level`.

### Explore view changes

The Explore view (`/search`, `apps/web/src/pages/SearchPage.tsx`) previously rendered a single flat "Places" row (backed by `explore/places`) with a "View all in map" button linking to `/map`. It now renders three tiered rows — Countries, Regions, Cities — backed by `GET /api/media/explore/locations`, and the button is replaced with "See all places", linking to `/places`. The flat `explore/places` endpoint and its underlying `geoPlaceName` grouping are unchanged and still exist in the API — only its UI row on the Explore view was retired in favor of the tiered rows; see [§9](#9-relationship-to-facetslocations) for how the endpoints now relate.

---

## 8. Tile → Media-Filter Deep-Linking

Every location tile — on `/places`, `/places/countries|regions|cities`, and the Explore rows on `/search` — as well as the pre-existing tag tiles, navigate to the media library with a query-string filter rather than opening a dedicated detail page:

| Tile type | Deep-link |
|---|---|
| Country | `/media?country=<name>` |
| Region | `/media?region=<name>` |
| City (locality) | `/media?locality=<name>` |
| Tag | `/media?tag=<name>` |

The mapping and URL-building logic live in `apps/web/src/pages/Places/LocationTile.tsx` (`locationHref`, `LocationParam`), shared between the compact carousel tile (`renderLocationTile`, used on `/places` and `/search`) and the full-page grid tile on `LevelBrowsePage`.

`MediaLibraryPage` (`apps/web/src/pages/MediaLibrary/MediaLibraryPage.tsx`) reads `country`, `region`, and `locality` from `useSearchParams()` on mount and seeds its location drill-down filter state (`filterCountry`, `filterRegion`, `filterLocality`) from them, alongside the pre-existing single-`tag` URL seeding. This means a tile click produces a normal browser-navigable URL — sharable, bookmarkable, and back-button-safe — without introducing any new client-side filter-encoding scheme.

---

## 9. Relationship to `facets/locations`

Three location-related read endpoints now exist side by side, each serving a different surface:

| Endpoint | Consumer | Grouping | Archived items | Cap |
|---|---|---|---|---|
| `GET /api/media/explore/places` | Explore "flat places" row (pre-existing) | `geoPlaceName` | Excluded (browse surface) | — |
| `GET /api/media/facets/locations` | `SearchPanel` cascading Country → Region → Locality pick-lists | `geoCountry` → `geoAdmin1` → `geoLocality`, nested | **Included** (search surface — see [archive-trash.md §4](archive-trash.md#4-search-inclusion-asymmetry)) | — (all distinct values) |
| `GET /api/media/explore/locations` (+ `/:level`) | `/places` tiered hub and its full-list pages | `geoCountryCode`/`geoCountry` (top level only, not nested) → `geoAdmin1` → `geoLocality` — three independent flat tiers, not a cascade | Excluded (browse surface) | 12 (overview) / 500 (full-list) |

The new tiered endpoints are intentionally **flat per tier**, not a nested cascade like `facets/locations` — the `/places` hub answers "what are the top countries/regions/cities overall," while `facets/locations` answers "given this country, what regions exist within it," which is what a cascading picker needs. Both read from the same underlying geo columns but are optimized for different UI shapes and are expected to diverge further if either surface's requirements change.

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | July 2026 | AI Assistant | Initial specification matching shipped implementation |
