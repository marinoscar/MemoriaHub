---
"@marinoscar/memoriahub-api": patch
---

`describeMemoriesSliceConformance` (`@marinoscar/memoriahub-api/memories/testing`) takes an optional `behaviour` option: host handles over the real data path that run four more rules (one row per memory identity, a deleted memory is never resurrected, the digest watermark is the newest succeeded `memory_digest` job's `finishedAt`, preferences filter at read time only). Without it the kit is unchanged.
