# Location Grouping — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Specification (not yet implemented) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [The Problem This Solves](#2-the-problem-this-solves)
3. [Data Model](#3-data-model)
4. [Name Normalization](#4-name-normalization)
5. [Resolution — How a Raw Name Becomes a Canonical Name](#5-resolution--how-a-raw-name-becomes-a-canonical-name)
6. [Write-Path Integration](#6-write-path-integration)
7. [Read-Path Migration](#7-read-path-migration)
8. [The `location_group_rebuild` Job](#8-the-location_group_rebuild-job)
9. [API Endpoints](#9-api-endpoints)
10. [RBAC](#10-rbac)
11. [Configuration](#11-configuration)
12. [Frontend](#12-frontend)
13. [Implementation Notes and Gotchas](#13-implementation-notes-and-gotchas)
14. [Testing Notes](#14-testing-notes)
15. [Known Limitations and Non-Goals](#15-known-limitations-and-non-goals)
16. [Future Work](#16-future-work)

---

## 1. Overview and Goals

Location Grouping lets an administrator merge many raw reverse-geocoder place names into **one canonical name per tier** — Country, Region, City — give that group a **cover photo**, and have the mapping apply **automatically to future uploads** as well as retroactively to the existing library.

### Goals

- Collapse spelling/language variants of the same place ("Heredia", "Heredia Province", "Provincia de Heredia") into a single browsable entry.
- Collapse *genuinely different but practically equivalent* places ("Conroe", "Shenandoah", "The Woodlands") into one entry the user actually thinks in.
- Let a group own a **geographic area** (centre + radius) so a future photo whose geocoder returns a name nobody has ever seen still lands in the right group.
- Give each group a chosen **cover photo**, overriding the "most recently captured item" heuristic that Tiered Places Browsing uses today.
- Keep the raw geocoder output **fully intact and reversible** — disabling the feature restores the original names exactly.

### Non-Goals (v1)

- **Per-circle groups.** Groups are global and Admin-managed; a place name is a fact about the world, not about one family circle.
- **Grouping `geo_admin2` or `geo_place_name`.** Only the three tiers users actually browse (`geo_country`, `geo_admin1`, `geo_locality`) participate.
- **A client-supplied place-name override.** `PATCH /api/media/bulk` still accepts coordinates only; the server derives every geo column via `applyLocation()`.
- **Changing the reverse-geocode providers themselves.** See [geocoding.md](geocoding.md).

---

## 2. The Problem This Solves

`media_items` stores raw reverse-geocoder output in `geo_country` / `geo_country_code` / `geo_admin1` / `geo_locality` (`apps/api/prisma/schema.prisma:546-559`), and **every browse and search surface groups directly on those raw strings**:

| Surface | Groups on |
|---|---|
| `GET /api/media/explore/locations` (`/places` hub) | `geoCountryCode` → `geoAdmin1` → `geoLocality` |
| `GET /api/media/explore/places` | `geoLocality ?? geoPlaceName` |
| `GET /api/media/facets/locations` (`SearchPanel`) | nested `geoCountry` → `geoAdmin1` → `geoLocality` |
| `GET /api/media/locations` (map pins) | pin label is raw `geoLocality` |
| `GET /api/media?country=&region=&locality=` | substring match on the raw columns |
| Memories trip curator | `localityCounts` / `admin1Counts` tallies name the trip |

Three providers (`offline` GeoNames, `nominatim`, `google`) each spell the same administrative division differently, and the same provider varies by locale. The result is that one region appears as three tiles with a third of the photos each.

There is **no canonical, alias, or merge concept for locations anywhere in the codebase today.** The only structural precedent for merging is `POST /api/people/merge` (source `Person` soft-deleted with a `mergedIntoId` audit breadcrumb), and the only existing name-normalization code is `apps/api/src/media/geo/us-state-codes.ts`, which expands US admin1 codes.

---

## 3. Data Model

New Prisma models plus three columns on `MediaItem`. Migration `20260811000000_add_location_groups`.

### 3.1 `LocationGroupLevel` enum

```prisma
enum LocationGroupLevel {
  country
  region
  locality
}
```

### 3.2 `location_groups`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `level` | `LocationGroupLevel` | which tier this group canonicalizes |
| `canonical_name` | TEXT | the display name — `"Heredia"`, `"The Woodlands"` |
| `normalized_name` | TEXT | `fold(canonical_name)`; backs the unique index |
| `country_code` | TEXT **NOT NULL DEFAULT `''`** | ISO 3166-1 alpha-2 scope; `''` for country-level groups |
| `cover_media_item_id` | UUID? | FK → `media_items`, **`ON DELETE SET NULL`**, relation `"LocationGroupCover"` |
| `center_lat` | DOUBLE PRECISION? | area capture centre |
| `center_lng` | DOUBLE PRECISION? | |
| `radius_km` | DOUBLE PRECISION? | all three null ⇒ alias-only group |
| `enabled` | BOOLEAN default `true` | a disabled group resolves to nothing |
| `notes` | TEXT? | free-form admin note |
| `created_by_id` | UUID? | FK → `users`, SetNull |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Indexes:** `@@unique([level, countryCode, normalizedName])`, `@@index([level, enabled])`, `@@index([coverMediaItemId])`.

> **`country_code` is `NOT NULL DEFAULT ''`, never nullable — this is load-bearing.** Postgres treats every NULL as distinct from every other NULL in a unique index, so a nullable scope column would silently permit two country groups both named "Georgia". The same pitfall is documented on `Memory.subjectKey` (`String @default("")`) and on the `circle_id IS NOT NULL` predicate of `notifications_review_queue_live_uniq_idx`.

`cover_media_item_id` is `SetNull` rather than `Cascade` for the same reason `Memory.coverMediaItemId` is: a hard-deleted cover photo must not take the whole group down with it. Mirrors `Album.coverMediaItemId`.

### 3.3 `location_group_aliases`

One row per raw geocoder string claimed by a group.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `group_id` | UUID | FK → `location_groups`, **Cascade** |
| `level` | `LocationGroupLevel` | denormalized from the group |
| `country_code` | TEXT NOT NULL DEFAULT `''` | denormalized from the group |
| `raw_value` | TEXT | the geocoder string **exactly as stored**, e.g. `"Provincia de Heredia"` |
| `normalized_value` | TEXT | `fold(raw_value)` |
| `created_at` | TIMESTAMPTZ | |

**Indexes:** **`@@unique([level, countryCode, normalizedValue])`** — the load-bearing constraint: a raw value belongs to **at most one** group, so resolution can never be ambiguous. `@@index([groupId])`.

`level` and `country_code` are denormalized onto the alias purely so that unique index can exist without a join. They are written from the parent group and are never independently editable.

### 3.4 Three new `media_items` columns

```prisma
geoCanonicalCountry   String?  @map("geo_canonical_country")
geoCanonicalAdmin1    String?  @map("geo_canonical_admin1")
geoCanonicalLocality  String?  @map("geo_canonical_locality")
```

with `@@index` on each, mirroring the existing `@@index([geoAdmin1])` / `@@index([geoLocality])`.

> **Invariant: whenever the raw column is non-null, the canonical column is non-null too.**
> `canonical = group.canonical_name` when a group matches, else the raw value **verbatim**.

The migration seeds the invariant across the existing library in a single pass:

```sql
UPDATE media_items
   SET geo_canonical_country  = geo_country,
       geo_canonical_admin1   = geo_admin1,
       geo_canonical_locality = geo_locality;
```

This is what makes the read-path migration in [§7](#7-read-path-migration) a pure column swap with **zero behavioural change on day one**, and it is why the columns are always populated rather than resolved with a fallback: **Prisma `groupBy` cannot express `COALESCE`**, and `fetchGeoGroupRows` is a `groupBy`.

### 3.5 Data-model alternatives considered

| Alternative | Why rejected |
|---|---|
| **Rewrite `geo_admin1` etc. in place** | The repo has two conflicting geo writers — `MediaMetadataSyncService` (present-only, never nulls) and `GeocodeHandler.persistGeocode` / `geoResultToMediaColumns` (overwrite-all). A canonical name written into the raw column is **silently reverted by the next `geocode` rerun or metadata re-extract**. Un-merging would also be impossible without a full re-geocode. |
| **Read-time join, no columns** | Every grouping query gains a join, and filtering by a canonical name means expanding it to all member values on every request. Worse, `groupBy` can't group on a joined expression, so `fetchGeoGroupRows` / `facetsLocations` would have to be rewritten as raw SQL. |
| **FK columns (`geo_locality_group_id`) instead of denormalized names** | Every read path currently keys on a *name string*; storing ids would force a join back to `location_groups` on all seven of them, for no benefit — the canonical name is small, stable, and already exactly what those paths want. |
| **Soft-delete/merge model like `Person.mergedIntoId`** | People merge *rows*; locations have no rows to merge — a place name is a string on many media items. An alias table is the natural shape. |

---

## 4. Name Normalization

`apps/api/src/location-groups/normalize-location-name.ts`.

### 4.1 `fold(s)` — alias identity

```ts
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')   // "San José" → "San Jose"
    .toLowerCase()
    .replace(/[.,'’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

`fold` is deliberately **conservative** — accents, case, punctuation and whitespace only. It is what `normalized_value` stores and what resolution matches on, so two genuinely different names can never silently collide.

### 4.2 `suggestionKey(level, s)` — suggestions only

```ts
export function suggestionKey(level: LocationGroupLevel, s: string): string {
  return stripNoise(level, fold(s));
}
```

`stripNoise` additionally removes level-aware administrative noise tokens:

| Level | Leading tokens | Trailing tokens |
|---|---|---|
| `region` | `provincia de`, `provincia`, `province of`, `prov`, `estado de`, `state of`, `departamento de`, `department of`, `region de`, `region of` | ` province`, ` provincia`, ` region`, ` state`, ` department`, ` prefecture`, ` oblast` |
| `locality` | `city of`, `ciudad de`, `municipio de`, `municipality of`, `town of` | ` city`, ` municipality`, ` municipio` |
| `country` | `the ` | ` (the)` |

So `"Heredia"`, `"Heredia Province"` and `"Provincia de Heredia"` all reduce to `heredia`.

> **`suggestionKey` is never used for resolution.** It is aggressive enough to conflate real places (a "Mexico City" / "Mexico" pair, say), which is acceptable when a human reviews the proposal and unacceptable as an automatic rule.

---

## 5. Resolution — How a Raw Name Becomes a Canonical Name

`LocationGroupResolverService` (`apps/api/src/location-groups/location-group-resolver.service.ts`) is the **single** component that computes canonical names. Nothing else may.

### 5.1 Cache

An in-memory snapshot of every enabled group and alias, with a 30 s TTL plus an explicit `invalidate()` called on every group/alias mutation — the same two-layer shape as `SystemSettingsService`'s 5 s cache + `invalidateSettingsCache()`. The dataset is small (hundreds of rows at most), so the snapshot is a full load, not a per-key lookup.

```ts
interface ResolverSnapshot {
  // `${level}|${countryCode}|${normalizedValue}` → canonicalName
  aliases: Map<string, string>;
  areas: Array<{
    level: LocationGroupLevel;
    countryCode: string;
    canonicalName: string;
    centerLat: number; centerLng: number; radiusKm: number;
  }>;
}
```

### 5.2 `resolve(raw, coords)`

```ts
resolve(
  raw:   { geoCountry, geoCountryCode, geoAdmin1, geoLocality },
  coords: { lat: number; lng: number } | null,
): { geoCanonicalCountry, geoCanonicalAdmin1, geoCanonicalLocality }
```

Per level, **first match wins**:

1. **Alias match** — `aliases.get(`${level}|${countryCode}|${fold(rawValue)}`)`. For `country`, the scope key is `''`.
2. **Radius capture** — only when `locationGrouping.radiusCaptureEnabled` is true *and* `coords` is non-null. Among that level's `areas` whose great-circle distance from `(centerLat, centerLng)` is ≤ `radiusKm`, **the smallest `radiusKm` wins**, so a tight "The Woodlands" group beats a broad "Greater Houston" one.
3. **Fallback** — the raw value, verbatim.

When `features.locationGrouping` is off (or the `LOCATION_GROUPING_ENABLED` env kill-switch is `false`), `resolve` is the **identity function** — it returns the raw values unchanged, preserving the §3.4 invariant with no groups applied.

Distance uses the existing haversine helper in `apps/api/src/location-inference/` rather than adding a second implementation.

> **Alias beats radius, always.** An administrator who explicitly listed a value has expressed a stronger intent than a radius that happens to contain the point. The rebuild job in [§8](#8-the-location_group_rebuild-job) preserves this by ordering its passes reset → radius → alias.

---

## 6. Write-Path Integration

Six call sites. Every one delegates to the resolver; none computes a canonical name itself.

| # | File | Change |
|---|---|---|
| 1 | `media/geo/apply-location.util.ts` — `applyLocation()` | return the three canonical columns alongside the raw patch. Covers manual location set, bulk update, and location-suggestion accept |
| 2 | `geo/geocode.handler.ts` — `persistGeocode()` | write canonical columns in the same `update` as the raw ones |
| 3 | `media/sync/media-metadata-sync.service.ts` — geo block | set canonical for whichever tiers it sets, honouring its **present-only** semantics (never nulls an existing value). This is the hook that makes grouping apply to future uploads automatically |
| 4 | `media/geo/geo-result.mapper.ts` — `GEO_CLEAR_COLUMNS` | add the three canonical columns as `null` |
| 5 | `enhancement/media-enhancement.service.ts` | the "keep both" path copies geo columns onto the new item — copy canonical too |
| 6 | `nodes/node-backup-query.service.ts` | add canonical fields to the backup sidecar as **optional**; no `schemaVersion` bump (purely additive) |

The `geocode` enrichment job remains **node-claimable** — the node computes only the raw `GeoLocationResult`; canonicalization happens server-side inside `persistGeocode`, so no node ever needs the group table.

---

## 7. Read-Path Migration

Because §3.4's invariant guarantees the canonical column is populated whenever the raw one is, each of these is a column swap, not a fallback expression.

| Read path | File | Change |
|---|---|---|
| `explorePlaces` | `media.service.ts` | group key → `geoCanonicalLocality ?? geoLocality ?? geoPlaceName` |
| `fetchGeoGroupRows` | `media.service.ts` | add the three canonical columns to `by:` |
| `buildLocationLevel` | `media.service.ts` | fold on canonical; cover `where` uses canonical; **cover override** below |
| `facetsLocations` | `media.service.ts` | same `groupBy` swap; keeps its deliberate no-`archivedAt` divergence (search includes archived) |
| `listLocations` (map pins) | `media.service.ts` | select and return `geoCanonicalLocality` as the pin label |
| `whereCountry` / `whereRegion` / `whereLocality` / `whereLocation` | `search/media-where.builder.ts` | match canonical **OR** raw |
| Memories trip naming | `memories/curators/trip.curator.ts`, `trip-clustering.ts` | tally canonical, so a trip reads "The Woodlands" |

**Cover override.** `buildLocationLevel` currently picks each tier entry's cover with one bounded `findFirst` ordered by `capturedAt desc`. It now first looks the entry up in `location_groups` by `(level, countryCode, normalizedName)`; if a matching group has a `coverMediaItemId`, that item's thumbnail is used and the `findFirst` is skipped entirely. Otherwise the existing heuristic is unchanged.

**Filters match canonical OR raw** so that pre-existing deep links, bookmarks, and Android/CLI clients passing a raw name keep working:

```ts
export function whereRegion(region: string) {
  return {
    OR: [
      { geoCanonicalAdmin1: { contains: region, mode: 'insensitive' } },
      { geoAdmin1:          { contains: region, mode: 'insensitive' } },
    ],
  };
}
```

> Emitting an `OR` from a where-builder is safe here: `buildMediaWhere` composes every fragment into a shared `AND: []` array precisely so that two fragments each emitting a top-level `OR` cannot clobber each other.

`workflows/registry/media-item-fields.ts` and `search/searchable-fields.registry.ts` need **no change** — both delegate to these builders, so the workflow condition catalog and agentic-search tool inherit canonical matching for free.

---

## 8. The `location_group_rebuild` Job

`apps/api/src/location-groups/location-group-rebuild.handler.ts`.

| Field | Value |
|---|---|
| Type | `location_group_rebuild` |
| Scope | global (`mediaItemId: null`, `circleId: null`) |
| Priority | 100 (background) |
| Reason | `backfill` |
| Payload | `{ circleId?: string, groupIds?: string[] }` — both optional; absent ⇒ whole library |
| Node-claimable | **No** — server-only |

**Server-only by omission.** The handler implements no `nodeResultSchema` / `persistNodeResult` pair, so `EnrichmentHandlerRegistry.serverOnlyTypes()` picks it up automatically and it becomes `ENRICHMENT_WORKER_MODE=system` eligible with no explicit pinning — the same inference that covers `face_auto_archive_sweep` and the `location_inference` sweep.

### 8.1 Algorithm — set-based, O(groups) statements

The passes run **reset → radius → alias**, which is what makes an alias always override a radius claim without tracking per-row provenance.

1. **Reset.** Per circle (keyset over `circles.id`, 100 per page, the same shape as `MemoriesGenerationTask`), `SET geo_canonical_* = geo_*` for non-deleted items. Chunking by circle keeps any single statement's lock footprint bounded.
2. **Radius.** For each enabled group with a radius: one `updateMany` over the cheap lat/lng **bounding-box superset** (the same approximation the existing `near` filter uses), then an exact haversine refinement in a keyset loop over the bbox hits. This is `media-item-fields.ts`'s `readTimeRefinement` pattern applied to a write — the bbox is the tightest predicate SQL can express, and the exact test runs in process.
3. **Alias.** For each enabled group, one `updateMany` per level:
   ```ts
   updateMany({
     where: { geoAdmin1: { in: rawValues }, ...(countryCode ? { geoCountryCode: countryCode } : {}) },
     data:  { geoCanonicalAdmin1: canonicalName },
   })
   ```
   Then a **self-healing sweep**: `groupBy` the distinct raw values in scope, `fold` each, and claim any whose fold matches an alias's `normalized_value` but whose exact bytes were not in the `in:` list — persisting those as new alias rows so the next run's `in:` covers them directly. This is what absorbs case/accent variants the admin never explicitly listed.
4. **Log.** One structured completion line, mirroring `duplicate-confidence-backfill.handler.ts`:
   `{ event: 'location_group_rebuild.completed', jobId, scanned, updated, groupsApplied, errors }`.

Because the work is `updateMany` statements keyed on indexed columns, cost scales with the **number of groups**, not the number of media items — a ~70 000-item library rebuilds in one job.

### 8.2 Enqueueing

Every group or alias mutation enqueues a rebuild, and `POST /api/admin/location-groups/rebuild` triggers one on demand.

> **This job deliberately does NOT set `skipDedup`.** The default dedup collapses pending global jobs of the same type into one, which is *exactly* what we want: a burst of admin edits should produce a single rebuild.
>
> Contrast `location-inference-backfill.service.ts`, which **must** pass `skipDedup: true` because it enqueues one global job *per circle* and would otherwise let the first circle's job swallow all the others. Same mechanism, opposite requirement — do not copy one call site's flag to the other.

The rebuild is **not** feature-gated. With `features.locationGrouping` off, the resolver is the identity function and the rebuild resets every canonical column to its raw value — which is precisely how disabling the feature takes effect. This matches `duplicate_confidence_backfill`'s deliberately ungated posture.

### 8.3 Registration checklist

| File | Entry |
|---|---|
| `enrichment/job-type-labels.ts` | `location_group_rebuild: 'Location Group Rebuild'` |
| `enrichment/server-only-types.spec.ts` | add the class to `ALL_HANDLER_CLASSES` **and** the type to `DOCUMENTED_SERVER_ONLY_TYPES` (alphabetical) — **this spec fails CI otherwise** |
| `docs/specs/distributed-nodes.md` §8.3 | list as server-only |
| `apps/cli/src/node/capabilities.ts` | **do not** add to `NODE_JOB_TYPES` |

---

## 9. API Endpoints

`@Controller('location-groups')` and `@Controller('admin/location-groups')`. All responses use the `{ data: … }` envelope; bodyless POSTs use `.prefault({})` zod schemas.

### 9.1 `GET /api/location-groups`

Query: `level`, `enabled`, `q`, `page`, `pageSize`. Returns `{ items, meta }`; each item carries `id`, `level`, `canonicalName`, `countryCode`, `memberCount`, live `itemCount`, signed `coverThumbnailUrl`, `centerLat`/`centerLng`/`radiusKm`, `enabled`. `itemCount` comes from one `groupBy` over the canonical columns, never a per-row lookup. (`geo_settings:read`)

### 9.2 `GET /api/location-groups/:id`

Group detail plus the full alias list with per-alias item counts. (`geo_settings:read`)

### 9.3 `POST /api/location-groups`

Body `{ level, canonicalName, countryCode?, memberValues: string[], coverMediaItemId?, center?: { lat, lng }, radiusKm?, enabled? }` → `201`. Enqueues a rebuild. (`geo_settings:write`)

**`409` when any `memberValue` folds to a value already owned by another group**, with the owner reported at **`details.groupId` / `details.groupName`**:

> The owning-group fields **must** live under `details`. `HttpExceptionFilter` rebuilds every error body from a fixed key allowlist (`message`, `code`, `details`, `error`, `error_description`, `startedAt`) and silently drops anything else, so a top-level custom field type-checks, passes any test asserting `err.getResponse()`, and never reaches the client. Assert this through the real filter.

`radiusKm` is validated against `locationGrouping.maxRadiusKm`; `center` and `radiusKm` must be supplied together.

### 9.4 `PATCH /api/location-groups/:id`

Body `{ canonicalName?, enabled?, coverMediaItemId?, center?, radiusKm?, notes? }`. `coverMediaItemId` must be a media item that currently resolves to this group, else `400` — the same rule as the album cover. Enqueues a rebuild. (`geo_settings:write`)

### 9.5 `DELETE /api/location-groups/:id`

`204`. Cascades aliases and enqueues a rebuild, so members revert to their raw names. (`geo_settings:write`)

### 9.6 `POST` / `DELETE /api/location-groups/:id/members`

Body `{ values: string[] }` → `{ added }` / `{ removed }`. `POST` returns the same `409` shape as §9.3 on a cross-group conflict. Both enqueue a rebuild. (`geo_settings:write`)

### 9.7 `GET /api/location-groups/values`

Query: `level`, `q`, `grouped=all|ungrouped|grouped`, `page`, `pageSize`. Returns the distinct **raw** values present app-wide with `{ value, countryCode, itemCount, groupId | null, groupCanonicalName | null }`, backed by one `groupBy` over the raw column plus `geoCountryCode`. This is the member-picker's data source. (`geo_settings:read`)

### 9.8 `GET /api/location-groups/suggestions`

Query: `level`, `limit`. Returns clusters of two or more *ungrouped* raw values sharing a `suggestionKey`, each `{ suggestedCanonicalName, countryCode, members: [{ value, itemCount }], totalItems }`. `suggestedCanonicalName` is the shortest member after noise-stripping, title-cased — so the Heredia cluster proposes `"Heredia"`. Values below `locationGrouping.suggestionMinItems` are excluded. (`geo_settings:read`)

### 9.9 `POST /api/admin/location-groups/rebuild`

Body `{ circleId?, groupIds? }` → `{ data: { jobId, status } }`. (`geo_settings:write`)

---

## 10. RBAC

**No new permission.** Location groups reuse the existing Admin-only geo pair, because they are a global geo configuration exactly like the active reverse provider:

| Operation | Requires |
|---|---|
| List / read groups, values, suggestions | Admin + `geo_settings:read` |
| Create / update / delete groups and members, trigger a rebuild | Admin + `geo_settings:write` |

Non-admin users are unaffected: they see canonical names on every browse surface but cannot manage groups.

---

## 11. Configuration

### 11.1 Feature flag

`features.locationGrouping` — boolean, default `false`. Env kill-switch `LOCATION_GROUPING_ENABLED=false` overrides it, via a new `isLocationGroupingEnabled(settings)` helper alongside `isMemoriesEnabled` in `common/types/settings.types.ts`.

### 11.2 `locationGrouping.*` system settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `locationGrouping.radiusCaptureEnabled` | boolean | `true` | whether area capture participates in resolution at all |
| `locationGrouping.maxRadiusKm` | number, 0.5–200 | `50` | ceiling enforced when a group's radius is set |
| `locationGrouping.suggestionMinItems` | int, 1–1000 | `1` | minimum item count for a raw value to appear in suggestions |

> **The namespace has four hand-maintained copies and all four are mandatory:**
> 1. `common/schemas/settings.schema.ts` → `systemSettingsSchema`
> 2. `common/schemas/settings.schema.ts` → `systemSettingsPatchSchema`
> 3. `settings/dto/update-system-settings.dto.ts` → `patchSystemSettingsSchema` — **the wire DTO**, which strips unknown keys; a namespace missing *here* validates and merges perfectly in unit tests while every real `PATCH` silently no-ops
> 4. `settings/system-settings/system-settings.service.ts` → the manual `patchSettings` merge **and** both `getSettings()` projections
>
> `FEATURE_KEYS` and `DEFAULT_SYSTEM_SETTINGS.features` in `common/types/settings.types.ts` also need the new flag.

---

## 12. Frontend

### 12.1 Admin page

`apps/web/src/pages/Admin/LocationGroupsSettingsPage.tsx`, route `/admin/settings/location-groups` registered in `App.tsx`, surfaced as a card in the existing **Media** section of `SettingsHubPage.tsx` beside Geo Location and Location Inference, gated on `geo_settings:read`.

Structure follows `LocationInferenceSettingsPage.tsx` exactly: inner `…Content()` component wrapped by a `usePermissions()` guard → `<Container maxWidth="lg">` → `← Back to Settings` link → icon + `<Typography variant="h4">` → sequential `<Paper variant="outlined" sx={{ p: 3, mb: 2 }}>` sections → `<Snackbar>` feedback.

| Section | Contents |
|---|---|
| **Global Settings** | `features.locationGrouping` switch, radius-capture switch, `maxRadiusKm` slider, `suggestionMinItems` field |
| **Suggestions** | one card per detected cluster — *"Heredia · Heredia Province · Provincia de Heredia — 1,204 photos"* — with an editable canonical name and a one-click **Merge** |
| **Groups** | Countries / Regions / Cities tabs; per group: member chips, item count, cover thumbnail, enable toggle, edit and delete |
| **Group editor dialog** | canonical name, country scope, searchable member picker fed by `GET /values` (showing item counts and any owning group), cover picker over the group's own photos, and an optional **Area** block with a `LocationPickerMap` for the centre plus a radius slider drawing a `<Circle>` overlay |
| **Rebuild** | trigger button plus job-status polling, the same shape as the existing backfill runners |

New service module `apps/web/src/services/locationGroups.ts` and matching types.

`MediaDetailDrawer`'s geo block shows the canonical name with the raw value as secondary text when the two differ — e.g. **Region** `Heredia`, caption *from "Provincia de Heredia"*.

### 12.2 Location picker improvements

The draggable-pin map already exists: `LocationPickerMap` (Leaflet + react-leaflet, OSM tiles) wrapped by `LocationSearchPicker`, used by `MediaDetailDrawer`, `BulkLocationDialog`, and `AdjustLocationDialog`. Click-or-drag alone already saves a location, and the search box is already optional — a `503` from `/geo/search` even prints *"Place search unavailable — drop a pin on the map."*

Four gaps close in this epic:

| # | Gap | Fix |
|---|---|---|
| 1 | The `MyLocation` button only **recenters**; it never sets the coordinate | On the **explicit button press**, also call `onChange`. The **on-mount** auto-locate stays recenter-only, or it would silently overwrite an existing coordinate. New optional prop `geolocateSetsValue?: boolean` (default `true`; `false` for `SearchPanel`) |
| 2 | With `value == null` no `<Marker>` renders at all, so there is nothing to drag | Render a muted-style draggable marker at the map centre, kept synced to centre until first interaction, alongside the existing click-to-place |
| 3 | The picker opens on a world view | New optional prop `initialCenter?: { lat, lng }`. `MediaDetailDrawer` resolves: the item's own coords → the item's Location-Inference candidate (`GET /api/media/location-suggestions?circleId=&mediaItemId=`, **already exists**) → `navigator.geolocation` → default |
| 4 | The reverse-geocoded address is a faint caption; scroll-wheel zoom is disabled on an editing surface | Promote `geoLabel` into a bordered *"Use this location: San José, San José Province, Costa Rica"* confirm row with a resolving state and an explicit *"Coordinates only — no address found"* fallback; make `scrollWheelZoom` a prop defaulting `true` for the picker, leaving `LocationMiniMap` untouched |

> `LocationPickerMap` has **five** call sites — `LocationSearchPicker`, `SearchPanel`, `ActionParamEditor`, `ConditionValueEditor` — so every new prop must be **optional and backward-compatible**. Any new marker must use `defaultIcon` from `lib/leaflet-setup.ts`, the inline-SVG `divIcon` that works around the Leaflet-PNG-under-Vite bug.

---

## 13. Implementation Notes and Gotchas

1. **A `geocode` rerun overwrites every geo column.** This is the single most important constraint in the design and the whole reason canonical names live in their own columns rather than replacing the raw ones.
2. **A top-level custom field on a thrown `HttpException` is silently dropped.** The `409` conflict payload must nest the owning group under `details`.
3. **`location_group_rebuild` must not set `skipDedup`; `location_inference` sweeps must.** Opposite requirements, adjacent code, easy to copy wrongly.
4. **The settings namespace has four hand-maintained copies**, and the wire DTO is the one whose omission fails silently.
5. **`server-only-types.spec.ts` fails CI** if the new job type is not documented there.
6. **`country_code` is `NOT NULL DEFAULT ''`** — a nullable scope column defeats the unique index, because Postgres treats NULLs as distinct.
7. **Prisma `groupBy` cannot `COALESCE`**, which is why canonical columns are always populated rather than fallback-resolved at read time.
8. **`MediaMetadataSyncService` is present-only, `persistGeocode` is overwrite-all.** Both must set canonical columns, each honouring its own existing semantics.
9. **`LocationPickerMap`'s five call sites** mean additive optional props only.

---

## 14. Testing Notes

### Unit

- `fold` — accents, case, punctuation, whitespace collapsing; `"San José"` and `"SAN JOSE"` fold equal, `"San Jose"` and `"San Juan"` do not.
- `suggestionKey` — the three Heredia spellings collapse; per-level noise tokens strip correctly; a `country`-level key does not strip `" province"`.
- `LocationGroupResolverService` — alias beats radius; smallest radius wins among overlapping areas; unmatched values pass through verbatim; feature flag off ⇒ identity; cache invalidates on mutation.
- `LocationGroupsService` — the `409` conflict path, asserted **through `HttpExceptionFilter`** (mirror the `sendThroughFilter` harness in `db-backup-admin.service.spec.ts`), not via `getResponse()`; cover-item-must-belong-to-group `400`; `radiusKm` clamped by `maxRadiusKm`.
- `LocationGroupRebuildHandler` — pass ordering (an alias overrides a radius claim); every enqueue uses `priority: 100`, `reason: backfill`, and **no** `skipDedup`; a per-group failure is counted, never fatal to the run.

### Integration

- Full loop: seed items across three raw region spellings → create a group → run the rebuild → assert one tier entry with the summed count, and that raw columns are untouched.
- Radius capture: an item whose locality matches no alias but whose GPS falls inside a group's radius resolves to the group.
- Disable + rebuild restores every raw name.
- A `geocode` rerun after a rebuild leaves canonical names intact.
- `PATCH /api/system-settings` with `{ locationGrouping: { maxRadiusKm: 25 } }` actually persists — the wire-DTO regression test.

### RBAC

- Non-admin ⇒ `403` on every `/api/location-groups/*` route.
- `geo_settings:read` ⇒ can list, cannot mutate.

### Web

Under `apps/web/src/__tests__/`, mirroring the source tree: the admin page renders gated on `geo_settings:read`; the geolocate button calls `onChange` when `geolocateSetsValue` is true and not when false; a null `value` still renders a draggable marker; the confirm row shows the resolving and no-address states.

---

## 15. Known Limitations and Non-Goals

- **Regions and cities are keyed by `(countryCode, name)`, not by a full hierarchy.** Two same-named cities in different regions of one country share a group. `places-browsing.md §6` already documents accepting this ambiguity for the existing tier browsing; grouping inherits it.
- **`geo_admin2` and `geo_place_name` do not participate.** `explorePlaces` therefore still falls back to raw `geoPlaceName` for items with no locality.
- **A group's radius is a circle, not a polygon.** A city with an irregular footprint needs either a generous radius or explicit aliases.
- **No automatic un-merge.** Deleting a group reverts its members, but there is no record of which values a deleted group used to own.
- **Un-grouped new names are not auto-detected in the background.** They surface the next time an admin opens the Suggestions section.

---

## 16. Future Work

| Capability | Notes |
|---|---|
| Polygon / GeoJSON areas | Replace or supplement the radius with a real boundary for irregular municipalities |
| Per-circle overrides | Global defaults with a circle-level override layer, if two families ever genuinely disagree |
| Notification on new ungrouped names | A `review_queue_*`-style STATE notification when a new raw value crosses a photo-count threshold |
| Grouping for `geo_admin2` / `geo_place_name` | Extend `LocationGroupLevel` once a browse surface needs those tiers |
| Import / export of groups as CSV | Mirrors the tag-vocabulary CSV round-trip |
| Auto-merge above a confidence threshold | Apply `suggestionKey` clusters automatically when unambiguous, with an audit trail |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | August 2026 | AI Assistant | Initial specification for the Location Grouping epic |
