---
"@marinoscar/memoriahub-api": minor
---

Add the storage processing recovery jobs to the `media` slice of `@marinoscar/memoriahub-api` (private): `StorageRecoveryHandler` (`media.storage.recover_stuck`), `StorageReprocessHandler` (`media.storage.reprocess`), `StorageRecoveryService` and the enqueue-only ten-minute `StorageRecoveryTask`, over the jobs port and a new `MEDIA_RECOVERY_SYSTEM_ACCESS` hook (the cross-organization client, bound by the host under its own `storage-processing-recovery` reason). Job type strings, profiles, the retry cap and the `storage.object.process` payload are unchanged.
