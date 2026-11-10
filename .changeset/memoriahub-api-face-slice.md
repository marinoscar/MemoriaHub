---
"@marinoscar/memoriahub-api": minor
---

Adds the `face` slice (`@marinoscar/memoriahub-api/face`, RETRO-J6): face detection in photos and videos, matching (pgvector or in-process), clustering, people, auto-archive and the face settings service, with its four controllers (over `@MemoriahubAuth`) and the three job handlers (`face_detection`, `video_face_detection`, `face_auto_archive_sweep`), `FaceModule.forRoot`, the host tokens `FACE_CONFIG`, `FACE_PERSON_AVATARS` and `FACE_STORAGE_ORG`, and `describeFaceSliceConformance` in `@marinoscar/memoriahub-api/face/testing`. The core gains the stream helpers `downloadToTempFile` and `streamToBuffer` and `featureSkipReason`; the jobs port gains the optional `recordProvider`. `@marinoscar/memoriahub-compute` becomes an optional peer. Nothing is published yet.
