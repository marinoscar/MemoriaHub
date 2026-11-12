---
"@marinoscar/memoriahub-api": minor
---

Add the optional `MEMORIAHUB_SHARING` link-sharing port (`MemoriahubSharingPort.listExpiringLinks`, `NOOP_MEMORIAHUB_SHARING`, `FakeMemoriahubSharing`) and the optional `hasNotified` probe of the notify port, and move the `shares.expiring` producer into the media slice as `ShareExpiringService`, `ShareExpiringHandler` and `ShareExpiringTask`. The event key `shares.expiring`, the permanent job type `shares.expiring_sweep` (five minutes, three attempts, server-only), the 7 day lead window, the `(shareId, notifiedFor)` idempotency stamp over live and dismissed rows and the enqueue-only 9 AM cron are unchanged.
