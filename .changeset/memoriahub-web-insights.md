---
"@marinoscar/memoriahub-web": minor
---

Add the `insights` slice to `@marinoscar/memoriahub-web` (private): the storage insights client and `useInsights`, `StorageInsightsPage` and the chart pieces `CompositionDonut`, `ProportionBar` and `FreshnessPill` (the `ui` entry takes `@mui/x-charts` as an optional peer). The `review` slice gains `ReviewInsightsPage`, `getReviewInsights` and `useReviewInsights` and depends on `insights`; the `media` slice gains the admin `ArchivingSettingsPage`. The core gains `formatCompactNumber`, `percent`, `bytesToNumber` and `relativeTime`, and the admin port gains `AdminBackLink` (the web app binds its own); the settings document gains the `storage` namespace (`MemoriahubStorageSettings`).
