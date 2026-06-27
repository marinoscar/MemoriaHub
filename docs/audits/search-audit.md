# Search Overhaul — Audit and Fix Record

| Field | Value |
|-------|-------|
| **Date** | 2026-06-27 |
| **Branch** | `feat/search-overhaul` |
| **Status** | Implemented |

---

This document records the issues found in the MemoriaHub search module during the search-overhaul sprint, the root causes, the fixes applied, and how to verify each fix end-to-end. It is written as a permanent reference so future contributors understand why the search layer is shaped the way it is.

---

## Table of Contents

1. [Symptoms Reported](#1-symptoms-reported)
2. [Root Causes](#2-root-causes)
3. [Fixes Delivered](#3-fixes-delivered)
4. [Architecture Notes](#4-architecture-notes)
5. [Verification Checklist](#5-verification-checklist)
6. [Follow-Ups and Known Limitations](#6-follow-ups-and-known-limitations)

---

## 1. Symptoms Reported

The following problems were reported by users before this sprint:

- **AI / agentic search showed only spinners.** Results panels appeared but each card displayed a placeholder spinner indefinitely — no images ever rendered.
- **Deterministic search returned extra results.** Combining two or more filters (e.g. a country filter together with a type or tag filter) returned items that did not match all criteria — unrelated photos leaked into the result set.
- **Searching by country "Costa Rica" returned nothing** despite the library containing photos taken in Costa Rica.
- **Searching by a person's name returned no results.** Typing a person's name into the search box (deterministic mode) produced an empty result set even when matching photos existed.

---

## 2. Root Causes

### 2.1 Filter composition collision

**Files:** `apps/api/src/search/searchable-fields.registry.ts` (`buildWhereFromFields`), `apps/api/src/search/media-where.builder.ts` (`buildMediaWhere`)

Each searchable field descriptor produces a Prisma `where` fragment. Both builder functions previously merged those fragments using `Object.assign` / object spread at the top level. When two descriptors each emitted a top-level `OR` clause (for example, the country filter and the `missingCamera: false` guard both do so), the second assignment silently overwrote the first key, destroying the first filter entirely. The resulting query matched all items that satisfied only the last-written filter, explaining the "extra results" symptom.

**Fix:** Every descriptor's contribution is now pushed into a shared `AND: []` array. No two descriptors can collide on a key because their clauses are siblings inside the `AND` array, not top-level siblings of the `where` object.

---

### 2.2 Search results lacked signed thumbnail URLs

**File:** `apps/api/src/search/search.service.ts` (`runSearch`)

`SearchService.runSearch()` returned raw Prisma rows. It never called the URL-signing step that `MediaService.listMedia()` applies via the storage provider. The gallery component treats a missing or unsigned `thumbnailUrl` as "not yet loaded" and renders a spinner. Because neither the deterministic search endpoint nor the agentic search agent (which calls `runSearch` internally) signed thumbnails, every search result displayed a spinner permanently.

**Fix:** A shared `MediaThumbnailService` was extracted and called from both `runSearch` return paths. Both deterministic results (`POST /api/search`) and agentic `results` SSE events now include a signed `thumbnailUrl` per item. The agent inherits the fix automatically because it delegates to `runSearch`.

---

### 2.3 Country search returned nothing — geocode data gap

The `whereCountry` filter in the where-builder is correct. Items uploaded via the CLI, however, were never put through the reverse-geocoding pipeline, so their `geoCountry` and `geoCountryCode` columns were `NULL`. A filter on those columns produced zero rows even though the GPS coordinates were present.

This is a data gap, not a code bug in the search layer. The fix is operational: run the admin geocode backfill (`POST /api/admin/geocode/backfill` with `{ "force": true }`) after verifying the active reverse provider is set in Admin Settings → Geo. The new `SearchPanel` also surfaces only distinct, non-null country values from the facets endpoint, so users see an empty pick-list rather than a mysterious null result when geo data has not been populated.

---

### 2.4 Person-name search

The deterministic `people` filter accepts UUIDs only — it does not resolve names to IDs server-side. When a user typed a person's name into the old `AdvancedSearchDialog`, the string was sent as-is in the `personId` field, which never matched any UUID.

The agentic search agent already handles name resolution correctly: `resolvePersonNames` / `resolvePeopleFilter` in `apps/api/src/search/agent/search-agent.service.ts` performs a case-insensitive, circle-scoped look-up and converts names to IDs before calling `runSearch`. The visible failure for typed-name queries was actually root cause 2.2 on top of this ID mismatch — even when the agent resolved names correctly, results never rendered.

**Fix (UI):** The new `SearchPanel` (`apps/web/src/components/search/SearchPanel.tsx`) replaces the text-based people input with a people multi-select that sends IDs directly, eliminating the name-vs-ID confusion for deterministic mode. Natural-language person queries continue to work in agentic mode as before.

---

## 3. Fixes Delivered

- **AND-array composition in both where-builders** (`buildWhereFromFields` and `buildMediaWhere`). Top-level key collisions between filter descriptors are structurally impossible.
- **Shared `MediaThumbnailService`** extracted and called from `SearchService.runSearch()`; both `POST /api/search` responses and agentic `results` SSE events now carry signed `thumbnailUrl` per item.
- **New `GET /api/media/facets/locations` endpoint** — returns the `Country → Region → Locality` hierarchy present in the circle with item counts, used by the cascading pick-lists in `SearchPanel`.
- **New `near` map-radius filter** — `whereNear` builds a bounding-box `AND` over `takenLat`/`takenLng`; exposed as the `geo-radius` descriptor in the field registry, added to the search DTO, and included in the agent's `search_media` tool schema. Value shape: `{ lat: number, lng: number, radiusKm: number }`.
- **Purpose-built `SearchPanel`** (`apps/web/src/components/search/SearchPanel.tsx`) replaces the generic `AdvancedSearchDialog`. Features: cascading Country → Region → Locality pick-lists (populated from the facets endpoint), a map-radius mode, people multi-select (IDs, not names), date range, media type, tags, semantic-query text box, and boolean flag switches (`noFaces`, `excludeArchived`, `missingCapturedAt`, `missingCamera`).

---

## 4. Architecture Notes

### Single thumbnail-signing helper

`MediaThumbnailService` is injected into both `MediaService` and `SearchService`. All search result paths — deterministic and agentic — go through the same signing logic, so URL expiry settings, CDN rewrites, and future storage-provider changes apply everywhere automatically.

### AND-array composition invariant

After this fix the contract for every filter descriptor is: return a Prisma `where` fragment; the caller will insert it as an element of `AND: []`. Descriptors must never assume they own the top level of the `where` object. This invariant should be enforced in code review for any future descriptor additions.

### Facets endpoint response shape

```
GET /api/media/facets/locations?circleId=<uuid>

Array<{
  country: string;
  countryCode: string;
  count: number;
  regions: Array<{
    name: string;
    count: number;
    localities: Array<{ name: string; count: number }>;
  }>;
}>
```

Entries are omitted if `geoCountry` is NULL, so the list reflects only geocoded items.

### Near filter value shape

```json
{ "near": { "lat": 9.93, "lng": -84.08, "radiusKm": 25 } }
```

The server computes a bounding box `(lat ± delta, lng ± delta)` where `delta = radiusKm / 111.32`. Items whose `takenLat`/`takenLng` fall outside the box are excluded. This is a rectangular approximation — see [Section 6](#6-follow-ups-and-known-limitations) for the v1 limitation.

---

## 5. Verification Checklist

| Check | How to verify |
|-------|--------------|
| Geocode data populated | Run `POST /api/admin/geocode/backfill { "force": true }`. Monitor `GET /api/admin/jobs` until the backfill jobs reach `succeeded`. Then query `GET /api/media/facets/locations?circleId=<id>` and confirm Costa Rica appears. |
| Multi-filter AND composition | Submit a search with `country` + `type: photo` + `missingCamera: false`. Confirm all returned items satisfy every criterion — no video or non-Costa-Rica items appear. |
| Deterministic results render thumbnails | Run `POST /api/search` with any filter. Confirm every item in the response has a non-empty, HTTPS-signed `thumbnailUrl`. Open the gallery — no spinner cards. |
| Agentic results render thumbnails | Open the AI chat and ask "show me photos from Costa Rica". Confirm the `results` SSE event contains items with signed `thumbnailUrl`. Gallery renders images. |
| Country pick-list returns results | Open `SearchPanel`, expand Location, select "Costa Rica" from the Country drop-down. Confirm results appear (requires geocode backfill above). |
| Map-radius filter returns results | In `SearchPanel`, switch to Map Radius mode, drop a pin near San José, set radius to 25 km, and submit. Confirm only items with GPS within the bounding box are returned. |
| People multi-select returns correct photos | Open `SearchPanel`, select one or more people from the People multi-select. Confirm returned photos contain the selected people. |
| Agent resolves people by name | In AI chat, ask "show me photos of [person name]". Confirm the agent calls `search_media` with `personId` (UUID), not the raw name. Results render thumbnails. |

---

## 6. Follow-Ups and Known Limitations

- **`near` uses a bounding-box approximation.** The `whereNear` implementation computes `lat ± (radiusKm / 111.32)` and `lng ± (radiusKm / (111.32 × cos(lat)))` to avoid a PostGIS dependency. For small radii (under ~50 km) the error is negligible; for larger radii or polar regions it will be inaccurate. A future iteration can switch to a PostGIS `ST_DWithin` query or pgvector-based geo index once the dependency is accepted.
- **Semantic search requires embedding configuration.** `semanticQuery` in `SearchPanel` falls back to filter-only mode if `ai.features.embedding` is not configured in Admin Settings → AI. The UI shows a tooltip warning when the feature is not available.
- **Facets reflect geocoded items only.** If most items in a circle have not been geocoded, the Country/Region/Locality pick-lists will appear sparse. Run the geocode backfill to populate them.
- **Person name resolution in deterministic mode** relies on the pick-list sending UUIDs. Free-text person queries continue to require the agentic mode, which performs server-side name resolution.
