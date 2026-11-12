---
"@marinoscar/memoriahub-api": minor
---

Add the `ReviewQueueCounterRegistry` (`registerReviewQueueCounter`, `ReviewQueueCounter`, `REVIEW_QUEUE_COUNT_KEYS`) to the media slice and the four counters the owning slices register with it (`BurstReviewQueueCounter`, `DuplicateReviewQueueCounter`, `LocationReviewQueueCounter`, `EnhancementReviewQueueCounter`). `MediaService.computeReviewCounts` and the review-queue notification reconcile now read the queues from the registry instead of counting the four tables themselves, so the media slice no longer names the burst, duplicate, location-suggestion and enhancement models. The four `pending*` wire keys, the event keys, the flag gates (including the `PICTURE_ENHANCEMENT_ENABLED` kill switch) and the counts are unchanged; a queue whose slice is not in the host reports 0. `MediaService` and `ReviewQueueReconcileService` take the registry as a constructor dependency.
