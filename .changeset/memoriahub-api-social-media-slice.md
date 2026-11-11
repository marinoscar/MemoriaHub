---
"@marinoscar/memoriahub-api": minor
---

Add the `social-media` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/social-media` and `.../social-media/testing`): social-media video detection (`SocialMediaDetectorService`, the Tier-2 `SocialMediaOcrService`), the node-eligible `social_media_detection` job (`SocialMediaDetectionHandler`; type string, profile and node result pair unchanged), the upload fan-out registration, `SocialMediaBackfillService`, the two controllers over `@MemoriahubAuth` as exported classes, and `describeSocialMediaSliceConformance`. Two host hooks replace what stayed in the web app: `SOCIAL_MEDIA_POST_DETECTION` (the video fan-out after a CLEAN verdict) and the `videoJobTimeoutMs` option of `SocialMediaModule.forRoot`. The web app binds them in `apps/api/src/social-media`. Routes, job types and settings are unchanged; OpenAPI is byte-identical.
