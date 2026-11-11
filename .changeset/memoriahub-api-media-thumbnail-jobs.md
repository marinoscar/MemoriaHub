---
"@marinoscar/memoriahub-api": minor
---

Move the thumbnail jobs into the `media` slice of `@marinoscar/memoriahub-api` (private): the `thumbnail_regen` handler (node-eligible, with `deriveOutputKey`), the server-only `thumbnail_repair` sweep, the enqueue-only `ThumbnailRepairTask` cron, `ThumbnailNodePersistService` and the thumbnail storage-key convention (`buildThumbnailKey`, `thumbnailVersionForJob`, issue #434). They reach the host's post-upload processing through three new hooks, `MEDIA_OBJECT_REPROCESSOR`, `MEDIA_THUMBNAIL_PRUNER` and `MEDIA_SYSTEM_ACCESS` (the cross-organization client for the repair scan, bound by the host to its system client under the `media-housekeeping` reason). Job type strings, profiles, the node pair, the cron schedule and the generated OpenAPI document are unchanged.
