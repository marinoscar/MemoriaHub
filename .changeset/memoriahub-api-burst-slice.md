---
"@marinoscar/memoriahub-api": minor
---

Add the `burst` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/burst` and `.../burst/testing`): burst photo detection (`BurstDetectionService`, the server-only `burst_detection` job, the upload fan-out registration at priority 5), the review queue service (`BurstService`), `BurstGroupReviewStrategy` registered with the review-run engine's `ReviewRunSubjectRegistry`, the two controllers over `@MemoriahubAuth` as exported classes, an optional `BURST_OBSERVER` for the trash webhook, and `describeBurstSliceConformance`. The web app binds it in `apps/api/src/burst`. Routes, job types and settings are unchanged; OpenAPI is byte-identical.
