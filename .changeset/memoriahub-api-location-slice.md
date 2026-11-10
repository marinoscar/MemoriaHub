---
"@marinoscar/memoriahub-api": minor
---

Add the `location` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/location` and `.../location/testing`), first cut: location grouping. `LocationGroupResolverService` (the one writer of canonical place names: alias beats radius beats raw), the `location_group_rebuild` job and its enqueue helper, `LocationGroupsService`, the shared `haversineKm` and `whereNear`, `fold`/`suggestionKey`, and `describeLocationSliceConformance`. The media slice gains `enqueueEnrichmentJob` and `resolveMediaItemJob` (the enrichment queue's subject convention over the jobs port). Routes, job type strings and settings are unchanged; the controllers, the geo providers and location inference stay in the web app for now.
