---
"@marinoscar/memoriahub-api": minor
---

Add the `insights` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/insights` and `.../insights/testing`): `InsightsService` (the global storage-metrics snapshot with string byte counts), the `storage_insights` job and its enqueue-only hourly refresh task, and `describeInsightsSliceConformance`. Everything reaches the outside through the host ports; the job type, the route and the settings key are unchanged. The controller stays in the web app.
