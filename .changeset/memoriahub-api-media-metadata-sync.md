---
"@marinoscar/memoriahub-api": minor
---

Move `MediaMetadataSyncService` and the metadata re-run into the `media` slice of `@marinoscar/memoriahub-api` (private): the sync service over the database port with the new `MEDIA_LOCATION_RESOLVER` hook (the host binds it to the location slice's resolver), and the `metadata_extraction` handler (node-eligible, same type string and profile), its service, the backfill service and the two controllers over the jobs, access and object-store ports with the new `MEDIA_REVERSE_GEOCODER` hook. The `storage.object.processed` listener stays in the app (`MediaMetadataSyncListener`). The slice now lists `@marinoscar/memoriahub-compute` as a peer. Behaviour, job type strings, routes and the generated OpenAPI document are unchanged.
