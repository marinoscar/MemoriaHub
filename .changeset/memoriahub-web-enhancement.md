---
"@marinoscar/memoriahub-web": minor
---

Add the `enhancement` slice to `@marinoscar/memoriahub-web` (private): the enhancement clients, types and hooks (`useMediaEnhance`, `useEnhancements`, `useEnhancementBatch`) in `enhancement/headless`, and `MediaEnhancementDrawer`, `BatchEnhanceDialog`, `BeforeAfterSlider`, the preset module, `EnhancementsPage`, `EnhancementBatchPage` and the admin `EnhancerSettingsPage` in `enhancement/ui`. `MemoriahubSystemSettings` gains the `pictureEnhancement` namespace. `media.enhancementDrawer` and `media.batchEnhanceDialog` stay host slots, because `enhancement` imports `media`; the web app binds them to the packaged components.
