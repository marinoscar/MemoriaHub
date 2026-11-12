---
"@marinoscar/memoriahub-web": minor
---

Add the `review` slice to `@marinoscar/memoriahub-web` (private): the burst, duplicate and location-suggestion clients, hooks and types in `review/headless`, and `BurstsPage`, `BurstGroupPage`, `DuplicatesPage`, `DuplicateGroupPage`, `LocationSuggestionsPage`, `AdjustLocationDialog`, `LocationSuggestionRunRedirect`, the shared review components and the three admin settings pages (`BurstsSettingsPage`, `DuplicatesSettingsPage`, `LocationInferenceSettingsPage`, with their backfill clients) in `review/ui`. The pages read their confidence floors from the admin port's settings hook (`MemoriahubSystemSettings` gains the `burst`, `dedup` and `locationInference` namespaces) and the feature flags from `core`; `core` gains `formatBytes`. The Review hub and queue pages and the review insights page stay in the app.
