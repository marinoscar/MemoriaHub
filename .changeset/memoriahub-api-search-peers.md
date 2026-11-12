---
"@marinoscar/memoriahub-api": patch
---

The `search` slice imports `tagging/ai-calls` and `tagging/constants` instead of the tagging barrel, so a host that mounts search without tagging no longer needs `csv-parse` and `csv-stringify` (found by the bare host mounting the slices). Behaviour and routes are unchanged.
