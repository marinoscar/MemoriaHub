---
"@marinoscar/memoriahub-api": minor
---

Add the optional `MEMORIAHUB_AI_ADMIN` AI administration probe port (`MemoriahubAiAdminPort`: `testModel`, `testEmbedding`, `credentialStatus`, `providerCapabilities`; no default binding, `FakeMemoriahubAiAdmin`) to `@marinoscar/memoriahub-api` (private), and move the five AI Doctor checks into their slices: `ai.search` and `ai.embedding` (search), `ai.tagging` and `ai.video-tagging` (tagging), `ai.picture-enhancer` (enhancement). Check ids, statuses, remedies and the live probes are unchanged; a host that binds no AI administration port skips the checks.
