---
"@marinoscar/memoriahub-api": patch
---

The picture-enhancement job classifies a raw provider or object-store throttle (HTTP 429 or 529, an S3 `SlowDown`) as a deferral, as the tagging handlers already did: the source download and the staging upload are not model calls, and a throttle there used to fail the enhancement and charge an attempt instead of deferring the job.
