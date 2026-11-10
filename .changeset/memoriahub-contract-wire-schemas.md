---
"@marinoscar/memoriahub-contract": minor
---

Add `@marinoscar/memoriahub-contract`: the Zod wire schemas, inferred types and `details.reason` codes of the MemoriaHub domain, one entry point per slice (`media`, `media-sync`, `face`, `tagging`, `search`, `memories`, `workflows`, `review-runs`, `location`, `dedup`, `burst`, `social`, `enhancement`, `errors`, `primitives`), dual CommonJS and ESM, importing only `zod`. The API DTOs, the web types and the CLI request types build on it; no wire shape changes.
