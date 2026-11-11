---
"@marinoscar/memoriahub-web": minor
---

Move the per-user Memories preferences card (`MemoriesSettings`) and the admin Memories settings page (`MemoriesSettingsPage`, with the backfill clients `runMemoriesBackfill` and `listMemoriesBackfillLibraries`) into the `memories` slice of `@marinoscar/memoriahub-web` (private). The card picks people with the packaged `usePeople` and `PersonAvatar`, so `memories` now imports `people`. The admin port (`MemoriahubAdminPort`) gains `useAiSettings` and `getEmailReadiness`, and `MemoriahubSystemSettings` the `memories` namespace; the fake host takes `aiSettings`, `aiModels` and `emailReadiness`. The web app binds the new port members in `platform-memoriahub/admin.tsx` and keeps the card in its settings registry.
