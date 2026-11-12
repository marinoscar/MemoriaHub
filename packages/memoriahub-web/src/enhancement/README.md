# enhancement

AI picture enhancement on the web: the single-photo enhancement drawer, the bulk enhance dialog, the Enhancements hub and batch pages, the admin settings page, and the clients and hooks behind them.

## Purpose and scope

`enhancement/headless` carries the clients over the host's API client (`enhance.ts`: start, poll, apply, discard, the circle's enhancement listing, the bulk batches and their cancel, and the admin readiness status), the hooks that load them (`useMediaEnhance`, which drives one photo through request, progress and review; `useEnhancements`, which polls the hub listing; `useEnhancementBatch`) and the wire types. `enhancement/ui` carries `MediaEnhancementDrawer` (preset picker, progress, the before and after compare, keep both, replace and discard), `BatchEnhanceDialog` (one parameter set for a selection or a filter), `BeforeAfterSlider`, `ReplaceDownscaleNotice` and the preset module, the pages (`EnhancementsPage` and its tabs with `PendingEnhancementsTab` and `RecentBatchesCard`, `EnhancementBatchPage`) and the admin `EnhancerSettingsPage`.

The batch page is built on the `review-runs` slice's run progress panel, polling hook and item table, and draws its failed-items table with the host's data table. The admin page takes its page header and system-settings hook from the host's admin port (`useMemoriahubAdmin` of `core`) and stays registered in the app's admin section registry. The replace policy (`allowReplace`, `blockReplaceOnDownscale`) and the batch cap (`maxBatchSize`) come from the feature flags of `core`.

The `media` slice reaches the enhancement drawer and the bulk dialog through its host slots (`media.enhancementDrawer`, `media.batchEnhanceDialog`), which stay slots for good: this slice imports `media`, so `media` cannot import it back. The web edition binds both slots to the components here.

## Entry point

`@marinoscar/memoriahub-web/enhancement/headless` and `@marinoscar/memoriahub-web/enhancement/ui`. The slice imports `core`, `media` and `review-runs` through their entries.

## Peer dependencies

`react`, `react-dom` and the optional `@marinoscar/memoriahub-contract` (type-only: the enhancement schemas) for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, owner scope, permissions, feature flags and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
