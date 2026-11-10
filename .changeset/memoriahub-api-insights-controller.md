---
"@marinoscar/memoriahub-api": minor
---

The `insights` slice exports `InsightsController` (`/api/admin/insights`, over `@MemoriahubAuth`): the host mounts it where the old controller sat; `forRoot()` does not register it. Adds the optional `reason` to the jobs port's `MemoriahubJob`.
