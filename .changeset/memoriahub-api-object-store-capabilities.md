---
"@marinoscar/memoriahub-api": minor
---

Add the optional `capabilities` (`MemoriahubObjectStoreCapabilities`: `partUploadMode` and `acceptsPartBytes`) to the object-store port's `MemoriahubObjectStore` and move the `android.upload-path` Doctor check into the media slice as `AndroidUploadPathDoctorCheck` over `MEMORIAHUB_OBJECT_STORE`. The check id, statuses and remedies are unchanged; a store that reports no capabilities is skipped.
