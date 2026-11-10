---
"@marinoscar/memoriahub-api": minor
---

Add the `media` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/media` and `@marinoscar/memoriahub-api/media/testing`): the upload enrichment fan-out registry (`UploadEnrichmentRegistry`, `registerUploadEnrichment`), `MediaTouchService`, the `media.upload_completed` producer, `MediaThumbnailService`, the Android Media Sync device service, the `trash_purge` job and its enqueue-only hourly cron, and the `describeMediaSliceConformance` kit. Everything reaches the outside through the host ports; the web app keeps the routes, the job type strings, the notification keys and the storage keys unchanged. The gallery service, controllers and the remaining media handlers move in a later change.
