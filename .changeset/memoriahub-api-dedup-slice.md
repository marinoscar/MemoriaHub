---
"@marinoscar/memoriahub-api": minor
---

Add the `dedup` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/dedup` and `.../dedup/testing`), detection part: CLIP visual embeddings and dHash, the two-tier near-duplicate matching and grouping (with the burst-wins write-time guard and persisted confidence), the `duplicate_detection`, `duplicate_detection_batch` and `duplicate_confidence_backfill` jobs, the admin backfill, the upload fan-out registration, `ReviewInsightsService` and `describeDedupSliceConformance`. New optional peers: `@marinoscar/memoriahub-compute` and `onnxruntime-node`. The review service, the review-run strategy and the controllers stay in the web app.
