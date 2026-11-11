---
"@marinoscar/memoriahub-api": minor
---

Move `MediaMetadataSyncService` into the `media` slice of `@marinoscar/memoriahub-api` (private), over the database port, with the new `MEDIA_LOCATION_RESOLVER` hook the host binds to the location slice's resolver. The `storage.object.processed` listener stays in the app (`MediaMetadataSyncListener`). Behaviour, job type strings and the generated OpenAPI document are unchanged.
