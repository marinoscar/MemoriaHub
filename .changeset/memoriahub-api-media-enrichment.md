---
"@marinoscar/memoriahub-api": minor
---

Add `MediaEnrichmentService` to the `media` slice of `@marinoscar/memoriahub-api` (private): the upload fan-out entry point, the video post-detection fan-out (`video_face_detection`, `video_auto_tagging`) and the per-item tagging, face and thumbnail rerun helpers, over the settings and jobs ports. `MediaModule.forRoot()` binds `MEDIA_ENRICHMENT` to it and exports it; the host binds `SOCIAL_MEDIA_POST_DETECTION` to it. `MediaModels` gains the `mediaTagStatus` delegate. Routes, job types, priorities and settings are unchanged.
