---
"@marinoscar/memoriahub-compute": minor
---

The enrichment compute is now the package `@marinoscar/memoriahub-compute` (was the internal `@memoriahub/enrichment-compute`): dual CommonJS and ESM, documented per slice, with the packages-first tooling around it. The `./ai` subpath and the `openai` and `@anthropic-ai/sdk` dependencies are removed: a worker node holds no provider key.
