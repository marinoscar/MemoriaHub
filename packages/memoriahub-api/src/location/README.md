# location

The location slice of the MemoriaHub domain (RETRO-J10, #624). This first cut carries **location grouping**: admin-curated canonical place names that merge many raw reverse-geocoder spellings into one browsable entry per tier.

## Purpose and scope

`LocationGroupResolverService` is THE single component that computes a canonical name: per tier (country, region, locality) the first match wins, **alias** (an admin listed this raw string) beats **radius** (a group's centre and radius contains the item, the smallest radius wins) beats the **raw value verbatim**. With the feature off (`features.locationGrouping` or `LOCATION_GROUPING_ENABLED=false`) it is the identity function, so a non-null raw tier always has a non-null canonical tier. `LocationGroupRebuildHandler` is the server-only `location_group_rebuild` job (30 minutes, two attempts, type string permanent): RESET, then RADIUS, then ALIAS, a handful of set-based statements whatever the library size, and `LocationGroupRebuildService.enqueueRebuild` queues it WITHOUT `skipDedup` so a burst of admin edits collapses into one rebuild. `LocationGroupsService` is the management API (list, values, suggestions, create, update, merge, members). `fold` (alias identity) and `suggestionKey` (suggestion clustering only) are deliberately different normalisations. `haversineKm` and `whereNear` are the shared geometry. The controllers stay in the web app until the identity-backed guard lands in `core`; the geo providers (offline GeoNames, Nominatim, Google), the `geocode` job, location inference and the location suggestions review still live in `apps/api` and move in a later change (the rest of this issue). Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/location` (and `@marinoscar/memoriahub-api/location/testing` for the conformance kit). It imports the `ports`, `core` and `media` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/schedule` and `@marinoscar/memoriahub-contract` (the location wire schemas and the level vocabulary).

## Configuration

`LocationModule.forRoot()`; the options object is reserved and empty. Import it once in the host and re-export it from the host's location module. The slice reads the `locationGrouping` system settings namespace (`radiusCaptureEnabled`, `maxRadiusKm`, `suggestionMinItems`) and `features.locationGrouping` through the settings port, and the kill switch `LOCATION_GROUPING_ENABLED` from the environment through the `isFeatureEnabled` helper of `core`. The all-scopes sweep of the rebuild reads `MEMORIAHUB_ACCESS.allScopeIds()`.

## Extension-point catalog

None yet. The slice registers one job handler through `MEMORIAHUB_JOBS` and exposes the resolver, the rebuild enqueue helper and the management service to the host. Every host write path that touches a `geo_canonical_*` column must go through `LocationGroupResolverService`. `describeLocationSliceConformance` (`./location/testing`) proves alias-beats-radius, the smallest-radius rule, the identity behaviour with the feature off and the enqueue rule of the rebuild.
