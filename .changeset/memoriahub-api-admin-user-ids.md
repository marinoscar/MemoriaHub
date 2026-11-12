---
"@marinoscar/memoriahub-api": minor
---

Add the optional `adminUserIds` member to the identity port (`MemoriahubIdentityPort`; the active users the host treats as administrators) and move the `enrichment_failed` notification listener into the media slice as `EnrichmentFailureNotificationListener` over the jobs port's `onSettled`, the identity port and the notify port. The event key `media.enrichment_failed`, the one counted row per (administrator, job type) with no window and the 500-character `lastError` are unchanged.
