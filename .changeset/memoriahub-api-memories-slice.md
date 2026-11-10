---
"@marinoscar/memoriahub-api": minor
"@marinoscar/memoriahub-contract": patch
---

Add the `memories` slice to `@marinoscar/memoriahub-api` (private; `@marinoscar/memoriahub-api/memories` and `.../memories/testing`): the seven curators and the shared curation engine, AI titles through `MEMORIAHUB_AI.forSystem` and `readAiSelection`, the `memory_generation` and `memory_digest` jobs (server-only, type strings unchanged), the generation and digest crons, the `memories_ready` producer, the signed digest tokens, the read and admin controllers (exported classes the host mounts), `describeMemoriesSliceConformance`, and the slice README. No new peers beyond the existing set.
