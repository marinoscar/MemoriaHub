---
"@marinoscar/memoriahub-api": minor
---

Add the orientation edit and the media recovery routes to the `media` slice of `@marinoscar/memoriahub-api` (private): `MediaOrientationEditService` and `MediaOrientationEditController` (`POST /api/media/:id/edit/orientation`), `MediaThumbnailRerunController` (`POST /api/media/:id/thumbnail/rerun`) and `MediaReprocessController` with its three body DTO classes (`/api/admin/media/reprocess`, `reprocess-stuck`, `reprocess-failed`, `thumbnails/repair`), plus the permanent `STORAGE_RECOVER_STUCK_TYPE` and `STORAGE_REPROCESS_TYPE` strings. The controllers are exported classes over `@MemoriahubAuth` that the web app mounts; the orientation service is provided by the host because it uses the `MEDIA_OBJECT_REPROCESSOR` and `MEDIA_THUMBNAIL_PRUNER` hooks. Routes, job types and the sync-then-prune order are unchanged; the OpenAPI document is byte-identical.
