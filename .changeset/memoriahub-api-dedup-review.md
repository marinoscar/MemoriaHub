---
"@marinoscar/memoriahub-api": minor
---

Move the duplicate review queue into the `dedup` slice of `@marinoscar/memoriahub-api` (private): `DuplicateService` (list with the read-time kind and best-copy scoring, detail, resolve, dismiss, bulk and threshold runs, per-item rerun), `DuplicateGroupReviewStrategy` registered with the review-run engine, the DTO classes and an optional `DUPLICATE_OBSERVER` for the trash webhook. The dedup slice now depends on `review-runs`. Routes, job types and settings are unchanged; the controllers stay in the web app.
