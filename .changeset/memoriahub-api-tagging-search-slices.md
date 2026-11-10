---
"@marinoscar/memoriahub-api": minor
---

Add the `tagging` and `search` slices (RETRO-J7, #618). `@marinoscar/memoriahub-api/tagging`: `TaggingModule.forRoot`, photo and video auto-tagging with the transcript, the two server-only AI job handlers (`auto_tagging`, `video_auto_tagging`), the tag vocabulary with its CSV import and export, the backfill and the photo upload fan-out registration. `@marinoscar/memoriahub-api/search`: `SearchModule.forRoot`, deterministic, semantic and agentic (SSE) search and the `SEARCHABLE_FIELDS` registry. Both reach the platform only through the host ports; the controllers are exported classes the host mounts. `./tagging/testing` and `./search/testing` ship `describeTaggingSliceConformance` and `describeSearchSliceConformance` with in-memory stores. `core` gains `readAiSelection` and `classifyProviderThrottle`, and the package declares `@marinoscar/memoriahub-compute`, `csv-parse` and `csv-stringify` as optional peers.
