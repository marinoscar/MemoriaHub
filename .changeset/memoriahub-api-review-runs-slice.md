---
"@marinoscar/memoriahub-api": minor
---

Add the `review-runs` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/review-runs` and `.../review-runs/testing`): the shared review-run engine (`ReviewRunService`, the `review_run_evaluate` and `review_run_execute_batch` handlers, the two deprecated `location_suggestion_run_*` shim handlers, the controller over `@MemoriahubAuth`), a `ReviewRunSubjectRegistry` each review queue registers its strategy with, `describeReviewRunsSliceConformance` and `FakeReviewRunsDb`. The location slice now depends on `review-runs` and registers the location-suggestion strategy. Routes, job types and settings are unchanged; the burst and duplicate strategies and the nightly run-history purge stay in the web app.
